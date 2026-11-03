import { isRetryableStatus, RetryableError } from "./errors";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_TIMEOUT_MS = 25_000;

/**
 * POSTs JSON to an OpenRouter endpoint with shared headers and a timeout.
 *
 * Throws `RetryableError` for 408/429/5xx, network errors and timeouts, and a
 * plain `Error` (with the status, never the body) for other non-2xx responses.
 */
export async function openrouterPost<T>(path: string, body: unknown, apiKey: string, timeoutMs = OPENROUTER_TIMEOUT_MS): Promise<{ data: T; status: number }> {
	// A cleared timer instead of AbortSignal.timeout(): a pending timeout would keep
	// the Durable Object busy long after the response arrived.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException("OpenRouter request timed out", "TimeoutError")), timeoutMs);
	try {
		return await doPost<T>(path, body, apiKey, controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

async function doPost<T>(path: string, body: unknown, apiKey: string, signal: AbortSignal): Promise<{ data: T; status: number }> {
	let response: Response;
	try {
		response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://finneas.dev",
				"X-Title": "Finneas",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		throw new RetryableError(`OpenRouter request to ${path} failed: ${err instanceof Error ? err.name : "network error"}`, { cause: err });
	}
	if (!response.ok) {
		// Drain the body so the connection can be reused; never surface it.
		await response.body?.cancel().catch(() => {});
		const message = `OpenRouter ${path} failed with status ${response.status}`;
		if (isRetryableStatus(response.status)) throw new RetryableError(message);
		throw new Error(message);
	}
	let data: T;
	try {
		data = (await response.json()) as T;
	} catch (err) {
		throw new RetryableError(`OpenRouter ${path} returned invalid JSON`, { cause: err });
	}
	return { data, status: response.status };
}
