import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, logError } from "../src/lib/log";
import { type FetchMock, jsonResponse, mockFetch } from "./helpers/fetchMock";
import { CHAT_PATH, chatCompletion, mockChat, mockTranscription, OPENROUTER_HOST } from "./helpers/openrouter";
import { mockQStashPublish } from "./helpers/qstashApi";
import { mockTelegram, photoUpdate, textUpdate, voiceUpdate } from "./helpers/telegram";
import { callWorker, processRequest, webhookRequest } from "./helpers/worker";

const SECRET_TEXT = "I paid 345.67 to Maria Perez for rent";
const SECRET_ANSWER = "Noted: 345.67 Bs to Maria Perez";
const SECRET_TRANSCRIPT = "Spent eighty dollars at Farmatodo";
const RECEIPT = {
	receiving_bank: "Banesco",
	amount: "Bs. 1.234,56",
	currency: "VES",
	transaction_id: "REF998877",
	date: "2026-10-30",
	time: null,
	recipient_name: "Jose Gonzalez",
	recipient_id: "V-12345678",
	recipient_phone: "04141234567",
	sender_name: "Oscar Sender",
	status: "success",
};
const SENSITIVE = [
	SECRET_TEXT,
	"Maria Perez",
	SECRET_ANSWER,
	SECRET_TRANSCRIPT,
	"Farmatodo",
	"REF998877",
	"Jose Gonzalez",
	"V-12345678",
	"04141234567",
	"Oscar Sender",
];

let mock: FetchMock;
let lines: string[];
const methods = ["log", "info", "warn", "error", "debug"] as const;

beforeEach(() => {
	lines = [];
	for (const m of methods) {
		vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
			lines.push(
				args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(" "),
			);
		});
	}
	mock = mockFetch();
	mockTelegram(mock);
	mockQStashPublish(mock);
});
afterEach(() => {
	mock.restore();
	vi.restoreAllMocks();
});

function events(): Record<string, any>[] {
	return lines.map((l) => JSON.parse(l));
}

function expectNoSensitiveData() {
	const all = lines.join("\n");
	for (const s of SENSITIVE) expect(all).not.toContain(s);
}

describe("log helpers", () => {
	it("log() writes one JSON line with the event name and fields", () => {
		log("thing.happened", { chat_id: 1, n: 2 });
		expect(events()).toEqual([{ event: "thing.happened", chat_id: 1, n: 2 }]);
	});

	it("logError() serialises Error objects", () => {
		logError("thing.failed", new TypeError("boom"), { chat_id: 1 });
		const [e] = events();
		expect(e).toMatchObject({ event: "thing.failed", chat_id: 1, error: { name: "TypeError", message: "boom" } });
		expect(typeof e.error.stack).toBe("string");
	});

	it("logError() handles non-Error values", () => {
		logError("thing.failed", "just a string");
		expect(events()[0].error).toEqual({ value: "just a string" });
	});
});

describe("no personal data in logs", () => {
	it("text messages: every line is structured and content-free", async () => {
		mockChat(mock, SECRET_ANSWER);
		await callWorker(webhookRequest(textUpdate(SECRET_TEXT)));
		await callWorker(await processRequest(textUpdate(SECRET_TEXT)));
		expect(lines.length).toBeGreaterThan(0);
		for (const e of events()) expect(typeof e.event).toBe("string");
		expectNoSensitiveData();
	});

	it("voice messages do not log the transcription or the answer", async () => {
		mockTranscription(mock, SECRET_TRANSCRIPT);
		mockChat(mock, SECRET_ANSWER);
		await callWorker(await processRequest(voiceUpdate()));
		for (const e of events()) expect(typeof e.event).toBe("string");
		expectNoSensitiveData();
	});

	it("photos do not log extracted receipt fields", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(JSON.stringify(RECEIPT))));
		await callWorker(await processRequest(photoUpdate()));
		for (const e of events()) expect(typeof e.event).toBe("string");
		expectNoSensitiveData();
	});

	it("malformed model responses are not dumped into the logs", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({ unexpected: SECRET_ANSWER }));
		await callWorker(await processRequest(textUpdate(SECRET_TEXT)));
		expectNoSensitiveData();
	});
});

describe("structured events", () => {
	it("a text message logs received → model.call → done with standard fields", async () => {
		mockChat(mock, "hi");
		const update = textUpdate("hello", { chatId: 5151 });
		await callWorker(await processRequest(update));

		const evs = events();
		const names = evs.map((e) => e.event);
		expect(names).toContain("update.received");
		expect(names).toContain("model.call");
		expect(names).toContain("update.done");
		expect(names.indexOf("update.received")).toBeLessThan(names.indexOf("update.done"));

		const received = evs.find((e) => e.event === "update.received")!;
		expect(received).toMatchObject({ update_id: update.update_id, chat_id: 5151, handler: "text" });

		const call = evs.find((e) => e.event === "model.call")!;
		expect(call).toMatchObject({ chat_id: 5151, prompt_tokens: 10, completion_tokens: 5 });
		expect(typeof call.model).toBe("string");
		expect(typeof call.duration_ms).toBe("number");

		const done = evs.find((e) => e.event === "update.done")!;
		expect(done).toMatchObject({ update_id: update.update_id, chat_id: 5151, handler: "text" });
		expect(typeof done.duration_ms).toBe("number");
	});

	it("labels voice, photo and command handlers", async () => {
		mockTranscription(mock, "x");
		mockChat(mock, "{}");
		await callWorker(await processRequest(voiceUpdate()));
		await callWorker(await processRequest(photoUpdate()));
		await callWorker(await processRequest(textUpdate("/version")));
		const handlers = events()
			.filter((e) => e.event === "update.received")
			.map((e) => e.handler);
		expect(handlers).toEqual(["voice", "photo", "command"]);
	});

	it("does not log a free-text line per request", async () => {
		mockChat(mock, "hi");
		await callWorker(await processRequest(textUpdate("hello")));
		expect(lines.length).toBeLessThanOrEqual(5);
	});
});
