import { Client } from "@upstash/qstash";
import type { Update } from "grammy/types";
import { newBot } from "../bot/createBot";
import { isSupportedUpdate, processUpdate } from "../bot/processUpdate";
import { log, logError } from "../lib/log";
import { hasValidTelegramSecret, isAllowedSender, senderId } from "../lib/security";

/**
 * POST / — Telegram webhook. Authenticates, filters, then hands the update to
 * QStash (or processes it inline when DIRECT_PROCESSING=true in local dev).
 * Answers 200 unless authentication fails (401) or the publish fails (500).
 */
export async function telegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (!(await hasValidTelegramSecret(request, env.TELEGRAM_WEBHOOK_SECRET))) {
		return new Response("Unauthorized", { status: 401 });
	}

	let update: Update;
	try {
		update = JSON.parse(await request.text()) as Update;
	} catch (err) {
		// A retry would not fix malformed JSON, so acknowledge it.
		logError("webhook.malformed", err);
		return new Response("OK");
	}

	if (!isSupportedUpdate(update)) {
		log("update.ignored", { update_id: update?.update_id });
		return new Response("OK");
	}

	// Unknown senders get a 200 so Telegram does not retry, but nothing runs.
	if (!isAllowedSender(update, env.ALLOWED_USER_IDS)) {
		log("update.rejected", { update_id: update.update_id, reason: "not_allowed" });
		return new Response("OK");
	}

	const { success } = await env.USER_RATE_LIMIT.limit({ key: String(senderId(update)) });
	if (!success) {
		log("update.rejected", { update_id: update.update_id, reason: "rate_limited" });
		return new Response("OK");
	}

	// Typing indicator is best effort and off the critical path.
	const typing = () => {
		if (!update.message) return; // button taps are answered with answerCallbackQuery instead
		const chatId = update.message.chat.id;
		ctx.waitUntil(
			newBot(env)
				.api.sendChatAction(chatId, "typing")
				.catch(() => {}),
		);
	};

	if (env.DIRECT_PROCESSING === "true") {
		// Local dev: same processing as /process, without QStash. Errors are only logged.
		typing();
		ctx.waitUntil(
			processUpdate(update, env).catch((err) => logError("process.failed", err, { update_id: update.update_id, direct: true })),
		);
		return new Response("OK");
	}

	try {
		const client = new Client({ token: env.QSTASH_TOKEN, ...(env.QSTASH_URL ? { baseUrl: env.QSTASH_URL } : {}) });
		await client.publishJSON({
			url: `${new URL(request.url).origin}/process`,
			body: update,
			retries: 3,
			// QStash drops a second publish of the same update (Telegram redelivery).
			deduplicationId: String(update.update_id),
		});
	} catch (err) {
		// Let Telegram redeliver; the deduplication id makes that safe.
		logError("webhook.publish_failed", err, { update_id: update.update_id });
		return new Response("Error", { status: 500 });
	}

	typing();
	return new Response("OK");
}
