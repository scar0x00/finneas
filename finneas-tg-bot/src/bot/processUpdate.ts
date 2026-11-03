import type { Update } from "grammy/types";
import { isRetryable } from "../lib/errors";
import { log, logError, since } from "../lib/log";
import { newBot, registerHandlers } from "./createBot";
import { FileTooLargeError } from "./files";

const FRIENDLY_ERROR = "Sorry, something went wrong on my side. Please try again in a moment.";

/** Bot API methods that put something in front of the user. */
const SENDING_METHODS = new Set([
	"sendMessage",
	"sendPhoto",
	"sendDocument",
	"sendVoice",
	"editMessageText",
	"editMessageReplyMarkup",
	"answerCallbackQuery",
]);

/** Which handler an update will hit, for logs. */
export function handlerKind(update: Update): string {
	const m = update.message;
	if (m) {
		if (m.voice) return "voice";
		if (m.photo) return "photo";
		if (m.entities?.some((e) => e.type === "bot_command" && e.offset === 0)) return "command";
		if (m.text !== undefined) return "text";
		return "other";
	}
	if (update.callback_query) return "callback";
	return "other";
}

/** Update types the bot handles; everything else is acknowledged and dropped. */
export function isSupportedUpdate(update: Update): boolean {
	return Boolean(update?.message?.chat?.id || (update?.callback_query?.data && update.callback_query.message?.chat?.id));
}

/**
 * Runs the bot for one update.
 *
 * Retry policy: a `RetryableError` propagates (so QStash retries) only while
 * nothing has been sent to the user. After the first message, or for any other
 * error, the error is logged, the user gets one friendly message if they have
 * not received anything yet, and this resolves normally.
 */
export async function processUpdate(update: Update, env: Env): Promise<void> {
	const start = Date.now();
	const logFields = {
		update_id: update.update_id,
		chat_id: update.message?.chat.id ?? update.callback_query?.message?.chat.id,
		handler: handlerKind(update),
	};
	log("update.received", logFields);

	const bot = newBot(env);
	const state = { committed: false };

	bot.api.config.use(async (prev, method, payload, signal) => {
		const res = await prev(method, payload, signal);
		if (res.ok && SENDING_METHODS.has(method)) state.committed = true;
		return res;
	});

	bot.use(async (ctx, next) => {
		try {
			await next();
		} catch (err) {
			if (isRetryable(err) && !state.committed) throw err;
			logError("handler.failed", err, { ...logFields, committed: state.committed });
			if (!state.committed) {
				const message = err instanceof FileTooLargeError ? "That file is too large for me to download." : FRIENDLY_ERROR;
				await ctx.reply(message).catch((e) => logError("handler.error_reply_failed", e, logFields));
			}
		}
	});

	registerHandlers(bot, env);

	await bot.handleUpdate(update);
	log("update.done", { ...logFields, duration_ms: since(start) });
}
