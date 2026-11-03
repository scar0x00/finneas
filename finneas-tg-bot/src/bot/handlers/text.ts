import type { Bot } from "grammy";
import { log } from "../../lib/log";
import { createOpenRouter } from "../../lib/openrouter";
import { reviseReceipt } from "../../lib/receipt";
import { pendingFooter, pendingKeyboard } from "../pending";
import { replyWithAgent } from "../replyWithAgent";

export function registerText(bot: Bot, env: Env): void {
	bot.on("message:text", async (ctx) => {
		const agent = env.AGENT_DO.getByName(String(ctx.chatId));
		// After "Edit" on a receipt, the next message is the correction.
		const editing = await agent.takeEditing();
		if (editing?.receipt) {
			const result = await reviseReceipt(createOpenRouter(env), editing.receipt, ctx.message.text, { chat_id: ctx.chatId });
			if (!result.ok) {
				log("receipt.invalid", { chat_id: ctx.chatId, reason: result.reason, issues: result.issues, stage: "edit" });
				await agent.startEditing(editing.id);
				await ctx.reply("I couldn't apply that change. Could you say it another way?");
				return;
			}
			const view = await agent.updatePendingReceipt(editing.id, result.receipt);
			if (!view) {
				await ctx.reply("That receipt is no longer available.");
				return;
			}
			await ctx.reply(view.html + pendingFooter(view), { parse_mode: "HTML", reply_markup: pendingKeyboard(view) });
			return;
		}
		await replyWithAgent(ctx, env, ctx.message.text, "text");
	});
}
