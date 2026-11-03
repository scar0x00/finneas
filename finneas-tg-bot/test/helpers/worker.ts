import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Update } from "grammy/types";
import worker from "../../src/index";
import { signQStash } from "./qstash";

export const ORIGIN = "https://bot.example.com";
export const PROCESS_URL = `${ORIGIN}/process`;

/** Calls the Worker's fetch handler and waits for everything passed to `ctx.waitUntil()`. */
export async function callWorker(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request as any, { ...(env as any), ...envOverrides }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** POST / as Telegram would send it. */
export function webhookRequest(update: Update | string, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
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
