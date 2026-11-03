import type { ChatHistory } from "../types/Chat";
import { log, since, type LogFields } from "./log";
import { openrouterPost } from "./openrouterFetch";

type runOpenrouterModelParams = {
	model?: string;
	OPENROUTER_API_KEY: string;
	messages: ChatHistory;
	reasoning?: boolean;
	/** Extra fields (e.g. `chat_id`) for the `model.call` log line. */
	logFields?: LogFields;
};

type Choice = {
	message: {
		content: string | null;
		reasoning_details?: unknown;
	};
	finish_reason: string;
};

type OpenRouterResult = {
	choices?: Choice[];
	usage?: {
		completion_tokens: number;
		prompt_tokens: number;
		total_tokens: number;
		cost?: number;
	};
	model?: string;
};

/// Reasoning is mandatory for the model z-ai/glm-5.3-flash
export async function runOpenrouterModel({ model = "z-ai/glm-5.3-flash", OPENROUTER_API_KEY, messages, reasoning = true, logFields = {} }: runOpenrouterModelParams) {
	const start = Date.now();
	let result: OpenRouterResult;
	let status: number;
	try {
		({ data: result, status } = await openrouterPost<OpenRouterResult>(
			"/chat/completions",
			{ model, messages, reasoning: { enabled: reasoning } },
			OPENROUTER_API_KEY,
		));
	} catch (err) {
		log("model.call", { ...logFields, kind: "chat", model, ok: false, duration_ms: since(start) });
		throw err;
	}
	log("model.call", {
		...logFields,
		kind: "chat",
		model: result?.model ?? model,
		status,
		duration_ms: since(start),
		prompt_tokens: result?.usage?.prompt_tokens,
		completion_tokens: result?.usage?.completion_tokens,
		cost: result?.usage?.cost,
	});
	if (!result.choices || !Array.isArray(result.choices) || !result.choices[0]?.message) {
		throw new Error(`OpenRouter returned a malformed response (status ${status})`);
	}
	const choice = result.choices[0];
	const content = choice.message.content;
	if (content === null || content === undefined || content === "") {
		throw new Error(`Model returned no content (finish_reason: ${choice.finish_reason})`);
	}

	return {
		answer: content,
		reasoning_details: choice.message.reasoning_details,
		finish_reason: choice.finish_reason,
		usage: result.usage,
		model: result.model ?? model,
	};
}
