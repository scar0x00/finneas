import type { Bot } from "grammy";
import { logError } from "../../lib/log";
import { toNewMovement } from "../../lib/movements";
import { CALLBACK_PATTERN } from "../pending";

/** Save / Edit / Discard buttons under pending receipts and agent proposals. */
export function registerCallbacks(bot: Bot, env: Env): void {
	bot.on("callback_query:data", async (ctx) => {
		const match = ctx.callbackQuery.data.match(CALLBACK_PATTERN);
		const chatId = ctx.chatId;
		if (!match || chatId === undefined) {
			await ctx.answerCallbackQuery({ text: "That button is no longer valid." });
			return;
		}
		const [, id, action] = match;
		const agent = env.AGENT_DO.getByName(String(chatId));
		const pending = await agent.getPending(id);

		if (!pending || pending.status === "discarded") {
			await ctx.answerCallbackQuery({ text: "This receipt is no longer available." });
			return;
		}
		if (pending.status === "saved") {
			await ctx.answerCallbackQuery({ text: `Already saved ✓ (movement ${pending.movementId})` });
			return;
		}

		switch (action) {
			case "save": {
				if (!pending.view.canSave) {
					await ctx.answerCallbackQuery({ text: "Amount, currency or date is missing. Tap Edit first." });
					return;
				}
				const api = env.FINANCES_API;
				if (!api) {
					await ctx.answerCallbackQuery({ text: "Saving isn't available yet." });
					return;
				}
				let movementId: string;
				try {
					// The idempotency key makes a retried or double-tapped Save create one movement.
					const created = await api.createMovement(
						toNewMovement(pending.draft, { idempotencyKey: `pending:${chatId}:${id}`, tgUserId: ctx.from.id }),
					);
					movementId = created.id;
				} catch (err) {
					logError("movement.save_failed", err, { chat_id: chatId });
					await ctx.answerCallbackQuery({ text: "I couldn't save it right now. Please try again." });
					return;
				}
				await agent.markPendingSaved(id, movementId);
				await ctx.editMessageText(`${pending.view.html}\n\n<b>Saved ✓</b> (movement ${movementId})`, { parse_mode: "HTML" });
				await ctx.answerCallbackQuery({ text: "Saved ✓" });
				return;
			}
			case "discard": {
				await agent.discardPending(id);
				await ctx.editMessageText(`${pending.view.html}\n\n<i>Discarded</i>`, { parse_mode: "HTML" });
				await ctx.answerCallbackQuery({ text: "Discarded" });
				return;
			}
			case "edit": {
				await agent.startEditing(id);
				await ctx.answerCallbackQuery();
				await ctx.reply('What should I change? For example: "the amount was 1.500,00" or "the recipient is Farmatodo".');
				return;
			}
		}
	});
}
