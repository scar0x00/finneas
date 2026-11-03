import type { Update } from "grammy/types";

export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/**
 * Constant-time string comparison. Both values are hashed first so that
 * `timingSafeEqual` always compares equal-length buffers and the length of
 * the secret does not leak either.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

/** True only when a secret is configured and the request carries exactly that secret. */
export async function hasValidTelegramSecret(request: Request, secret: string | undefined): Promise<boolean> {
	if (!secret) return false;
	const provided = request.headers.get(TELEGRAM_SECRET_HEADER);
	if (provided === null) return false;
	return timingSafeEqualStrings(provided, secret);
}

/** Parses `"1, 2,3"` into a set of user ids. Empty or missing means nobody is allowed. */
export function parseAllowedUserIds(value: string | undefined): Set<number> {
	const ids = new Set<number>();
	for (const part of (value ?? "").split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const id = Number(trimmed);
		if (Number.isSafeInteger(id)) ids.add(id);
	}
	return ids;
}

/** The Telegram user who sent an update, for the update types the bot handles. */
export function senderId(update: Update): number | undefined {
	return update.message?.from?.id ?? update.callback_query?.from?.id ?? update.edited_message?.from?.id;
}

export function isAllowedSender(update: Update, allowedUserIds: string | undefined): boolean {
	const id = senderId(update);
	return id !== undefined && parseAllowedUserIds(allowedUserIds).has(id);
}
