import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Update } from "grammy/types";
import worker from "../../src/index";
import { signQStash } from "./qstash";
import { TEST_BINDINGS } from "./bindings";

export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

export const ORIGIN = "https://bot.example.com";
export const PROCESS_URL = `${ORIGIN}/process`;

/** A rate limiter that never limits; the default in tests so suites can share user ids. */
export const unlimitedRateLimit = { limit: async () => ({ success: true }) };

/**
 * Calls the Worker's fetch handler and waits for everything passed to `ctx.waitUntil()`.
 * `USER_RATE_LIMIT` is replaced by `unlimitedRateLimit` unless overridden; pass
 * `{ USER_RATE_LIMIT: env.USER_RATE_LIMIT }` to exercise the real binding.
 */
export async function callWorker(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request as any, { ...(env as any), USER_RATE_LIMIT: unlimitedRateLimit, ...envOverrides }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/**
 * POST / as Telegram would send it, with the correct secret token header.
 * Pass `secret: null` to omit the header or a string to send a different value.
 */
export function webhookRequest(update: Update | string, opts: { secret?: string | null } = {}): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const secret = opts.secret === undefined ? TEST_BINDINGS.TELEGRAM_WEBHOOK_SECRET : opts.secret;
	if (secret !== null) headers[SECRET_HEADER] = secret;
	return new Request(`${ORIGIN}/`, {
		method: "POST",
		headers,
		body: typeof update === "string" ? update : JSON.stringify(update),
	});
}

/** POST /process as QStash would send it, signed for `PROCESS_URL` unless overridden. */
export async function processRequest(
	update: Update | string,
	opts: { signature?: string | null; signFor?: string; key?: string } = {},
): Promise<Request> {
	const body = typeof update === "string" ? update : JSON.stringify(update);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const signature = opts.signature === undefined ? await signQStash(body, { url: opts.signFor ?? PROCESS_URL, key: opts.key }) : opts.signature;
	if (signature !== null) headers["Upstash-Signature"] = signature;
	return new Request(PROCESS_URL, { method: "POST", headers, body });
}
