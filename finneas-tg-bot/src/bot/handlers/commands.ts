import type { Bot } from "grammy";

export const version = (env: Env) => env.VERSION || "dev";

export function registerCommands(bot: Bot, env: Env): void {
	bot.command("version", async (ctx) => {
		await ctx.reply(version(env));
	});

	bot.command("login", async (ctx) => {
		await ctx.reply("WIP");
	});

	bot.command("new", async (ctx) => {
		await env.AGENT_DO.getByName(ctx.chatId.toString()).clearChat();
		await ctx.reply("Let's start again.");
	});
}
