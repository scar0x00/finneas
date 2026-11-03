import type { Bot } from "grammy";
import { log } from "../../lib/log";
import { createOpenRouter } from "../../lib/openrouter";
import { extractReceipt, formatReceiptHtml } from "../../lib/receipt";
import { downloadTelegramFile, tooLarge } from "../files";

export function registerPhoto(bot: Bot, env: Env): void {
	bot.on("message:photo", async (ctx) => {
		const largest = ctx.message.photo.at(-1)!;
		if (tooLarge(largest.file_size)) {
			await ctx.reply("That image is too large for me to download. Please send a smaller screenshot.");
			return;
		}
		// No "Reading your receipt…" message: the typing indicator keeps the user informed
		// and, as nothing has been sent yet, a transient model error can still be retried.
		await ctx.replyWithChatAction("typing").catch(() => {});

		const image = await downloadTelegramFile(ctx, env);
		if (!image) {
			await ctx.reply("I couldn't download that image. Please send it again.");
			return;
		}

		const result = await extractReceipt(createOpenRouter(env), image, { chat_id: ctx.chatId });
		if (!result.ok) {
			log("receipt.invalid", { chat_id: ctx.chatId, reason: result.reason, issues: result.issues });
			await ctx.reply("⚠️ I couldn't read the transaction details from that image. Try a clearer screenshot of the receipt.");
			return;
		}

		await ctx.reply(formatReceiptHtml(result.receipt), { parse_mode: "HTML" });
	});
}
