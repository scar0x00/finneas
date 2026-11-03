import type { ChatHistory } from "../types/Chat";
import type { AgentDOHistory } from "./AgentDO";
import { log, since, type LogFields } from "./log";

type runOpenrouterModelParams = {
  model?: string;
  OPENROUTER_API_KEY: string;
  messages: ChatHistory | AgentDOHistory;
  reasoning?: boolean;
  /** Extra fields (e.g. `chat_id`) for the `model.call` log line. */
  logFields?: LogFields;
};

type Choice = {
  message: {
    content: string;
    reasoning_details: string;
  };
  finish_reason: string;
};

type OpenRouterResult = {
  choices: Choice[];
  usage: {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
  };
  model: string
};

/// Reasoning is mandatory for the model z-ai/glm-5.3-flash
export async function runOpenrouterModel({
  model = "z-ai/glm-5.3-flash",
  OPENROUTER_API_KEY,
  messages,
  reasoning = true,
  logFields = {},
}: runOpenrouterModelParams) {
  const start = Date.now();
  let response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://finneas.dev",
      "X-Title": "Finneas",
    },
    body: JSON.stringify({
      "model": model,
      messages,
      "reasoning": { "enabled": reasoning },
    }),
  });
  const result: OpenRouterResult = await response.json();
  log("model.call", {
    ...logFields,
    kind: "chat",
    model: result?.model ?? model,
    status: response.status,
    duration_ms: since(start),
    prompt_tokens: result?.usage?.prompt_tokens,
    completion_tokens: result?.usage?.completion_tokens,
  });
  if (!result.choices || !Array.isArray(result?.choices)) {
    throw new Error(
      `OpenRouter returned a malformed response (status ${response.status})`,
    );
  }
  const message = result?.choices[0]?.message;

  return {
    answer: message.content,
    reasoning_details: message.reasoning_details,
    finish_reason: result.choices[0].finish_reason,
    usage: result.usage,
    model: result.model
  };
}
