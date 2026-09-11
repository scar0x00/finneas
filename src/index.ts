import { Bot, Context, webhookCallback } from "grammy";
import { arrayBufferToBase64 } from "./lib/arrayBufferToBase64";
import { parseJsonFromAnswer } from "./lib/parseJsonFromAnswer";
import { SYSTEM } from "./SYSTEM_PROMPT";
import { Agent } from "./lib/Agent";
import { Update } from "grammy/types";

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
        const bot = new Bot(env.FINNEAS_BOT_TOKEN, {
            botInfo: JSON.parse(env.FINNEAS_BOT_INFO),
        });

        bot.command("version", async (ctx: Context) => {
            await ctx.reply("v0.2.17");
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

            await ctx.replyWithChatAction("typing");

            try {
                // 1. Convert downloaded buffer into a base64 Data URI
                const base64Data = arrayBufferToBase64(imageBuffer);
                const dataUri = `data:image/jpeg;base64,${base64Data}`;

                // 2. Define schema & prompt for extraction
                const question =
                    `You are a financial receipt parser. Extract key bank transaction information from this image.
Return ONLY a valid JSON object without any additional explanation, markdown backticks, or text. 
Bear in mind that most of the transactions you'll be processing are from Venezuelan banks.
JSON format:
{
  "bank_name": "string or null",
  "amount": "number or null",
  "currency": "string or null (e.g. USD, EUR, etc.)",
  "transaction_id": "string or null",
  "reference_number": "string or null",
  "date": "string (YYYY-MM-DD) or null",
  "time": "string or null",
  "sender_name": "string or null",
  "recipient_name": "string or null",
  "status": "success | pending | failed | null"
}`;

                // 3. Call Moondream 3.1 on Cloudflare Workers AI
                const aiResponse: any = await env.AI.run(
                    "@cf/moondream/moondream3.1-9B-A2B",
                    {
                        task: "query",
                        image: dataUri,
                        question: question,
                        stream: false, // Must be false to receive a direct JSON answer
                        reasoning: false, // Set to false for concise, direct extraction
                    },
                );

                console.log(aiResponse);
                const rawAnswer = aiResponse?.result?.answer ?? "";
                const extractedData = parseJsonFromAnswer(rawAnswer);

                if (!extractedData) {
                    // Fallback in case JSON parsing failed
                    await ctx.reply(
                        `⚠️ Could not parse structured JSON. Raw model output:\n\n${rawAnswer}`,
                    );
                    return;
                }

                // 4. Format a clean message for the user
                const formattedReply =
                    `🧾 *Transaction Details Extracted:*\n\n` +
                    `• *Bank:* ${extractedData.bank_name ?? "N/A"}\n` +
                    `• *Amount:* ${extractedData.amount ?? "N/A"} ${
                        extractedData.currency ?? ""
                    }\n` +
                    `• *Recipient:* ${
                        extractedData.recipient_name ?? "N/A"
                    }\n` +
                    `• *Sender:* ${extractedData.sender_name ?? "N/A"}\n` +
                    `• *Date & Time:* ${extractedData.date ?? "N/A"} ${
                        extractedData.time ?? ""
                    }\n` +
                    `• *Ref / ID:* \`${
                        extractedData.reference_number ||
                        extractedData.transaction_id || "N/A"
                    }\`\n` +
                    `• *Status:* ${extractedData.status ?? "N/A"}\n\n` +
                    `\`\`\`json\n${
                        JSON.stringify(extractedData, null, 2)
                    }\n\`\`\``;

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

        bot.on("message", async (ctx: Context) => {
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

        if (request.method === "POST") {
            try {
                const update = await request.json();

                ctx.waitUntil(bot.handleUpdate(update as Update));
            } catch (err) {
                console.error("Error parsing update:", err);
            }
        }

        return new Response("OK", { status: 200 });
    },
};
