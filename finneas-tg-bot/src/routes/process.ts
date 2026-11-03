import { Receiver } from "@upstash/qstash";
import type { Update } from "grammy/types";
import { isSupportedUpdate, processUpdate } from "../bot/processUpdate";
import { isRetryable } from "../lib/errors";
import { logError } from "../lib/log";
import { isAllowedSender } from "../lib/security";

/**
 * POST /process — QStash consumer. 401 on a bad signature, 503 for retryable
 * failures before any reply (QStash retries), 200 otherwise.
 */
export async function processRoute(request: Request, env: Env): Promise<Response> {
	const bodyText = await request.text();
	const receiver = new Receiver({
		currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
		nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
	});
	try {
		await receiver.verify({
			signature: request.headers.get("Upstash-Signature") ?? "",
			body: bodyText,
			url: `${new URL(request.url).origin}/process`,
		});
	} catch {
		// `verify` throws SignatureError (or a JWT error) on bad signatures.
		return new Response("Unauthorized", { status: 401 });
	}

	let update: Update;
	try {
		update = JSON.parse(bodyText) as Update;
	} catch (err) {
		logError("process.malformed", err);
		return new Response("Ignored");
	}
	if (!isAllowedSender(update, env.ALLOWED_USER_IDS) || !isSupportedUpdate(update)) {
		return new Response("Ignored");
	}

	try {
		await processUpdate(update, env);
		return new Response("Processed");
	} catch (err) {
		// Only retryable errors raised before any reply reach this point.
		logError("process.failed", err, { update_id: update.update_id, retryable: isRetryable(err) });
		return new Response("Retry later", { status: 503 });
	}
}
