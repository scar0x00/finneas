import type { Api } from "grammy";

export const TELEGRAM_MAX_MESSAGE = 4096;

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(value: unknown): string {
	if (value === null || value === undefined) return "";
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Splits text into chunks of at most `limit` characters, preferring paragraph
 * breaks, then line breaks, then spaces, and hard-splitting only as a last resort.
 * The separator at a split point is dropped.
 */
export function splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
	if (text.length <= limit) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const window = rest.slice(0, limit + 1);
		let cut = -1;
		let sepLen = 0;
		for (const sep of ["\n\n", "\n", " "]) {
			const idx = window.lastIndexOf(sep);
			if (idx > 0) {
				cut = idx;
				sepLen = sep.length;
				break;
			}
		}
		if (cut === -1) {
			cut = limit;
			sepLen = 0;
		}
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut + sepLen);
	}
	if (rest.length > 0) parts.push(rest);
	return parts;
}

/** Sends `text` as one or more messages so Telegram's 4096-character limit is never hit. */
export async function sendLongMessage(api: Api, chatId: number | string, text: string, other?: Parameters<Api["sendMessage"]>[2]): Promise<void> {
	for (const chunk of splitMessage(text)) {
		await api.sendMessage(chatId, chunk, other);
	}
}
