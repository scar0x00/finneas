import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_UPDATES, buildWebhookRequest, formatWebhookInfo, parseWebhookArgs } from "../scripts/webhook-lib";
import { type FetchMock, jsonResponse, mockFetch } from "./helpers/fetchMock";
import { chatCalls, mockChat } from "./helpers/openrouter";
import { mockQStashPublish, publishCalls } from "./helpers/qstashApi";
import { mockTelegram, sentTexts, telegramCalls, textUpdate } from "./helpers/telegram";
import { callWorker, webhookRequest } from "./helpers/worker";

let mock: FetchMock;
beforeEach(() => {
	mock = mockFetch();
	mockTelegram(mock);
	mockQStashPublish(mock);
	mockChat(mock, "inline answer");
});
afterEach(() => mock.restore());

describe("DIRECT_PROCESSING", () => {
	it("processes the update inline and skips QStash when set to true", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hello", { chatId: 990001 })), { DIRECT_PROCESSING: "true" });
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(0);
		expect(chatCalls(mock)).toHaveLength(1);
		expect(sentTexts(mock)).toEqual(["inline answer"]);
	});

	it("still enforces the secret and the allowlist", async () => {
		const res = await callWorker(webhookRequest(textUpdate("hello"), { secret: null }), { DIRECT_PROCESSING: "true" });
		expect(res.status).toBe(401);
		await callWorker(webhookRequest(textUpdate("hello", { userId: 666 })), { DIRECT_PROCESSING: "true" });
		expect(chatCalls(mock)).toHaveLength(0);
	});

	it("answers Telegram 200 even when processing fails", async () => {
		mock.on("openrouter.ai", "/api/v1/chat/completions", () => jsonResponse({}, 503));
		const res = await callWorker(webhookRequest(textUpdate("hello", { chatId: 990002 })), { DIRECT_PROCESSING: "true" });
		expect(res.status).toBe(200);
	});

	it("uses QStash for any other value", async () => {
		await callWorker(webhookRequest(textUpdate("hello")), { DIRECT_PROCESSING: "false" });
		expect(publishCalls(mock)).toHaveLength(1);
		expect(chatCalls(mock)).toHaveLength(0);
	});

	it("sends the typing action in both modes", async () => {
		await callWorker(webhookRequest(textUpdate("hello", { chatId: 990003 })), { DIRECT_PROCESSING: "true" });
		expect(telegramCalls(mock, "sendChatAction").length).toBeGreaterThan(0);
	});
});

describe("webhook script", () => {
	const env = { FINNEAS_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "s3cret" };

	it("parses subcommands and flags", () => {
		expect(parseWebhookArgs(["set", "--url", "https://x.trycloudflare.com"])).toEqual({
			command: "set",
			url: "https://x.trycloudflare.com",
			dropPending: false,
		});
		expect(parseWebhookArgs(["set", "--url=https://x", "--drop-pending-updates"])).toEqual({
			command: "set",
			url: "https://x",
			dropPending: true,
		});
		expect(parseWebhookArgs(["info"])).toEqual({ command: "info", dropPending: false });
		expect(parseWebhookArgs(["delete", "--drop-pending-updates"])).toEqual({ command: "delete", dropPending: true });
	});

	it("rejects unknown commands and set without --url", () => {
		expect(() => parseWebhookArgs(["nope"])).toThrow(/usage/i);
		expect(() => parseWebhookArgs([])).toThrow(/usage/i);
		expect(() => parseWebhookArgs(["set"])).toThrow(/--url/);
	});

	it("builds setWebhook with the secret, allowed updates and drop_pending_updates", () => {
		const req = buildWebhookRequest({ command: "set", url: "https://x.example", dropPending: true }, env);
		expect(req.url).toBe("https://api.telegram.org/bot123:abc/setWebhook");
		expect(req.body).toEqual({
			url: "https://x.example/",
			secret_token: "s3cret",
			allowed_updates: ALLOWED_UPDATES,
			drop_pending_updates: true,
		});
		expect(ALLOWED_UPDATES).toEqual(["message", "callback_query"]);
	});

	it("refuses to set a webhook without a secret or a token", () => {
		expect(() => buildWebhookRequest({ command: "set", url: "https://x", dropPending: false }, { FINNEAS_BOT_TOKEN: "1:a" })).toThrow(
			/TELEGRAM_WEBHOOK_SECRET/,
		);
		expect(() => buildWebhookRequest({ command: "info", dropPending: false }, {})).toThrow(/FINNEAS_BOT_TOKEN/);
	});

	it("refuses non-https webhook URLs", () => {
		expect(() => buildWebhookRequest({ command: "set", url: "http://localhost:8787", dropPending: false }, env)).toThrow(/https/);
	});

	it("builds getWebhookInfo and deleteWebhook", () => {
		expect(buildWebhookRequest({ command: "info", dropPending: false }, env)).toEqual({
			url: "https://api.telegram.org/bot123:abc/getWebhookInfo",
			body: {},
		});
		expect(buildWebhookRequest({ command: "delete", dropPending: true }, env)).toEqual({
			url: "https://api.telegram.org/bot123:abc/deleteWebhook",
			body: { drop_pending_updates: true },
		});
	});

	it("formats webhook info with url, pending count and last error", () => {
		const text = formatWebhookInfo({
			url: "https://x.example/",
			pending_update_count: 3,
			last_error_date: 1_700_000_000,
			last_error_message: "Wrong response from the webhook: 401 Unauthorized",
			allowed_updates: ["message"],
		});
		expect(text).toContain("https://x.example/");
		expect(text).toContain("Pending updates: 3");
		expect(text).toContain("401 Unauthorized");
		expect(text).toContain("2023-11-14");
		expect(formatWebhookInfo({ url: "", pending_update_count: 0 })).toContain("(not set)");
	});
});
