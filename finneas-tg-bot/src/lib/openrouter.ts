import { arrayBufferToBase64 } from "./arrayBufferToBase64";
import { isRetryableStatus, RetryableError } from "./errors";
import { log, since, type LogFields } from "./log";

/** The only place that knows OpenRouter's URL, headers and model ids. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_TIMEOUT_MS = 25_000;

export const DEFAULT_CHAT_MODEL = "google/gemini-3.1-flash-lite";
export const DEFAULT_VISION_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEFAULT_STT_MODEL = "openai/whisper-large-v3-turbo";

export interface OpenRouterEnv {
	OPENROUTER_API_KEY: string;
	CHAT_MODEL?: string;
	VISION_MODEL?: string;
	STT_MODEL?: string;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: Role;
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ToolDefinition {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens?: number;
	cost?: number;
}

export interface ChatResponse {
	content: string | null;
	toolCalls: ToolCall[];
	finishReason: string;
	model: string;
	usage?: Usage;
}

interface CompletionResult {
	model?: string;
	usage?: Usage;
	choices?: { finish_reason: string; message: { content: string | null; tool_calls?: ToolCall[] } }[];
}

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
				signal: controller.signal,
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
		try {
			return { data: (await response.json()) as T, status: response.status };
		} catch (err) {
			throw new RetryableError(`OpenRouter ${path} returned invalid JSON`, { cause: err });
		}
	} finally {
		clearTimeout(timer);
	}
}

export interface OpenRouter {
	chat(input: { messages: ChatMessage[]; tools?: ToolDefinition[]; model?: string; logFields?: LogFields }): Promise<ChatResponse>;
	vision(input: {
		prompt: string;
		image: ArrayBuffer;
		schemaName: string;
		schema: Record<string, unknown>;
		mimeType?: string;
		logFields?: LogFields;
	}): Promise<ChatResponse>;
	transcribe(audio: ArrayBuffer, logFields?: LogFields): Promise<string>;
}

export function createOpenRouter(env: OpenRouterEnv): OpenRouter {
	const chatModel = env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
	const visionModel = env.VISION_MODEL || DEFAULT_VISION_MODEL;
	const sttModel = env.STT_MODEL || DEFAULT_STT_MODEL;

	async function completion(kind: string, body: Record<string, unknown>, logFields: LogFields, allowEmpty: boolean): Promise<ChatResponse> {
		const start = Date.now();
		let data: CompletionResult;
		try {
			({ data } = await openrouterPost<CompletionResult>("/chat/completions", body, env.OPENROUTER_API_KEY));
		} catch (err) {
			log("model.call", { ...logFields, kind, model: body.model, ok: false, duration_ms: since(start) });
			throw err;
		}
		log("model.call", {
			...logFields,
			kind,
			model: data?.model ?? body.model,
			duration_ms: since(start),
			prompt_tokens: data?.usage?.prompt_tokens,
			completion_tokens: data?.usage?.completion_tokens,
			cost: data?.usage?.cost,
		});
		const choice = data?.choices?.[0];
		if (!choice?.message) throw new Error("OpenRouter returned a malformed response");
		const toolCalls = choice.message.tool_calls ?? [];
		const content = choice.message.content ?? null;
		if (!allowEmpty && !content && toolCalls.length === 0) {
			throw new Error(`Model returned no content (finish_reason: ${choice.finish_reason})`);
		}
		return { content, toolCalls, finishReason: choice.finish_reason, model: data.model ?? String(body.model), usage: data.usage };
	}

	return {
		chat({ messages, tools, model, logFields = {} }) {
			const body: Record<string, unknown> = { model: model ?? chatModel, messages };
			if (tools && tools.length > 0) body.tools = tools;
			return completion("chat", body, logFields, false);
		},

		vision({ prompt, image, schemaName, schema, mimeType = "image/jpeg", logFields = {} }) {
			const dataUrl = `data:${mimeType};base64,${arrayBufferToBase64(image)}`;
			return completion(
				"vision",
				{
					model: visionModel,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: prompt },
								{ type: "image_url", image_url: { url: dataUrl } },
							],
						},
					],
					response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
					reasoning: { enabled: false },
					temperature: 0,
				},
				{ ...logFields, image_bytes: image.byteLength },
				true,
			);
		},

		async transcribe(audio, logFields = {}) {
			const start = Date.now();
			let data: { text?: string; usage?: Usage };
			try {
				({ data } = await openrouterPost<{ text?: string; usage?: Usage }>(
					"/audio/transcriptions",
					{ model: sttModel, input_audio: { data: arrayBufferToBase64(audio), format: "ogg" } },
					env.OPENROUTER_API_KEY,
				));
			} catch (err) {
				log("model.call", { ...logFields, kind: "transcription", model: sttModel, ok: false, duration_ms: since(start) });
				throw err;
			}
			log("model.call", {
				...logFields,
				kind: "transcription",
				model: sttModel,
				duration_ms: since(start),
				audio_bytes: audio.byteLength,
				prompt_tokens: data?.usage?.prompt_tokens,
				completion_tokens: data?.usage?.completion_tokens,
				cost: data?.usage?.cost,
			});
			if (typeof data?.text !== "string") throw new Error("Transcription result is malformed.");
			return data.text.trim();
		},
	};
}
