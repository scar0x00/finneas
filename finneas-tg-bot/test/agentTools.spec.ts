import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FetchMock, jsonResponse, mockFetch } from "./helpers/fetchMock";
import { financesApi, financesCalls } from "./helpers/finances";
import { CHAT_PATH, chatCalls, chatCompletion, OPENROUTER_HOST } from "./helpers/openrouter";
import { callbackQueryUpdate, mockTelegram, sentTexts, telegramCalls, textUpdate } from "./helpers/telegram";
import { callWorker, processRequest } from "./helpers/worker";

let mock: FetchMock;
let seq = 0;
let chatId: number;
let nextUpdate = 50_000;

const toolCall = (name: string, args: unknown, id = `call_${name}`) => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});

/** First call asks for `calls`; once tool results are present it answers `final`. */
function mockToolRound(calls: unknown[], final = "Done.") {
	mock.on(OPENROUTER_HOST, CHAT_PATH, (call) => {
		const messages = call.json().messages;
		if (messages.at(-1).role === "tool") return jsonResponse(chatCompletion(final));
		return jsonResponse(chatCompletion(null, { finish_reason: "tool_calls", tool_calls: calls }));
	});
}

const LUNCH = { type: "egress", amount: "20", currency: "USD", made_at: "2026-11-03", counterparty: "Arepera X", description: "lunch" };

beforeEach(async () => {
	chatId = 4_000_000 + seq++;
	mock = mockFetch();
	mockTelegram(mock);
	await financesApi().__reset();
});
afterEach(() => mock.restore());

const say = async (text: string) => callWorker(await processRequest(textUpdate(text, { chatId, userId: 1001, updateId: nextUpdate++ })));

describe("agent tools", () => {
	it("offers register_movement, list_recent_movements and get_balance to the model", async () => {
		mockToolRound([], "hi");
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("hi")));
		await say("hello");
		const names = chatCalls(mock)[0]
			.json()
			.tools.map((t: any) => t.function.name)
			.sort();
		expect(names).toEqual(["get_balance", "list_recent_movements", "register_movement"]);
	});

	it("register_movement only proposes: nothing is written until the user taps Save", async () => {
		mockToolRound([toolCall("register_movement", LUNCH)], "Please confirm the movement below.");
		await say("I paid 20 dollars for lunch at Arepera X today");

		expect(await financesCalls("createMovement")).toHaveLength(0);
		const texts = sentTexts(mock);
		expect(texts[0]).toBe("Please confirm the movement below.");
		const proposal = telegramCalls(mock, "sendMessage")
			.map((c) => c.json())
			.find((m) => m.reply_markup);
		expect(proposal.text).toContain("20.00 USD");
		expect(proposal.text).toContain("Arepera X");
		const buttons = proposal.reply_markup.inline_keyboard.flat();
		expect(buttons.map((b: any) => b.callback_data.split(":")[2])).toEqual(["save", "discard"]);

		await callWorker(await processRequest(callbackQueryUpdate(buttons[0].callback_data, { chatId, userId: 1001 })));
		const creates = await financesCalls("createMovement");
		expect(creates).toHaveLength(1);
		expect(creates[0].args).toMatchObject({
			tgUserId: 1001,
			type: "egress",
			amount: "20",
			currency: "USD",
			madeAt: "2026-11-03",
			counterpartyName: "Arepera X",
			description: "lunch",
			source: "telegram_bot",
		});
	});

	it("sends the tool result back to the model", async () => {
		mockToolRound([toolCall("register_movement", LUNCH, "call_1")]);
		await say("lunch 20 usd");
		const second = chatCalls(mock)[1].json().messages;
		const assistant = second.at(-2);
		const tool = second.at(-1);
		expect(assistant.role).toBe("assistant");
		expect(assistant.tool_calls[0].id).toBe("call_1");
		expect(tool).toMatchObject({ role: "tool", tool_call_id: "call_1" });
		expect(tool.content).toMatch(/confirm/i);
	});

	it("rejects invalid arguments without proposing anything", async () => {
		mockToolRound([toolCall("register_movement", { ...LUNCH, amount: "twenty" })], "Sorry, what was the amount?");
		await say("lunch");
		const tool = chatCalls(mock)[1].json().messages.at(-1);
		expect(tool.content).toMatch(/invalid/i);
		expect(telegramCalls(mock, "sendMessage").every((c) => !c.json().reply_markup)).toBe(true);
	});

	it("list_recent_movements and get_balance call the finances API for this user", async () => {
		mockToolRound([toolCall("list_recent_movements", { limit: 5 }, "a"), toolCall("get_balance", {}, "b")], "Here you go.");
		await say("what did I spend lately?");
		expect(await financesCalls("listRecentMovements")).toEqual([{ method: "listRecentMovements", args: { tgUserId: 1001, limit: 5 } }]);
		expect(await financesCalls("getBalance")).toEqual([{ method: "getBalance", args: { tgUserId: 1001 } }]);
		const tools = chatCalls(mock)[1]
			.json()
			.messages.filter((m: any) => m.role === "tool");
		expect(tools.map((t: any) => t.tool_call_id)).toEqual(["a", "b"]);
		expect(tools[1].content).toContain("1000.00");
		expect(sentTexts(mock)).toEqual(["Here you go."]);
	});

	it("reports API errors to the model as tool errors instead of failing the message", async () => {
		await financesApi().__failNext("db down");
		mockToolRound([toolCall("get_balance", {})], "I couldn't get your balance right now.");
		const res = await say("balance?");
		expect(res.status).toBe(200);
		const tool = chatCalls(mock)[1].json().messages.at(-1);
		expect(tool.content).toMatch(/error/i);
		expect(tool.content).not.toContain("db down");
		expect(sentTexts(mock)).toEqual(["I couldn't get your balance right now."]);
	});

	it("stops after 5 tool rounds", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () =>
			jsonResponse(chatCompletion(null, { finish_reason: "tool_calls", tool_calls: [toolCall("get_balance", {})] })),
		);
		const res = await say("loop forever");
		expect(res.status).toBe(200);
		expect(chatCalls(mock)).toHaveLength(5);
		expect(sentTexts(mock)).toHaveLength(1);
	});

	it("stores tool rows and keeps them in later context", async () => {
		mockToolRound([toolCall("get_balance", {}, "bal")], "1000 VES");
		await say("balance?");
		mock.restore();
		mock = mockFetch();
		mockTelegram(mock);
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("ok")));
		await say("thanks");
		const roles = chatCalls(mock)[0]
			.json()
			.messages.map((m: any) => m.role);
		expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
	});
});

