import { Bot, Context, webhookCallback } from "grammy";
import { arrayBufferToBase64 } from "./arrayBufferToBase64";
import { SYSTEM } from "./SYSTEM_PROMPT";
import type { ChatHistory } from "./types/Chat";

export interface Env {
    // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
    // MY_DURABLE_OBJECT: DurableObjectNamespace;
    // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
    // MY_BUCKET: R2Bucket;
    FINNEAS_BOT_INFO: string;
    FINNEAS_BOT_TOKEN: string;
    AI: Ai;
    CHATS: KVNamespace;
}

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        console.log("This is a test message!");
        const bot = new Bot(env.FINNEAS_BOT_TOKEN, {
            botInfo: JSON.parse(env.FINNEAS_BOT_INFO),
        });

        bot.command("version", async (ctx: Context) => {
            await ctx.reply("v0.2.11");
        });

        bot.command("new", async (ctx: Context) => {
            const chatId = ctx.chatId?.toString();
            if (!chatId) {
                await ctx.reply("No chatId on ctx");
                return;
            }
            let chatJson = await env.CHATS.delete(chatId);
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

            console.log(
                `Downloaded image of size: ${imageBuffer.byteLength} bytes`,
            );

            await ctx.reply(
                `Received your image!\nDimensions: ${highestResPhoto.width}x${highestResPhoto.height}\nSize: ${imageBuffer.byteLength} bytes.`,
            );
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
            const base64Audio = arrayBufferToBase64(audioBuffer);

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
                const transcription = stt?.text?.trim();

                if (!transcription) {
                    await ctx.reply(
                        "Could not transcribe any speech from the voice note.",
                    );
                    return;
                }

                await ctx.reply(
                    `Received your voice note: \n\n${transcription}`,
                );
            } catch (err) {
                console.error(err);
                await ctx.reply("Something went wrong with the transcription.");
            }
        });

        bot.on("message", async (ctx: Context) => {
            const message = ctx.message;
            if (message === undefined || message.text === undefined) {
                await ctx.reply("It looks your message is empty!");
                return;
            }
            console.log(message);

            const chatId = ctx.chatId?.toString();
            if (!chatId) {
                await ctx.reply("No chatId on ctx");
                return;
            }

            let chatJson = await env.CHATS.get(chatId);
            let history: ChatHistory;
            if (chatJson === null) {
                history = [
                    {
                        role: "system",
                        content: SYSTEM,
                    },
                ];
            } else {
                history = JSON.parse(chatJson) as ChatHistory;
            }

            const messages: ChatHistory = [
                ...history,
                {
                    role: "user",
                    content: message.text,
                },
            ];
            const response = await env.AI.run("@cf/zai-org/glm-5.3-flash", {
                messages: messages,
                chat_template_kwargs: {
                    enable_thinking: true,
                },
            });

            console.log(response);
            const answer = response.choices[0].message.content;
            if (!answer) {
                await ctx.reply("It looks the answer from the model is empty!");
                return;
            }
            await env.CHATS.put(
                chatId,
                JSON.stringify([
                    ...messages,
                    {
                        role: "assistant",
                        content: answer,
                    },
                ]),
            );

            await ctx.reply(answer);
        });

        return webhookCallback(bot, "cloudflare-mod", {
            timeoutMilliseconds: 40000,
        })(request);
    },
};
