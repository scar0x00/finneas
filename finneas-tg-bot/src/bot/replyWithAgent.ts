import type { Context } from "grammy";
import { log } from "../lib/log";
import { sendLongMessage } from "../lib/telegram";

/**
 * Sends `text` to the chat's agent and replies with its answer. Shared by text and voice.
 * A redelivered update does not call the model again; its stored answer is re-sent only
 * if it never reached the user.
 */
export async function replyWithAgent(ctx: Context, env: Env, text: string, source: "text" | "voice"): Promise<void> {
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
