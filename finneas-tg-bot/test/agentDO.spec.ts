import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { mockFetch, jsonResponse, type FetchMock } from "./helpers/fetchMock";
import { chatCalls, chatCompletion, CHAT_PATH, mockChat, OPENROUTER_HOST } from "./helpers/openrouter";
import { isRetryable } from "../src/lib/errors";
import { SYSTEM } from "../src/SYSTEM_PROMPT";

let mock: FetchMock;
let seq = 0;
let nextUpdate = 1;
const agentFor = () => (env as any).AGENT_DO.getByName(`${900_000 + seq++}`);
const input = (text: string, updateId = nextUpdate++) => ({ updateId, text, source: "text" as const });

beforeEach(() => {
	mock = mockFetch();
	mockChat(mock, (body) => `echo: ${body.messages.at(-1).content}`);
});
afterEach(() => mock.restore());

function sql<T = Record<string, unknown>>(stub: any, query: string, ...bindings: unknown[]): Promise<T[]> {
	return runInDurableObject(stub, (_i, state: DurableObjectState) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
}
const rows = (stub: any) => sql(stub, "SELECT role, content, update_id FROM chat_messages ORDER BY id");
const sentMessages = (callIndex = -1) => chatCalls(mock).at(callIndex)!.json().messages as { role: string; content: string }[];

describe("AgentDO.chat()", () => {
	it("answers and stores the user and assistant messages with the update id", async () => {
		const agent = agentFor();
		const result = await agent.chat(input("hello", 501));
		expect(result).toEqual({ answer: "echo: hello", duplicate: false });
		expect(await rows(agent)).toEqual([
			{ role: "user", content: "hello", update_id: 501 },
			{ role: "assistant", content: "echo: hello", update_id: 501 },
		]);
	});

	it("records model and token usage on the assistant row", async () => {
		const agent = agentFor();
		await agent.chat(input("hello"));
		const [assistant] = await sql(agent, "SELECT model, prompt_tokens, completion_tokens FROM chat_messages WHERE role = 'assistant'");
		expect(assistant).toEqual({ model: "test/model", prompt_tokens: 10, completion_tokens: 5 });
	});

	it("uses the CHAT_MODEL var", async () => {
		const agent = agentFor();
		await agent.chat(input("hello"));
		expect(chatCalls(mock)[0].json().model).toBe("test/chat-model");
	});

	it("prepends the current system prompt and never stores it", async () => {
		const agent = agentFor();
		await agent.chat(input("hello"));
		expect(sentMessages()[0]).toEqual({ role: "system", content: SYSTEM });
		expect(await sql(agent, "SELECT * FROM chat_messages WHERE role = 'system'")).toEqual([]);
	});

	it("includes earlier turns in the context", async () => {
		const agent = agentFor();
		await agent.chat(input("first"));
		await agent.chat(input("second"));
		expect(sentMessages().map((m) => m.content)).toEqual([SYSTEM, "first", "echo: first", "second"]);
	});

	it("sends only the system prompt plus the last 30 messages", async () => {
		const agent = agentFor();
		await runInDurableObject(agent, (_i, state: DurableObjectState) => {
			for (let i = 0; i < 100; i++) {
				state.storage.sql.exec("INSERT INTO chat_messages (role, content) VALUES (?, ?)", i % 2 === 0 ? "user" : "assistant", `m${i}`);
			}
		});
		await agent.chat(input("latest"));
		const sent = sentMessages();
		expect(sent).toHaveLength(1 + 30);
		expect(sent[0].role).toBe("system");
		// 29 stored messages (m71..m99) + the new user message
		expect(sent[1].content).toBe("m71");
		expect(sent.at(-2)!.content).toBe("m99");
		expect(sent.at(-1)!.content).toBe("latest");
		// Everything is still kept for audit.
		expect((await rows(agent)).length).toBe(102);
	});

	it("makes one model call for a repeated update id and returns the stored answer", async () => {
		const agent = agentFor();
		const first = await agent.chat(input("hello", 777));
		const second = await agent.chat(input("hello", 777));
		expect(second).toEqual({ answer: first.answer, duplicate: true, replied: false });
		expect(chatCalls(mock)).toHaveLength(1);
		expect(await rows(agent)).toHaveLength(2);
	});

	it("reports a duplicate as already replied once markReplied() was called", async () => {
		const agent = agentFor();
		await agent.chat(input("hello", 778));
		await agent.markReplied(778);
		expect(await agent.chat(input("hello", 778))).toEqual({ answer: "echo: hello", duplicate: true, replied: true });
	});

	it("runs concurrent calls one after the other so the second sees the first exchange", async () => {
		mock.restore();
		mock = mockFetch();
		let inFlight = 0;
		let maxInFlight = 0;
		mock.on(OPENROUTER_HOST, CHAT_PATH, async (call) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 30));
			inFlight--;
			return jsonResponse(chatCompletion(`echo: ${call.json().messages.at(-1).content}`));
		});
		const agent = agentFor();
		const [a, b] = await Promise.all([agent.chat(input("one")), agent.chat(input("two"))]);
		expect(a.answer).toBe("echo: one");
		expect(b.answer).toBe("echo: two");
		expect(maxInFlight).toBe(1);
		expect(sentMessages(1).map((m) => m.content)).toEqual([SYSTEM, "one", "echo: one", "two"]);
	});

	it("keeps working after a failed call in the queue", async () => {
		const agent = agentFor();
		mock.once(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({}, 400));
		// Don't use expect(...).rejects on RPC promises: it touches pipelined properties,
		// which creates extra promises that reject unhandled.
		const err = await agent.chat(input("bad")).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect(await agent.chat(input("good"))).toMatchObject({ answer: "echo: good" });
	});

	it("writes nothing when the model fails, and keeps errors retryable across RPC", async () => {
		const agent = agentFor();
		mock.once(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse({}, 503));
		const err = await agent.chat(input("hello")).catch((e: unknown) => e);
		expect(isRetryable(err)).toBe(true);
		expect(await rows(agent)).toEqual([]);
	});

	it("clearChat() empties the history", async () => {
		const agent = agentFor();
		await agent.chat(input("hello"));
		await agent.clearChat();
		expect(await rows(agent)).toEqual([]);
	});

	it("keeps history across evictions", async () => {
		const agent = agentFor();
		await agent.chat(input("first"));
		await evictDurableObject(agent);
		await agent.chat(input("second"));
		expect(sentMessages().map((m) => m.content)).toContain("echo: first");
	});
});

