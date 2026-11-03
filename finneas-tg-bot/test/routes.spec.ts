import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch, type FetchMock } from "./helpers/fetchMock";
import { mockTelegram, sentTexts, telegramCalls, textUpdate } from "./helpers/telegram";
import { mockQStashPublish, publishCalls, publishDestination } from "./helpers/qstashApi";
import { chatCalls, mockChat } from "./helpers/openrouter";
import { callWorker, ORIGIN, processRequest, PROCESS_URL, webhookRequest } from "./helpers/worker";

let mock: FetchMock;
beforeEach(() => {
	mock = mockFetch();
	mockTelegram(mock);
	mockQStashPublish(mock);
});
afterEach(() => mock.restore());

describe("routing", () => {
	it("returns 404 for GET /", async () => {
		const res = await callWorker(new Request(`${ORIGIN}/`));
		expect(res.status).toBe(404);
	});

	it("returns 404 for unknown paths", async () => {
		const res = await callWorker(new Request(`${ORIGIN}/nope`, { method: "POST", body: "{}" }));
		expect(res.status).toBe(404);
	});
});

describe("POST / (Telegram webhook)", () => {
	it("publishes a valid text update to <origin>/process and answers 200", async () => {
		const update = textUpdate("hello");
		const res = await callWorker(webhookRequest(update));

		expect(res.status).toBe(200);
		const publishes = publishCalls(mock);
		expect(publishes).toHaveLength(1);
		expect(publishDestination(publishes[0])).toBe(PROCESS_URL);
		expect(publishes[0].json()).toEqual(update);
	});

	it("makes no OpenRouter call", async () => {
		await callWorker(webhookRequest(textUpdate("hello")));
		expect(chatCalls(mock)).toHaveLength(0);
	});
});

describe("POST /process (QStash consumer)", () => {
	it("sends a text message to the model and replies in the same chat", async () => {
		mockChat(mock, "Hi! How can I help?");
		const update = textUpdate("hello", { chatId: 4242, userId: 1001 });

		const res = await callWorker(await processRequest(update));

		expect(res.status).toBe(200);
		expect(chatCalls(mock)).toHaveLength(1);
		const sends = telegramCalls(mock, "sendMessage");
		expect(sends).toHaveLength(1);
		expect(sends[0].json().chat_id).toBe(4242);
		expect(sentTexts(mock)).toEqual(["Hi! How can I help?"]);
	});
});
