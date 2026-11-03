import type { Update } from "grammy/types";
import { Bot, type Context } from "grammy";
import { Client, Receiver } from "@upstash/qstash";
import { arrayBufferToBase64 } from "./lib/arrayBufferToBase64";
import { extractTransactionInfo } from "./lib/extractTransactionInfo";
import { AgentDO } from "./lib/AgentDO";
import { transcribe } from "./lib/transcribe";
import { log, logError, since } from "./lib/log";
import { hasValidTelegramSecret, isAllowedSender, senderId } from "./lib/security";
import { isRetryable, isRetryableStatus, RetryableError } from "./lib/errors";
import { sendLongMessage } from "./lib/telegram";
import { formatReceiptHtml } from "./lib/receipt";

export interface Env {
	OPENROUTER_API_KEY: string;
	FINNEAS_BOT_INFO: string;
	FINNEAS_BOT_TOKEN: string;
	QSTASH_TOKEN: string;
	QSTASH_CURRENT_SIGNING_KEY: string;
	QSTASH_NEXT_SIGNING_KEY: string;
	/** QStash API base URL (regional endpoint or local dev server). Falls back to the SDK default. */
	QSTASH_URL?: string;
	AGENT_DO: DurableObjectNamespace<AgentDO>;
	/** Telegram webhook `secret_token`; requests without it are rejected. */
	TELEGRAM_WEBHOOK_SECRET: string;
	/** Comma-separated Telegram user ids allowed to use the bot. Empty = nobody. */
	ALLOWED_USER_IDS: string;
	USER_RATE_LIMIT: RateLimit;
	/** OpenRouter model for the chat agent. */
	CHAT_MODEL?: string;
	/** How many stored messages (plus the system prompt) are sent to the model. */
	MAX_CONTEXT_MESSAGES?: string;
}

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
function isSupportedUpdate(update: Update): boolean {
	return Boolean(update?.message?.chat?.id);
}

function newBot(env: Env): Bot {
	return new Bot(env.FINNEAS_BOT_TOKEN, { botInfo: JSON.parse(env.FINNEAS_BOT_INFO) });
}

// ==========================================
// POST /  — Telegram webhook
// ==========================================
async function telegramWebhook(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
	if (!(await hasValidTelegramSecret(request, env.TELEGRAM_WEBHOOK_SECRET))) {
		return new Response("Unauthorized", { status: 401 });
	}

	let update: Update;
	try {
		update = JSON.parse(await request.text()) as Update;
	} catch (err) {
		// A retry would not fix malformed JSON, so acknowledge it.
		logError("webhook.malformed", err);
		return new Response("OK", { status: 200 });
	}

	if (!isSupportedUpdate(update)) {
		log("update.ignored", { update_id: update?.update_id });
		return new Response("OK", { status: 200 });
	}

	// Unknown senders get a 200 so Telegram does not retry, but nothing runs.
	if (!isAllowedSender(update, env.ALLOWED_USER_IDS)) {
		log("update.rejected", { update_id: update.update_id, reason: "not_allowed" });
		return new Response("OK", { status: 200 });
	}

	const { success } = await env.USER_RATE_LIMIT.limit({ key: String(senderId(update)) });
	if (!success) {
		log("update.rejected", { update_id: update.update_id, reason: "rate_limited" });
		return new Response("OK", { status: 200 });
	}

	try {
		const client = new Client({ token: env.QSTASH_TOKEN, ...(env.QSTASH_URL ? { baseUrl: env.QSTASH_URL } : {}) });
		await client.publishJSON({
			url: `${origin}/process`,
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

	// Typing indicator is best effort and off the critical path.
	const chatId = update.message!.chat.id;
	ctx.waitUntil(
		newBot(env)
			.api.sendChatAction(chatId, "typing")
			.catch(() => {}),
	);

	return new Response("OK", { status: 200 });
}

// ==========================================
// POST /process — QStash consumer
// ==========================================
async function processRoute(request: Request, env: Env, origin: string): Promise<Response> {
	const signature = request.headers.get("Upstash-Signature");
	const bodyText = await request.text();

	const receiver = new Receiver({
		currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
		nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
	});
	let isValid = false;
	try {
		isValid = await receiver.verify({ signature: signature || "", body: bodyText, url: `${origin}/process` });
	} catch {
		// `verify` throws SignatureError (or a JWT error) on bad signatures.
		isValid = false;
	}
	if (!isValid) {
		return new Response("Unauthorized", { status: 401 });
	}

	let update: Update;
	try {
		update = JSON.parse(bodyText) as Update;
	} catch (err) {
		logError("process.malformed", err);
		return new Response("Ignored", { status: 200 });
	}
	if (!isAllowedSender(update, env.ALLOWED_USER_IDS) || !isSupportedUpdate(update)) {
		return new Response("Ignored", { status: 200 });
	}

	try {
		await processUpdate(update, env);
		return new Response("Processed", { status: 200 });
	} catch (err) {
		// Only retryable errors raised before any reply reach this point.
		logError("process.failed", err, { update_id: update.update_id, retryable: isRetryable(err) });
		return new Response("Retry later", { status: 503 });
	}
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
		chat_id: update.message?.chat.id,
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
				await ctx.reply(FRIENDLY_ERROR).catch((e) => logError("handler.error_reply_failed", e, logFields));
			}
		}
	});

	registerHandlers(bot, env);

	await bot.handleUpdate(update);
	log("update.done", { ...logFields, duration_ms: since(start) });
}

