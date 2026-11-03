import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch, jsonResponse, type FetchMock } from "./helpers/fetchMock";
import { callbackQueryUpdate, mockTelegram, photoUpdate, sentTexts, STRANGER_USER_ID, textUpdate } from "./helpers/telegram";
import { mockQStashPublish, publishCalls } from "./helpers/qstashApi";
import { chatCalls, CHAT_PATH, mockChat, OPENROUTER_HOST } from "./helpers/openrouter";
import { callWorker, ORIGIN, processRequest, webhookRequest } from "./helpers/worker";
import { signQStash } from "./helpers/qstash";

let mock: FetchMock;
beforeEach(() => {
	mock = mockFetch();
	mockTelegram(mock);
	mockQStashPublish(mock);
	mockChat(mock, "ok");
});
afterEach(() => mock.restore());

describe("Telegram webhook secret", () => {
	it("rejects a request without the secret header with 401 and publishes nothing", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hi"), { secret: null }));
		expect(res.status).toBe(401);
		expect(publishCalls(mock)).toHaveLength(0);
		expect(mock.calls).toHaveLength(0);
	});

	it("rejects a wrong secret with 401", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hi"), { secret: "wrong" }));
		expect(res.status).toBe(401);
		expect(publishCalls(mock)).toHaveLength(0);
	});

	it("rejects a secret that only shares a prefix with the real one", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hi"), { secret: "test_webhook_secret" }));
		expect(res.status).toBe(401);
	});

	it("rejects everything when the secret is not configured", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hi"), { secret: "" }), { TELEGRAM_WEBHOOK_SECRET: "" });
		expect(res.status).toBe(401);
	});

	it("accepts the correct secret", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hi")));
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(1);
	});
});

describe("user allowlist", () => {
	it("drops updates from users not on the list with 200 and no side effects", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hi", { userId: STRANGER_USER_ID })));
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(0);
		expect(chatCalls(mock)).toHaveLength(0);
	});

	it("accepts every user on a comma-separated list", async () => {
		await callWorker(webhookRequest(textUpdate("hi", { userId: 1001 })));
		await callWorker(webhookRequest(textUpdate("hi", { userId: 1002 })));
		expect(publishCalls(mock)).toHaveLength(2);
	});

	it("allows nobody when the list is empty", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hi")), { ALLOWED_USER_IDS: "" });
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(0);
	});

	it("checks the sender of callback queries too", async () => {
		await callWorker(webhookRequest(callbackQueryUpdate("x", { userId: STRANGER_USER_ID })));
		expect(publishCalls(mock)).toHaveLength(0);
	});

	it("re-checks the allowlist in /process (defence in depth)", async () => {
		const res = await callWorker(await processRequest(textUpdate("hi", { userId: STRANGER_USER_ID })));
		expect(res.status).toBe(200);
		expect(chatCalls(mock)).toHaveLength(0);
		expect(sentTexts(mock)).toHaveLength(0);
	});
});

describe("QStash signature on /process", () => {
	it("returns 401 when the signature is missing", async () => {
		const res = await callWorker(await processRequest(textUpdate("hi"), { signature: null }));
		expect(res.status).toBe(401);
		expect(chatCalls(mock)).toHaveLength(0);
	});

	it("returns 401 for garbage signatures", async () => {
		const res = await callWorker(await processRequest(textUpdate("hi"), { signature: "not.a.jwt" }));
		expect(res.status).toBe(401);
	});

	it("returns 401 for a signature made with the wrong key", async () => {
		const res = await callWorker(await processRequest(textUpdate("hi"), { key: "some-other-key" }));
		expect(res.status).toBe(401);
	});

	it("returns 401 for a message signed for a different destination", async () => {
		const res = await callWorker(await processRequest(textUpdate("hi"), { signFor: "https://evil.example.com/process" }));
		expect(res.status).toBe(401);
		expect(chatCalls(mock)).toHaveLength(0);
	});

	it("returns 401 when the body does not match the signed hash", async () => {
		const signature = await signQStash(JSON.stringify(textUpdate("original")), { url: `${ORIGIN}/process` });
		const res = await callWorker(await processRequest(textUpdate("tampered"), { signature }));
		expect(res.status).toBe(401);
	});

	it("accepts the next signing key during key rotation", async () => {
		const res = await callWorker(await processRequest(textUpdate("hi"), { key: "sig_test_next_key" }));
		expect(res.status).toBe(200);
	});
});

describe("per-user rate limit", () => {
	it("drops messages beyond 20 per minute from one user", async () => {
		const userId = 1003;
		const overrides = { USER_RATE_LIMIT: (env as any).USER_RATE_LIMIT, ALLOWED_USER_IDS: "1003" };
		const statuses: number[] = [];
		for (let i = 0; i < 25; i++) {
			statuses.push((await callWorker(webhookRequest(textUpdate(`m${i}`, { userId })), overrides)).status);
		}
		expect(statuses.every((s) => s === 200)).toBe(true);
		expect(publishCalls(mock)).toHaveLength(20);
	});
});

describe("error messages", () => {
	it("never echoes internal error details to the chat", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({ error: { message: "secret internal detail" } }, 500));
		await callWorker(await processRequest(photoUpdate()));
		const texts = sentTexts(mock).join("\n");
		expect(texts).not.toContain("secret internal detail");
		expect(texts).not.toMatch(/status 500/);
	});
});
