import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { mockFetch, jsonResponse, type FetchMock } from "./helpers/fetchMock";
import { chatCompletion, CHAT_PATH, OPENROUTER_HOST, STT_PATH } from "./helpers/openrouter";
import { createOpenRouter } from "../src/lib/openrouter";
import { isRetryable } from "../src/lib/errors";

let mock: FetchMock;
beforeEach(() => {
	mock = mockFetch();
});
afterEach(() => mock.restore());

const client = () => createOpenRouter(env as any);

describe("OpenRouter client", () => {
	it("chat() uses CHAT_MODEL and returns content, usage and finish reason", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("hi", { model: "served/model" })));
		const res = await client().chat({ messages: [{ role: "user", content: "hello" }] });
		expect(res).toMatchObject({ content: "hi", finishReason: "stop", model: "served/model", usage: { prompt_tokens: 10, completion_tokens: 5 } });
		const body = mock.calls[0].json();
		expect(body.model).toBe("test/chat-model");
		expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
	});

	it("chat() passes tools through and returns tool calls", async () => {
		const toolCalls = [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }];
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(null, { finish_reason: "tool_calls", tool_calls: toolCalls })));
		const tools = [{ type: "function" as const, function: { name: "f", description: "", parameters: { type: "object", properties: {} } } }];
		const res = await client().chat({ messages: [{ role: "user", content: "x" }], tools });
		expect(res.toolCalls).toEqual(toolCalls);
		expect(res.content).toBeNull();
		expect(mock.calls[0].json().tools).toEqual(tools);
	});

	it("chat() rejects an empty answer without tool calls", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(null)));
		await expect(client().chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/no content/);
	});

	it("chat() rejects a malformed response", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({ nope: true }));
		await expect(client().chat({ messages: [] })).rejects.toThrow(/malformed/);
	});

	it("vision() uses VISION_MODEL, sends the image and a strict json_schema response format", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion('{"a":1}')));
		const schema = { type: "object", properties: { a: { type: "number" } }, required: ["a"], additionalProperties: false };
		const res = await client().vision({ prompt: "read", image: new Uint8Array([1, 2, 3]).buffer, schemaName: "receipt", schema });
		expect(res.content).toBe('{"a":1}');
		const body = mock.calls[0].json();
		expect(body.model).toBe("test/vision-model");
		expect(body.temperature).toBe(0);
		expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "receipt", strict: true, schema } });
		const parts = body.messages[0].content;
		expect(parts[0]).toEqual({ type: "text", text: "read" });
		expect(parts[1].image_url.url).toBe("data:image/jpeg;base64,AQID");
	});

	it("transcribe() uses STT_MODEL and trims the text", async () => {
		mock.on(OPENROUTER_HOST, STT_PATH, () => jsonResponse({ text: "  hola  " }));
		expect(await client().transcribe(new Uint8Array([1]).buffer)).toBe("hola");
		const body = mock.calls[0].json();
		expect(body.model).toBe("test/stt-model");
		expect(body.input_audio).toEqual({ data: "AQ==", format: "ogg" });
	});

	it("falls back to default models when vars are missing", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("hi")));
		await createOpenRouter({ OPENROUTER_API_KEY: "k" } as any).chat({ messages: [] });
		expect(mock.calls[0].json().model).toBeTruthy();
	});

	it("propagates retryable errors", async () => {
		mock.on(OPENROUTER_HOST, STT_PATH, () => jsonResponse({}, 503));
		const err = await client()
			.transcribe(new Uint8Array([1]).buffer)
			.catch((e) => e);
		expect(isRetryable(err)).toBe(true);
	});

	it("uses one consistent attribution header set", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("hi")));
		mock.on(OPENROUTER_HOST, STT_PATH, () => jsonResponse({ text: "x" }));
		await client().chat({ messages: [] });
		await client().transcribe(new Uint8Array([1]).buffer);
		for (const c of mock.calls) {
			expect(c.headers.get("X-Title")).toBe("Finneas");
			expect(c.headers.get("HTTP-Referer")).toBe("https://finneas.dev");
		}
	});
});
