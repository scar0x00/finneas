import { Bot } from "grammy";
import { registerCommands } from "./handlers/commands";
import { registerPhoto } from "./handlers/photo";
import { registerText } from "./handlers/text";
import { registerVoice } from "./handlers/voice";

export function newBot(env: Env): Bot {
	return new Bot(env.FINNEAS_BOT_TOKEN, { botInfo: JSON.parse(env.FINNEAS_BOT_INFO) });
}

/** Registers every handler. Order matters: commands before the generic text handler. */
export function registerHandlers(bot: Bot, env: Env): void {
	registerCommands(bot, env);
	registerPhoto(bot, env);
	registerVoice(bot, env);
	registerText(bot, env);
	bot.on("message", async (ctx) => {
		await ctx.reply("I can read text, voice notes and receipt photos.");
	});
}
