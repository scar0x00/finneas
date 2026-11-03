/**
 * Marks a failure worth retrying (429, 5xx, network errors, timeouts).
 *
 * Errors lose their class when they cross a Durable Object RPC boundary, so
 * the marker is also kept in the message prefix and checked by `isRetryable`.
 */
export const RETRYABLE_PREFIX = "[retryable] ";

export class RetryableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message.startsWith(RETRYABLE_PREFIX) ? message : RETRYABLE_PREFIX + message, options);
		this.name = "RetryableError";
	}
}

export function isRetryable(err: unknown): boolean {
	if (err instanceof RetryableError) return true;
	if (err instanceof Error) {
		if (err.name === "RetryableError") return true;
		if (err.message.includes(RETRYABLE_PREFIX)) return true;
		// grammY's GrammyError carries the Bot API error code; HttpError means a network failure.
		const code = (err as { error_code?: unknown }).error_code;
		if (typeof code === "number" && isRetryableStatus(code)) return true;
		if (err.name === "HttpError") return true;
		// grammY wraps handler errors in BotError with the original in `.error`.
		const inner = (err as { error?: unknown }).error;
		if (inner && inner !== err) return isRetryable(inner);
	}
	return false;
}

/** HTTP statuses that a retry might fix. */
export function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}