describe("context trimming with tool rows", () => {
	it("never starts the context with an orphan tool message", async () => {
		const stub = (env as any).AGENT_DO.getByName(String(chatId));
		await stub.clearChat();
		await runInDurableObject(stub, (_i, state: DurableObjectState) => {
			const sql = state.storage.sql;
			for (let i = 0; i < 20; i++) {
				sql.exec("INSERT INTO chat_messages (role, content) VALUES ('user', ?)", `u${i}`);
				sql.exec(
					"INSERT INTO chat_messages (role, content, tool_calls) VALUES ('assistant', NULL, ?)",
					JSON.stringify([{ id: `t${i}`, type: "function", function: { name: "get_balance", arguments: "{}" } }]),
				);
				sql.exec("INSERT INTO chat_messages (role, content, tool_call_id) VALUES ('tool', 'r', ?)", `t${i}`);
				sql.exec("INSERT INTO chat_messages (role, content) VALUES ('assistant', ?)", `a${i}`);
			}
		});
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("ok")));
		await stub.chat({ updateId: 1, text: "hi", source: "text", userId: 1001 });
		const messages = chatCalls(mock)[0].json().messages;
		expect(messages[1].role).not.toBe("tool");
		for (let i = 1; i < messages.length; i++) {
			if (messages[i].role === "tool") expect(messages[i - 1].role === "tool" || messages[i - 1].tool_calls).toBeTruthy();
		}
	});
});

describe("schema v3", () => {
	it("migrates a v2 chat without losing messages", async () => {
		const stub = (env as any).AGENT_DO.getByName(String(chatId));
		await runInDurableObject(stub, (_i, state: DurableObjectState) => {
			const sql = state.storage.sql;
			sql.exec("DROP TABLE IF EXISTS chat_messages");
			sql.exec("DROP TABLE IF EXISTS pending_movements");
			sql.exec("DROP TABLE IF EXISTS chat_state");
			sql.exec("DELETE FROM schema_migrations WHERE version > 1");
			sql.exec(`CREATE TABLE chat_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
				content TEXT NOT NULL,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
			sql.exec("INSERT INTO chat_messages (role, content) VALUES ('user', 'old u'), ('assistant', 'old a')");
		});
		await evictDurableObject(stub);
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("new a")));
		await stub.chat({ updateId: 2, text: "new u", source: "text", userId: 1001 });
		const rows = await runInDurableObject(stub, (_i, state: DurableObjectState) =>
			state.storage.sql.exec("SELECT role, content FROM chat_messages ORDER BY id").toArray(),
		);
		expect(rows.map((r: any) => r.content)).toEqual(["old u", "old a", "new u", "new a"]);
	});
});