/** Downloads a file Telegram is hosting for this bot. */
async function downloadTelegramFile(ctx: Context, env: Env): Promise<ArrayBuffer | null> {
	const file = await ctx.getFile();
	if (!file.file_path) return null;
	const response = await fetch(`https://api.telegram.org/file/bot${env.FINNEAS_BOT_TOKEN}/${file.file_path}`);
	if (!response.ok) {
		if (isRetryableStatus(response.status)) throw new RetryableError(`Telegram file download failed with status ${response.status}`);
		return null;
	}
	return response.arrayBuffer();
}

/**
 * Sends `text` to the chat's agent and replies with its answer. Shared by text and voice.
 * A redelivered update does not call the model again; its stored answer is re-sent only
 * if it never reached the user.
 */
async function answerWithAgent(ctx: Context, env: Env, text: string, source: "text" | "voice"): Promise<void> {
	const chatId = ctx.chatId!;
	const updateId = ctx.update.update_id;
	const agent = env.AGENT_DO.getByName(chatId.toString());
	const result = await agent.chat({ updateId, text, source });
	if (result.duplicate) {
		log("update.duplicate", { update_id: updateId, chat_id: chatId, replied: result.replied });
		if (result.replied) return;
	}
	await sendLongMessage(ctx.api, chatId, result.answer);
	await agent.markReplied(updateId);
}

function registerHandlers(bot: Bot, env: Env): void {
	bot.command("version", async (ctx) => {
		await ctx.reply("v0.2.41");
	});

	bot.command("login", async (ctx) => {
		await ctx.reply("WIP");
	});

	bot.command("new", async (ctx) => {
		const agent = env.AGENT_DO.getByName(ctx.chatId.toString());
		await agent.clearChat();
		await ctx.reply("Let's start again.");
	});

	bot.on("message:photo", async (ctx) => {
		await ctx.replyWithChatAction("typing").catch(() => {});
		const imageBuffer = await downloadTelegramFile(ctx, env);
		if (!imageBuffer) {
			await ctx.reply("I couldn't download that image. Please send it again.");
			return;
		}

		const dataUri = `data:image/jpeg;base64,${arrayBufferToBase64(imageBuffer)}`;
		const extractedData = await extractTransactionInfo({
			image: dataUri,
			env,
			logFields: { chat_id: ctx.chatId },
		});

		if (!extractedData) {
			log("receipt.unparseable", { chat_id: ctx.chatId });
			await ctx.reply("⚠️ I couldn't read the transaction details from that image. Try a clearer screenshot of the receipt.");
			return;
		}

		await ctx.reply(formatReceiptHtml(extractedData), { parse_mode: "HTML" });
	});

	bot.on("message:voice", async (ctx) => {
		await ctx.replyWithChatAction("typing").catch(() => {});
		const audioBuffer = await downloadTelegramFile(ctx, env);
		if (!audioBuffer) {
			await ctx.reply("Failed to download voice note.");
			return;
		}

		const stt = await transcribe({ audio: audioBuffer, env, logFields: { chat_id: ctx.chatId } });
		if (!stt) {
			await ctx.reply("Could not transcribe any speech from the voice note.");
			return;
		}

		await answerWithAgent(ctx, env, stt, "voice");
	});

	bot.on("message:text", async (ctx) => {
		await answerWithAgent(ctx, env, ctx.message.text, "text");
	});

	bot.on("message", async (ctx) => {
		await ctx.reply("I can read text, voice notes and receipt photos.");
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/") {
			return telegramWebhook(request, env, ctx, url.origin);
		}
		if (request.method === "POST" && url.pathname === "/process") {
			return processRoute(request, env, url.origin);
		}
		return new Response("Not Found", { status: 404 });
	},
};

export { AgentDO };
