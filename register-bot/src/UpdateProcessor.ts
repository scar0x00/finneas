import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { Bot, Context } from "grammy";
import { Agent } from "./lib/Agent";
import { SYSTEM } from "./SYSTEM_PROMPT";
import { Update } from "grammy/types";
import { arrayBufferToBase64 } from "./lib/arrayBufferToBase64";
import { extractTransactionInfo } from "./lib/extractTransactionInfo";

// bot.api.sendMessage(update?.message?.chat?.id, "Timeout ocurred!")
// await ctx.replyWithChatAction("typing");

export class UpdateProcessor extends DurableObject<Env> {
    bot: Bot;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        this.bot = new Bot(env.FINNEAS_BOT_TOKEN, {
            botInfo: JSON.parse(env.FINNEAS_BOT_INFO),
        });

        this.bot.command("version", async (ctx: Context) => {
            await ctx.reply("v0.2.27");
        });

        this.bot.command("login", async (ctx: Context) => {
            await ctx.reply("v0.2.24");
        });

        this.bot.command("new", async (ctx: Context) => {
            const chatId = ctx.chatId?.toString();
            if (!chatId) {
                await ctx.reply("No chatId on ctx");
                return;
            }
            let chatJson = await env.CHATS.delete(chatId);
            await ctx.reply("Let's start again.");
        });

        this.bot.on("message:photo", async (ctx) => {
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

            console.log(
                `Downloaded image of size: ${imageBuffer.byteLength} bytes`,
            );

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
                    `• *Bank:* ${extractedData.receiving_bank ?? "N/A"}\n` +
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
                    `• *Sender:* ${extractedData.sender_name ?? "N/A"}\n` +
                    `• *Date & Time:* ${extractedData.date ?? "N/A"} ${
                        extractedData.time ?? ""
                    }\n` +
                    `• *Ref / ID:* \`${
                        extractedData.transaction_id || "N/A"
                    }\`\n` +
                    `• *Status:* ${extractedData.status ?? "N/A"}\n\n`;

                await ctx.reply(formattedReply, { parse_mode: "Markdown" });
            } catch (err: any) {
                console.error("Workers AI error:", err);
                await ctx.reply(
                    `❌ Failed to process transaction: ${
                        err.message || "Unknown error"
                    }`,
                );
            }
        });

        this.bot.on("message:voice", async (ctx) => {
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
            const base64Audio = arrayBufferToBase64(audioBuffer);

            let transcription;
            try {
                const stt = await env.AI.run(
                    "@cf/openai/whisper-large-v3-turbo",
                    {
                        audio: base64Audio,
                        // Optional parameters:
                        // task: "transcribe", // default is "transcribe" (or "translate" to translate to English)
                        // language: "en",      // specify ISO language code or leave unset for auto-detection
                    },
                );

                console.log(JSON.stringify(stt));
                transcription = stt?.text?.trim();

                if (!transcription) {
                    await ctx.reply(
                        "Could not transcribe any speech from the voice note.",
                    );
                    return;
                }
            } catch (err) {
                console.error(err);
                await ctx.reply("Something went wrong with the transcription.");
                return;
            }

            const chatId = ctx.chatId;
            if (!chatId) {
                await ctx.reply("No chatId on ctx");
                return;
            }
            const agent = await Agent.init({
                SYSTEM,
                chatId,
                env,
            });
            const answer = await agent.run(transcription);
            if (!answer) {
                await ctx.reply("It looks the answer from the model is empty");
                return;
            }

            await ctx.reply(answer);
        });

        this.bot.on("message", async (ctx: Context) => {
            const message = ctx.message;
            if (message === undefined || message.text === undefined) {
                await ctx.reply("It looks your message is empty");
                return;
            }
            console.log(message);

            const chatId = ctx.chatId;
            if (!chatId) {
                await ctx.reply("No chatId on ctx");
                return;
            }

            const agent = await Agent.init({
                SYSTEM,
                chatId,
                env,
            });
            const answer = await agent.run(message.text);

            if (!answer) {
                await ctx.reply("It looks the answer from the model is empty");
                return;
            }

            try {
                await ctx.reply(answer);
            } catch {
                await ctx.reply("Something went wrong when responding");
            }
        });
    }

    async sayHello(): Promise<string> {
        let result = this.ctx.storage.sql
            .exec("SELECT 'Hello, World!' as greeting")
            .one();
        return result.greeting as string;
    }

    async processUpdate(update: Update) {
        this.bot.handleUpdate(update as Update)
    }
}
