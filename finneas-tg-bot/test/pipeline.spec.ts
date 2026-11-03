import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch, jsonResponse, type FetchMock } from "./helpers/fetchMock";
import { editedMessageUpdate, mockTelegram, photoUpdate, sentTexts, telegramCalls, textUpdate, voiceUpdate } from "./helpers/telegram";
import { mockQStashPublish, publishCalls } from "./helpers/qstashApi";
import { chatCalls, chatCompletion, CHAT_PATH, mockChat, OPENROUTER_HOST, STT_PATH } from "./helpers/openrouter";
import { callWorker, processRequest, webhookRequest } from "./helpers/worker";

let mock: FetchMock;
beforeEach(() => {
	mock = mockFetch();
	mockTelegram(mock);
	mockQStashPublish(mock);
});
afterEach(() => mock.restore());

describe("POST / answers Telegram with 200 unless auth fails", () => {
	it("ignores edited messages with 200 and publishes nothing", async () => {
		const res = await callWorker(webhookRequest(editedMessageUpdate("fixed typo")));
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(0);
	});

	it("answers 200 to malformed JSON (a retry would not fix it)", async () => {
		const res = await callWorker(webhookRequest("{not json"));
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(0);
	});

	it("still publishes when sendChatAction fails", async () => {
		mock.on("api.telegram.org", /sendChatAction$/, () => jsonResponse({ ok: false, error_code: 502, description: "Bad Gateway" }, 502));
		const res = await callWorker(webhookRequest(textUpdate("hi")));
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(1);
	});

	it("publishes before the typing action is sent", async () => {
		await callWorker(webhookRequest(textUpdate("hi")));
		const order = mock.calls.map((c) => (c.url.host.includes("qstash") ? "publish" : c.url.pathname.split("/").pop()));
		expect(order.indexOf("publish")).toBeLessThan(order.indexOf("sendChatAction"));
	});

	it("deduplicates QStash publishes by update_id", async () => {
		const update = textUpdate("hi");
		await callWorker(webhookRequest(update));
		const [publish] = publishCalls(mock);
		expect(publish.headers.get("Upstash-Deduplication-Id")).toBe(String(update.update_id));
	});

	it("returns 500 (so Telegram retries) when QStash is down", async () => {
		mock.on("qstash-us-east-1.upstash.io", /\/v2\/publish\//, () => jsonResponse({ error: "down" }, 503));
		const res = await callWorker(webhookRequest(textUpdate("hi")));
		expect(res.status).toBe(500);
	});

	it("uses QSTASH_URL when set", async () => {
		mock.on("qstash.local.test", /\/v2\/publish\//, () => jsonResponse({ messageId: "m" }));
		await callWorker(webhookRequest(textUpdate("hi")), { QSTASH_URL: "https://qstash.local.test" });
		expect(mock.callsTo("qstash.local.test")).toHaveLength(1);
	});
});

describe("/process retry policy", () => {
	it("an OpenRouter 503 makes /process fail so QStash retries, and the retry replies exactly once", async () => {
		mockChat(mock, "the answer");
		// Registered last, so it answers first; then falls through to mockChat.
		mock.once(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({ error: { message: "overloaded" } }, 503));
		const update = textUpdate("hello");

		const first = await callWorker(await processRequest(update));
		expect(first.status).toBeGreaterThanOrEqual(500);
		expect(sentTexts(mock)).toEqual([]);

		const second = await callWorker(await processRequest(update));
		expect(second.status).toBe(200);
		expect(sentTexts(mock)).toEqual(["the answer"]);
	});

	it("an OpenRouter 429 is retryable too", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({ error: { message: "slow down" } }, 429));
		const res = await callWorker(await processRequest(textUpdate("hello")));
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(sentTexts(mock)).toEqual([]);
	});

	it("a non-retryable error (OpenRouter 400) replies with a friendly message and returns 200", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({ error: { message: "bad request" } }, 400));
		const res = await callWorker(await processRequest(textUpdate("hello")));
		expect(res.status).toBe(200);
		const texts = sentTexts(mock);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toMatch(/sorry/i);
	});

	it("a null model answer is not sent as a message; the user gets a friendly error", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(null)));
		const res = await callWorker(await processRequest(textUpdate("hello")));
		expect(res.status).toBe(200);
		const texts = sentTexts(mock);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toMatch(/sorry/i);
	});

	it("an error after the reply was sent returns 200 and sends no second message", async () => {
		mockChat(mock, "the answer");
		// The first sendMessage (the answer) succeeds, anything after it fails.
		let sends = 0;
		mock.on("api.telegram.org", /sendMessage$/, (call) => {
			sends++;
			if (sends === 1) return jsonResponse({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: call.json().text } });
			return jsonResponse({ ok: false, error_code: 500, description: "boom" }, 500);
		});
		const long = "x".repeat(5000); // forces a second sendMessage chunk, which fails
		mockChat(mock, long);
		const res = await callWorker(await processRequest(textUpdate("hello")));
		expect(res.status).toBe(200);
		expect(sends).toBe(2); // the answer's two chunks; no extra error message attempted
	});

	it("passes a timeout signal to OpenRouter", async () => {
		mockChat(mock, "ok");
		const seen: (AbortSignal | undefined | null)[] = [];
		mock.spy.mockImplementationOnce;
		const original = mock.spy.getMockImplementation()!;
		mock.spy.mockImplementation(async (input: any, init?: any) => {
			if (String(input instanceof Request ? input.url : input).includes(OPENROUTER_HOST)) seen.push(init?.signal ?? (input as Request).signal);
			return original(input, init);
		});
		await callWorker(await processRequest(textUpdate("hello")));
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((s) => s instanceof AbortSignal)).toBe(true);
	});

	it("transcription failures with 5xx are retryable", async () => {
		mock.on(OPENROUTER_HOST, STT_PATH, () => jsonResponse({ error: "down" }, 502));
		const res = await callWorker(await processRequest(voiceUpdate()));
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(sentTexts(mock)).toEqual([]);
	});
});

