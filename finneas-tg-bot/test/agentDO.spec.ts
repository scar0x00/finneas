import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { mockFetch, type FetchMock } from "./helpers/fetchMock";
import { chatCalls, mockChat } from "./helpers/openrouter";
import { SYSTEM } from "../src/SYSTEM_PROMPT";

let mock: FetchMock;
let seq = 0;
const agentFor = () => (env as any).AGENT_DO.getByName(`agent-test-${Date.now()}-${seq++}`);

beforeEach(() => {
	mock = mockFetch();
	mockChat(mock, (body) => `echo: ${body.messages.at(-1).content}`);
});
afterEach(() => mock.restore());

function rows(stub: any) {
	return runInDurableObject(stub, (_i, state: DurableObjectState) =>
		state.storage.sql.exec("SELECT role, content FROM chat_messages ORDER BY id").toArray(),
	);
}

describe("AgentDO", () => {
	it("stores the user and assistant messages", async () => {
		const agent = agentFor();
		await agent.init({ SYSTEM });
		const answer = await agent.run("hello");
		expect(answer).toBe("echo: hello");
		const stored = (await rows(agent)).filter((r: any) => r.role !== "system");
		expect(stored).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "echo: hello" },
		]);
		expect(chatCalls(mock)).toHaveLength(1);
	});

	it("clearChat() empties the history", async () => {
		const agent = agentFor();
		await agent.init({ SYSTEM });
		await agent.run("hello");
		await agent.clearChat();
		expect(await rows(agent)).toEqual([]);
	});

	it("keeps history across evictions", async () => {
		const agent = agentFor();
		await agent.init({ SYSTEM });
		await agent.run("first");
		await evictDurableObject(agent);
		await agent.init({ SYSTEM });
		await agent.run("second");
		const sent = chatCalls(mock).at(-1)!.json().messages.map((m: any) => m.content);
		expect(sent).toContain("first");
		expect(sent).toContain("echo: first");
	});
});
