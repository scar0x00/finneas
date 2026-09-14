import type { ChatHistory } from "../types/Chat";

type runOpenrouterModelParams = {
  model: string;
  OPENROUTER_API_KEY: string;
  messages: ChatHistory;
  reasoning: boolean;
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

export async function runOpenrouterModel({
  model = "z-ai/glm-5.3-flash",
  OPENROUTER_API_KEY,
  messages,
  reasoning = false,
}: runOpenrouterModelParams) {
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
  if (!result.choices || !Array.isArray(result?.choices)) {
    throw new Error(
      "AI.run returned succefully, but the response object is malformed",
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
