import { Update } from "grammy/types";
import { Bot, Context } from "grammy";
import { Client, Receiver } from "@upstash/qstash";
import { hasValidTelegramSecret, isAllowedSender, senderId } from "./lib/security";
import { arrayBufferToBase64 } from "./lib/arrayBufferToBase64";
import { extractTransactionInfo } from "./lib/extractTransactionInfo";
import { AgentDO } from "./lib/AgentDO";
import { transcribe } from "./lib/transcribe";
import { SYSTEM } from "./SYSTEM_PROMPT";
import { log, logError, since } from "./lib/log";

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

export interface Env {
    OPENROUTER_API_KEY: string;
    FINNEAS_BOT_INFO: string;
    FINNEAS_BOT_TOKEN: string;
    QSTASH_TOKEN: string;
    QSTASH_CURRENT_SIGNING_KEY: string;
    QSTASH_NEXT_SIGNING_KEY: string;
    AGENT_DO: DurableObjectNamespace<AgentDO>;
    /** Telegram webhook `secret_token`; requests without it are rejected. */
    TELEGRAM_WEBHOOK_SECRET: string;
    /** Comma-separated Telegram user ids allowed to use the bot. Empty = nobody. */
    ALLOWED_USER_IDS: string;
    USER_RATE_LIMIT: RateLimit;
}

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const url = new URL(request.url);

        // ==========================================
        // ROUTE 1: Receive Webhook from Telegram (/)
        // ==========================================
        if (request.method === "POST" && url.pathname === "/") {
            if (!(await hasValidTelegramSecret(request, env.TELEGRAM_WEBHOOK_SECRET))) {
                return new Response("Unauthorized", { status: 401 });
            }
            try {
                const textBody = await request.text(); // Read as text first
                const update = JSON.parse(textBody) as Update;

                // Unknown senders get a 200 so Telegram does not retry, but nothing runs.
                if (!isAllowedSender(update, env.ALLOWED_USER_IDS)) {
                    return new Response("OK", { status: 200 });
                }

                const { success } = await env.USER_RATE_LIMIT.limit({
                    key: String(senderId(update)),
                });
                if (!success) {
                    return new Response("OK", { status: 200 });
                }

                if (!update?.message?.chat?.id) {
                    return new Response("REQUEST INVALID", { status: 400 });
                }

                const bot = new Bot(env.FINNEAS_BOT_TOKEN, {
                    botInfo: JSON.parse(env.FINNEAS_BOT_INFO),
                });

                // Show "typing..." immediately for good UX
                await bot.api.sendChatAction(
                    update.message.chat.id.toString(),
                    "typing",
                );

                // Publish to QStash to hit our /process endpoint
                // Notice we construct the URL dynamically based on the current request
                const destinationUrl = `${url.origin}/process`;

                const client = new Client({
                    baseUrl: "https://qstash-us-east-1.upstash.io",
                    token: env.QSTASH_TOKEN,
                });

                await client.publishJSON({
                    url: destinationUrl,
                    body: update,
                    retries: 3,
                });

                // Return 200 OK instantly to Telegram
                return new Response("OK", { status: 200 });
            } catch (err) {
                logError("webhook.failed", err);
                return new Response("Error", { status: 500 });
            }
        }

        // ==========================================
        // ROUTE 2: Process Queue from QStash (/process)
        // ==========================================
        if (request.method === "POST" && url.pathname === "/process") {
            try {
                const signature = request.headers.get("Upstash-Signature");
                const bodyText = await request.text();

                // 1. Verify the request actually came from Upstash
                const receiver = new Receiver({
                    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
                    nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
                });

                let isValid = false;
                try {
                    isValid = await receiver.verify({
                        signature: signature || "",
                        body: bodyText,
                        url: `${url.origin}/process`,
                    });
                } catch {
                    // `verify` throws SignatureError (or a JWT error) on bad signatures.
                    isValid = false;
                }

                if (!isValid) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const update = JSON.parse(bodyText) as Update;
                if (!isAllowedSender(update, env.ALLOWED_USER_IDS)) {
                    return new Response("Ignored", { status: 200 });
                }
                const chatId = update.message?.chat?.id.toString();

                if (!chatId) return new Response("No chat ID", { status: 400 });

                const start = Date.now();
                const logFields = {
                    update_id: update.update_id,
                    chat_id: Number(chatId),
                    handler: handlerKind(update),
                };
                log("update.received", logFields);

                const bot = new Bot(env.FINNEAS_BOT_TOKEN, {
                    botInfo: JSON.parse(env.FINNEAS_BOT_INFO),
                });

                bot.command("version", async (ctx: Context) => {
                    await ctx.reply("v0.2.41");
                });

                bot.command("login", async (ctx: Context) => {
                    await ctx.reply("WIP");
                });

                bot.command("new", async (ctx: Context) => {
                    const chatId = ctx.chatId?.toString();
                    if (!chatId) {
                        await ctx.reply("No chatId on ctx");
                        return;
                    }

                    const agent = env.AGENT_DO.getByName(
                        chatId.toString(),
                    );
                    agent.clearChat();
                    await ctx.reply("Let's start again.");
                });

                bot.on("message:photo", async (ctx) => {
                    const photoArray = ctx.msg.photo;
                    const highestResPhoto = photoArray[photoArray.length - 1];

                    const file = await ctx.getFile();

                    if (!file.file_path) {
                        await ctx.reply("Could not retrieve the file path.");
                        return;
                    }

                    const fileUrl =
                        `https://api.telegram.org/file/bot${env.FINNEAS_BOT_TOKEN}/${file.file_path}`;

                    const response = await fetch(fileUrl);

                    const imageBuffer = await response.arrayBuffer();


                    await ctx.reply(
                        `Received your image!\nDimensions: ${highestResPhoto.width}x${highestResPhoto.height}\nSize: ${imageBuffer.byteLength} bytes.`,
                    );

                    await ctx.replyWithChatAction("typing");

                    try {
                        const base64Data = arrayBufferToBase64(imageBuffer);
                        const dataUri = `data:image/jpeg;base64,${base64Data}`;

                        const extractedData = await extractTransactionInfo({
                            image: dataUri,
                            env,
                            logFields: { chat_id: ctx.chatId },
                        });

                        if (!extractedData) {
                            await ctx.reply(
                                `⚠️ Could not parse structured JSON. Raw model output:\n\n${extractedData}`,
                            );
                            return;
                        }

                        // 4. Format a clean message for the user
                        const formattedReply =
                            `🧾 *Transaction Details Extracted:*\n\n` +
                            `• *Bank:* ${
                                extractedData.receiving_bank ?? "N/A"
                            }\n` +
                            `• *Amount:* ${extractedData.amount ?? "N/A"} ${
                                extractedData.currency ?? ""
                            }\n` +
                            `• *Recipient:* ${
                                extractedData.recipient_name ?? "N/A"
                            }\n` +
                            `• *Recipient ID:* ${
                                extractedData.recipient_id ?? "N/A"
                            }\n` +
                            `• *Recipient Phone:* ${
                                extractedData.recipient_phone ?? "N/A"
                            }\n` +
                            `• *Sender:* ${
                                extractedData.sender_name ?? "N/A"
                            }\n` +
                            `• *Date & Time:* ${extractedData.date ?? "N/A"} ${
                                extractedData.time ?? ""
                            }\n` +
                            `• *Ref / ID:* \`${
                                extractedData.transaction_id || "N/A"
                            }\`\n` +
                            `• *Status:* ${extractedData.status ?? "N/A"}\n\n`;

                        await ctx.reply(formattedReply, {
                            parse_mode: "Markdown",
                        });
                    } catch (err: any) {
                        logError("receipt.extract_failed", err, { chat_id: ctx.chatId });
                        await ctx.reply(
                            "❌ Sorry, I couldn't read that receipt. Please try again later.",
                        );
                    }
                });

                bot.on("message:voice", async (ctx) => {
                    const file = await ctx.getFile();

                    if (!file.file_path) {
                        await ctx.reply("Could not retrieve the file path.");
                        return;
                    }

                    const fileUrl =
                        `https://api.telegram.org/file/bot${env.FINNEAS_BOT_TOKEN}/${file.file_path}`;

                    const response = await fetch(fileUrl);
                    if (!response.ok) {
                        await ctx.reply("Failed to download voice note.");
                        return;
                    }

                    const audioBuffer = await response.arrayBuffer();

                    let stt;
                    try {
                        stt = await transcribe({
                            audio: audioBuffer,
                            env,
                            logFields: { chat_id: ctx.chatId },
                        });

                        if (!stt) {
                            await ctx.reply(
                                "Could not transcribe any speech from the voice note.",
                            );
                            return;
                        }
                    } catch (err) {
                        logError("voice.transcription_failed", err, { chat_id: ctx.chatId });
                        await ctx.reply(
                            "Something went wrong with the transcription.",
                        );
                        return;
                    }

                    const chatId = ctx.chatId;
                    if (!chatId) {
                        await ctx.reply("No chatId on ctx");
                        return;
                    }

                    const agent = env.AGENT_DO.getByName(
                        chatId.toString(),
                    );
                    await agent.init({
                        SYSTEM,
                    });

                    const answer = await agent.run(stt);
                    if (!answer) {
                        await ctx.reply(
                            "It looks the answer from the model is empty",
                        );
                        return;
                    }

                    await ctx.reply(answer);
                });

                bot.on("message", async (ctx: Context) => {
                    const message = ctx.message;
                    if (message === undefined || message.text === undefined) {
                        await ctx.reply("It looks your message is empty");
                        return;
                    }

                    const chatId = ctx.chatId;
                    if (!chatId) {
                        await ctx.reply("No chatId on ctx");
                        return;
                    }

                    const agent = env.AGENT_DO.getByName(
                        chatId.toString(),
                    );
                    await agent.init({
                        SYSTEM,
                    });
                    const answer = await agent.run(message.text);

                    if (!answer) {
                        await ctx.reply(
                            "It looks the answer from the model is empty",
                        );
                        return;
                    }

                    try {
                        await ctx.reply(answer);
                    } catch {
                        await ctx.reply("Something went wrong when responding");
                    }
                });

                await bot.handleUpdate(update);
                log("update.done", { ...logFields, duration_ms: since(start) });

                return new Response("Processed successfully", { status: 200 });
            } catch (err) {
                logError("process.failed", err);
                return new Response("Internal Server Error", { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    },
};

export { AgentDO };
