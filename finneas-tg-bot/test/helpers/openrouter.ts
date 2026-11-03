import { type FetchMock, jsonResponse } from "./fetchMock";

export const OPENROUTER_HOST = "openrouter.ai";
export const CHAT_PATH = "/api/v1/chat/completions";
export const STT_PATH = "/api/v1/audio/transcriptions";

export function chatCompletion(content: string | null, extra: { finish_reason?: string; tool_calls?: unknown[]; model?: string } = {}) {
	return {
		id: "gen-test",
		model: extra.model ?? "test/model",
		choices: [
			{
				finish_reason: extra.finish_reason ?? "stop",
				message: { role: "assistant", content, ...(extra.tool_calls ? { tool_calls: extra.tool_calls } : {}) },
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	};
}

/** Every chat completion returns `answer` (or the result of calling it). */
export function mockChat(mock: FetchMock, answer: string | ((body: any) => string)): FetchMock {
	return mock.on(OPENROUTER_HOST, CHAT_PATH, (call) => {
		const text = typeof answer === "function" ? answer(call.json()) : answer;
		return jsonResponse(chatCompletion(text));
	});
}

export function mockTranscription(mock: FetchMock, text: string): FetchMock {
	return mock.on(OPENROUTER_HOST, STT_PATH, () => jsonResponse({ text }));
}

export function chatCalls(mock: FetchMock) {
	return mock.callsTo(OPENROUTER_HOST, CHAT_PATH);
}
