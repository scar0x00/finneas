import { Update } from "grammy/types";
import { Bot, Context } from "grammy";
import { Client, Receiver } from "@upstash/qstash";
import { arrayBufferToBase64 } from "./lib/arrayBufferToBase64";
import { extractTransactionInfo } from "./lib/extractTransactionInfo";
import { AgentDO } from "./lib/AgentDO";
import { transcribe } from "./lib/transcribe";
import { SYSTEM } from "./SYSTEM_PROMPT";

export interface Env {
    OPENROUTER_API_KEY: string;
    FINNEAS_BOT_INFO: string;
    FINNEAS_BOT_TOKEN: string;
    AI: Ai;
    QSTASH_TOKEN: string;
    QSTASH_CURRENT_SIGNING_KEY: string;
    QSTASH_NEXT_SIGNING_KEY: string;
    AGENT_DO: DurableObjectNamespace<AgentDO>;
}

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const url = new URL(request.url);
        console.log(new Date(), "--- FETCH HIT ---", url);

        // ==========================================
        // ROUTE 1: Receive Webhook from Telegram (/)
        // ==========================================
        if (request.method === "POST" && url.pathname === "/") {
            try {
                const textBody = await request.text(); // Read as text first
                const update = JSON.parse(textBody) as Update;

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
                console.error("Error receiving from Telegram:", err);
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

                const isValid = await receiver.verify({
                    signature: signature || "",
                    body: bodyText,
                });

                if (!isValid) {
                    return new Response("Unauthorized", { status: 401 });
                }

                console.log(new Date(), "Parsing body", bodyText);
                const update = JSON.parse(bodyText) as Update;
                const chatId = update.message?.chat?.id.toString();

                if (!chatId) return new Response("No chat ID", { status: 400 });

                console.log(new Date(), "chat id:", chatId);

                // Keep the await here! If this takes 30s and times out,
                // it throws an error, returns 500, and QStash retries it automatically.
                console.log(new Date(), `Creating bot`);

                const bot = new Bot(env.FINNEAS_BOT_TOKEN, {
                    botInfo: JSON.parse(env.FINNEAS_BOT_INFO),
                });

                bot.command("version", async (ctx: Context) => {
                    await ctx.reply("v0.2.37");
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
                        console.error("Workers AI error:", err);
                        await ctx.reply(
                            `❌ Failed to process transaction: ${
                                err.message || "Unknown error"
                            }`,
                        );
                    }
                });

                bot.on("message:voice", async (ctx) => {
                    console.log(new Date(), "Voice handler starts");
                    const file = await ctx.getFile();

                    if (!file.file_path) {
                        await ctx.reply("Could not retrieve the file path.");
                        return;
                    }

                    const fileUrl =
                        `https://api.telegram.org/file/bot${env.FINNEAS_BOT_TOKEN}/${file.file_path}`;

                    console.log(new Date(), "Fetching voice starts");
                    const response = await fetch(fileUrl);
                    if (!response.ok) {
                        await ctx.reply("Failed to download voice note.");
                        return;
                    }

                    const audioBuffer = await response.arrayBuffer();
                    console.log(new Date(), "Fetching voice ends");

                    let stt;
                    try {
                        stt = await transcribe({
                            audio: audioBuffer,
                            env,
                        });

                        if (!stt) {
                            await ctx.reply(
                                "Could not transcribe any speech from the voice note.",
                            );
                            return;
                        }
                    } catch (err) {
                        console.error(err);
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
                    console.log(new Date(), "Voice handler ends");
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

                bot.catch((err) => {
                    console.error(
                        "Unhandled error in grammY middleware:",
                        err.error,
                    );
                });

                console.log(new Date(), "Bot created");

                await bot.handleUpdate(update);

                return new Response("Processed successfully", { status: 200 });
            } catch (err) {
                console.error("Error processing queue:", err);
                return new Response("Internal Server Error", { status: 500 });
            }
        }

        return new Response("Not Found", { status: 404 });
    },
};

export { AgentDO };
