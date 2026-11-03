import type { Bot } from "grammy";
import { createOpenRouter } from "../../lib/openrouter";
import { downloadTelegramFile, tooLarge } from "../files";
import { replyWithAgent } from "../replyWithAgent";

/** Longer voice notes are refused before they cost a Whisper call. */
export const MAX_VOICE_SECONDS = 120;

export function registerVoice(bot: Bot, env: Env): void {
	bot.on("message:voice", async (ctx) => {
		const { duration, file_size } = ctx.message.voice;
		if (duration > MAX_VOICE_SECONDS) {
			await ctx.reply(`That voice note is too long. Please keep it under ${MAX_VOICE_SECONDS / 60} minutes.`);
			return;
		}
		if (tooLarge(file_size)) {
			await ctx.reply("That voice note is too large for me to download.");
			return;
		}
		await ctx.replyWithChatAction("typing").catch(() => {});

		const audio = await downloadTelegramFile(ctx, env);
		if (!audio) {
			await ctx.reply("Failed to download voice note.");
			return;
		}

		const text = await createOpenRouter(env).transcribe(audio, { chat_id: ctx.chatId });
		if (!text) {
			await ctx.reply("Could not transcribe any speech from the voice note.");
			return;
		}

		await replyWithAgent(ctx, env, text, "voice");
	});
}
