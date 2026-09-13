import { Update } from "grammy/types";
import { UpdateProcessor } from "./UpdateProcessor";
import { Bot } from "grammy";

export interface Env {
    XAI_API_KEY: string;
    OPENROUTER_API_KEY: string;
    FINNEAS_BOT_INFO: string;
    FINNEAS_BOT_TOKEN: string;
    AI: Ai;
    CHATS: KVNamespace;
    TG_UPDATES: Queue;
    UPDATE_PROCESSOR: DurableObjectNamespace<UpdateProcessor>;
}

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        if (request.method === "POST") {
            try {
                const update = await request.json() as Update;
                const bot = new Bot(env.FINNEAS_BOT_TOKEN, {
                    botInfo: JSON.parse(env.FINNEAS_BOT_INFO),
                });
                if (!update?.message?.chat?.id) {
                    console.error("No chat ID on update");
                    return new Response("REQUEST INVALID", { status: 400 });
                }
                console.log(new Date(), "Sending", update);
                await env.TG_UPDATES.send(update);
                console.log(new Date(), "Sent", update);
                await bot.api.sendChatAction(
                    update?.message?.chat?.id.toString(),
                    "typing",
                );
            } catch (err) {
                console.error("Error parsing update:", err);
            }
        }

        return new Response("OK", { status: 200 });
    },

    async queue(
        batch: MessageBatch<Update>,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<void> {
        console.log(new Date(), "Processing messages", JSON.stringify(batch.messages));
        for (const message of batch.messages) {
            if (!message.body?.message?.chat?.id) {
                console.error("No chat ID on message");
                message.ack();
                return;
            }
            const processor = env.UPDATE_PROCESSOR.getByName(
                message.body?.message?.chat?.id.toString(),
            );
            await processor.processUpdate(message.body);
            message.ack();
        }
    },

};

export { UpdateProcessor };
