import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FetchMock, mockFetch } from "./helpers/fetchMock";
import { mockChat, mockTranscription, OPENROUTER_HOST } from "./helpers/openrouter";
import { mockTelegram, sentTexts, telegramCalls, voiceUpdate } from "./helpers/telegram";
import { callWorker, processRequest } from "./helpers/worker";

let mock: FetchMock;
beforeEach(() => {
	mock = mockFetch();
	mockTelegram(mock);
	mockTranscription(mock, "hola");
	mockChat(mock, "ok");
});
afterEach(() => mock.restore());

describe("voice guards", () => {
	it("refuses voice notes longer than 120 seconds before downloading or transcribing", async () => {
		await callWorker(await processRequest(voiceUpdate({ duration: 121 })));
		expect(telegramCalls(mock, "getFile")).toHaveLength(0);
		expect(mock.callsTo(OPENROUTER_HOST)).toHaveLength(0);
		expect(sentTexts(mock).at(-1)).toMatch(/too long/i);
	});

	it("accepts a 120 second voice note", async () => {
		await callWorker(await processRequest(voiceUpdate({ duration: 120, chatId: 991001 })));
		expect(sentTexts(mock)).toEqual(["ok"]);
	});

	it("refuses voice files over 20 MB", async () => {
		await callWorker(await processRequest(voiceUpdate({ fileSize: 25 * 1024 * 1024 })));
		expect(telegramCalls(mock, "getFile")).toHaveLength(0);
		expect(sentTexts(mock).at(-1)).toMatch(/too large/i);
	});
});