describe("AgentDO schema migrations", () => {
	it("migrates a v1 chat to the latest schema without losing messages and drops stored system prompts", async () => {
		const agent = agentFor();
		// Rebuild the DO's storage exactly as the v1 code left it.
		await runInDurableObject(agent, (_i, state: DurableObjectState) => {
			state.storage.sql.exec("DROP TABLE IF EXISTS chat_messages");
			state.storage.sql.exec("DROP TABLE IF EXISTS schema_migrations");
			state.storage.sql.exec(`CREATE TABLE chat_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
				content TEXT NOT NULL,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
			state.storage.sql.exec("INSERT INTO chat_messages (role, content) VALUES ('system', 'OLD STALE PROMPT'), ('user', 'u1'), ('assistant', 'a1')");
		});
		await evictDurableObject(agent);

		await agent.chat(input("u2"));

		expect(sentMessages().map((m) => m.content)).toEqual([SYSTEM, "u1", "a1", "u2"]);
		expect((await rows(agent)).map((r: any) => r.content)).toEqual(["u1", "a1", "u2", "echo: u2"]);
		const [version] = await sql<{ version: number }>(agent, "SELECT MAX(version) AS version FROM schema_migrations");
		expect(version.version).toBeGreaterThanOrEqual(2);
	});

	it("is idempotent across restarts", async () => {
		const agent = agentFor();
		await agent.chat(input("a"));
		await evictDurableObject(agent);
		await agent.chat(input("b"));
		expect(await rows(agent)).toHaveLength(4);
	});
});
