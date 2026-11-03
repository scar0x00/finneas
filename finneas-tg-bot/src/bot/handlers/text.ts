import type { Bot } from "grammy";
import { replyWithAgent } from "../replyWithAgent";

export function registerText(bot: Bot, env: Env): void {
	bot.on("message:text", async (ctx) => {
		await replyWithAgent(ctx, env, ctx.message.text, "text");
	});
}
