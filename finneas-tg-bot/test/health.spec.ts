import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FetchMock, mockFetch } from "./helpers/fetchMock";
import { mockTelegram, sentTexts, textUpdate } from "./helpers/telegram";
import { callWorker, ORIGIN, processRequest } from "./helpers/worker";

let mock: FetchMock;
beforeEach(() => {
	mock = mockFetch();
	mockTelegram(mock);
});
afterEach(() => mock.restore());

describe("GET /health", () => {
	it("returns ok and the deployed version", async () => {
		const res = await callWorker(new Request(`${ORIGIN}/health`), { VERSION: "abc1234" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok", version: "abc1234" });
	});

	it("reports 'dev' when no version was injected", async () => {
		const res = await callWorker(new Request(`${ORIGIN}/health`), { VERSION: undefined });
		expect(await res.json()).toMatchObject({ version: "dev" });
	});

	it("needs no auth and leaks no configuration", async () => {
		const res = await callWorker(new Request(`${ORIGIN}/health`));
		const text = await res.text();
		expect(text).not.toMatch(/token|secret|key/i);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("/version command", () => {
	it("replies with the deployed version", async () => {
		await callWorker(await processRequest(textUpdate("/version")), { VERSION: "deadbee" });
		expect(sentTexts(mock)).toEqual(["deadbee"]);
	});
});
