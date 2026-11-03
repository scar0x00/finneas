import type { Context } from "grammy";
import { log } from "../lib/log";
import { sendLongMessage } from "../lib/telegram";
import { pendingFooter, pendingKeyboard } from "./pending";

/**
 * Sends `text` to the chat's agent and replies with its answer. Shared by text and voice.
 * A redelivered update does not call the model again; its stored answer is re-sent only
 * if it never reached the user.
 */
export async function replyWithAgent(ctx: Context, env: Env, text: string, source: "text" | "voice"): Promise<void> {
	const chatId = ctx.chatId!;
	const updateId = ctx.update.update_id;
	const agent = env.AGENT_DO.getByName(chatId.toString());
	const result = await agent.chat({ updateId, text, source, userId: ctx.from?.id });
	if (result.duplicate) {
		log("update.duplicate", { update_id: updateId, chat_id: chatId, replied: result.replied });
		if (result.replied) return;
	}
	await sendLongMessage(ctx.api, chatId, result.answer);
	// Movements the agent proposed: nothing is saved until the user taps Save.
	for (const view of result.proposals) {
		await ctx.api.sendMessage(chatId, view.html + pendingFooter(view), { parse_mode: "HTML", reply_markup: pendingKeyboard(view) });
	}
	await agent.markReplied(updateId);
}
