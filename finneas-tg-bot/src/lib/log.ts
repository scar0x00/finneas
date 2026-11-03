/**
 * Structured logging. Workers Logs indexes JSON fields, so every line is a
 * single JSON object with an `event` name plus ids, sizes and timings.
 *
 * NEVER log message text, transcriptions, chat history, model output or
 * extracted receipt fields. This module is the only place allowed to touch
 * `console`.
 */
export type LogFields = Record<string, unknown>;

export function log(event: string, fields: LogFields = {}): void {
	console.log(JSON.stringify({ event, ...fields }));
}

export function logWarn(event: string, fields: LogFields = {}): void {
	console.warn(JSON.stringify({ event, ...fields }));
}

export function logError(event: string, err: unknown, fields: LogFields = {}): void {
	const error = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { value: String(err) };
	console.error(JSON.stringify({ event, ...fields, error }));
}

/** Milliseconds since `start` (from `Date.now()`). */
export function since(start: number): number {
	return Date.now() - start;
}