describe("Telegram output", () => {
	it("splits a 6,000-character answer into two messages", async () => {
		const para = "a".repeat(2999);
		const answer = `${para}\n\n${para}`;
		mockChat(mock, answer);
		await callWorker(await processRequest(textUpdate("long please")));
		const texts = sentTexts(mock);
		expect(texts).toHaveLength(2);
		expect(texts.every((t) => t.length <= 4096)).toBe(true);
		expect(texts.join("")).toBe(`${para}${para}`);
	});

	it("renders a receipt whose recipient name contains _ * and backticks with HTML parse mode", async () => {
		const receipt = { amount: 25, currency: "USD", recipient_name: "Ana_Maria *Lopez* `x` <b>", transaction_id: "REF_1" };
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(JSON.stringify(receipt))));
		const res = await callWorker(await processRequest(photoUpdate()));
		expect(res.status).toBe(200);
		const sends = telegramCalls(mock, "sendMessage").map((c) => c.json());
		const receiptMsg = sends.find((m) => m.text.includes("Ana_Maria"));
		expect(receiptMsg).toBeDefined();
		expect(receiptMsg.parse_mode).toBe("HTML");
		expect(receiptMsg.text).toContain("Ana_Maria *Lopez* `x` &lt;b&gt;");
	});

	it("tells the user when the receipt JSON cannot be parsed", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("I could not read this")));
		const res = await callWorker(await processRequest(photoUpdate()));
		expect(res.status).toBe(200);
		expect(sentTexts(mock).at(-1)).toMatch(/couldn.t read/i);
	});
});

describe("/new", () => {
	it("awaits clearing the chat before confirming", async () => {
		mockChat(mock, "first answer");
		const chatId = 777001;
		await callWorker(await processRequest(textUpdate("remember me", { chatId })));
		await callWorker(await processRequest(textUpdate("/new", { chatId })));
		await callWorker(await processRequest(textUpdate("again", { chatId })));
		const last = chatCalls(mock).at(-1)!.json().messages.map((m: any) => m.content);
		expect(last).not.toContain("remember me");
	});
});
