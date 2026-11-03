import type { Context } from "grammy";
import { isRetryableStatus, RetryableError } from "../lib/errors";

/** Telegram's getFile only serves files up to 20 MB. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class FileTooLargeError extends Error {
	constructor() {
		super("File is larger than Telegram's 20 MB download limit");
		this.name = "FileTooLargeError";
	}
}

/**
 * Downloads the file attached to the current message. Returns null when Telegram
 * has no path for it; throws `RetryableError` on 5xx.
 */
export async function downloadTelegramFile(ctx: Context, env: Env): Promise<ArrayBuffer | null> {
	const file = await ctx.getFile();
	if (!file.file_path) return null;
	if (file.file_size !== undefined && file.file_size > MAX_DOWNLOAD_BYTES) throw new FileTooLargeError();
	const response = await fetch(`https://api.telegram.org/file/bot${env.FINNEAS_BOT_TOKEN}/${file.file_path}`);
	if (!response.ok) {
		if (isRetryableStatus(response.status)) throw new RetryableError(`Telegram file download failed with status ${response.status}`);
		return null;
	}
	return response.arrayBuffer();
}

export function tooLarge(fileSize: number | undefined): boolean {
	return fileSize !== undefined && fileSize > MAX_DOWNLOAD_BYTES;
}
