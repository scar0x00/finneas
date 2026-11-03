import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FetchMock, jsonResponse, mockFetch } from "./helpers/fetchMock";
import { financesApi, financesCalls } from "./helpers/finances";
import { CHAT_PATH, chatCalls, chatCompletion, mockChat, OPENROUTER_HOST } from "./helpers/openrouter";
import { mockQStashPublish, publishCalls } from "./helpers/qstashApi";
import { callbackQueryUpdate, mockTelegram, photoUpdate, sentTexts, telegramCalls, textUpdate } from "./helpers/telegram";
import { callWorker, processRequest, webhookRequest } from "./helpers/worker";

const RAW = {
	receiving_bank: "Banesco",
	amount: "Bs. 1.234,56",
	currency: "Bs",
	transaction_id: "000123",
	date: "30/10/2026",
	time: "14:05",
	sender_name: null,
	recipient_name: "Ana_Maria",
	recipient_id: "V-12345678",
	recipient_phone: "04141234567",
	status: "success",
};

let mock: FetchMock;
let chatSeq = 0;
let chatId: number;

beforeEach(async () => {
	chatId = 3_000_000 + chatSeq++;
	mock = mockFetch();
	mockTelegram(mock);
	mockQStashPublish(mock);
	await financesApi().__reset();
});
afterEach(() => mock.restore());

function mockVision(receipt: Record<string, unknown> = RAW) {
	mock.on(OPENROUTER_HOST, CHAT_PATH, (call) => {
		const body = call.json();
		if (body.response_format) return jsonResponse(chatCompletion(JSON.stringify(receipt)));
		return jsonResponse(chatCompletion(`echo: ${body.messages.at(-1).content}`));
	});
}

/** Sends a receipt photo and returns the pending id and the bot message carrying the keyboard. */
async function sendReceipt(receipt: Record<string, unknown> = RAW) {
	mockVision(receipt);
	await callWorker(await processRequest(photoUpdate({ chatId, userId: 1001 })));
	const msg = telegramCalls(mock, "sendMessage")
		.map((c) => c.json())
		.find((m) => m.reply_markup);
	expect(msg).toBeDefined();
	const buttons = msg.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
	const save = buttons.find((b) => b.callback_data.endsWith(":save"));
	const id = buttons[0].callback_data.split(":")[1];
	return { msg, buttons, save, id };
}

const tap = async (data: string, messageId = 5000) =>
	callWorker(await processRequest(callbackQueryUpdate(data, { chatId, userId: 1001, messageId })));

const callbackAnswers = () => telegramCalls(mock, "answerCallbackQuery").map((c) => c.json().text ?? "");
const edits = () => telegramCalls(mock, "editMessageText").map((c) => c.json());

describe("receipt confirmation flow", () => {
	it("shows the receipt with Save, Edit and Discard buttons whose callback data fits Telegram's 64 bytes", async () => {
		const { msg, buttons } = await sendReceipt();
		expect(msg.parse_mode).toBe("HTML");
		expect(buttons.map((b) => b.callback_data.split(":")[2])).toEqual(["save", "edit", "discard"]);
		for (const b of buttons) {
			expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
			expect(b.callback_data).toMatch(/^p:[a-z0-9]+:(save|edit|discard)$/);
		}
		expect(await financesCalls()).toEqual([]);
	});

	it("Save creates exactly one movement with source telegram_bot and marks the message saved", async () => {
		const { save, id } = await sendReceipt();
		const res = await tap(save!.callback_data);
		expect(res.status).toBe(200);

		const creates = await financesCalls("createMovement");
		expect(creates).toHaveLength(1);
		expect(creates[0].args).toEqual({
			idempotencyKey: `pending:${chatId}:${id}`,
			tgUserId: 1001,
			type: "egress",
			amount: "1234.56",
			currency: "VES",
			madeAt: "2026-10-30T14:05",
			counterpartyName: "Ana_Maria",
			description: null,
			reference: "000123",
			providerHint: "Banesco",
			source: "telegram_bot",
		});
		const [edit] = edits();
		expect(edit.chat_id).toBe(chatId);
		expect(edit.message_id).toBe(5000);
		expect(edit.text).toMatch(/Saved ✓/);
		expect(edit.reply_markup).toBeUndefined();
		expect(callbackAnswers()).toHaveLength(1);
	});

	it("a duplicate Save tap does not create a second movement", async () => {
		const { save } = await sendReceipt();
		await tap(save!.callback_data);
		await tap(save!.callback_data);
		expect(await financesCalls("createMovement")).toHaveLength(1);
		expect(callbackAnswers().at(-1)).toMatch(/already saved/i);
	});

	it("records a note in the chat history so follow-ups have context", async () => {
		const { save } = await sendReceipt();
		await tap(save!.callback_data);
		mockChat(mock, "ok");
		await callWorker(await processRequest(textUpdate("that was for rent", { chatId })));
		const context = chatCalls(mock)
			.at(-1)!
			.json()
			.messages.map((m: any) => m.content)
			.join("\n");
		expect(context).toMatch(/saved as movement 1/i);
		expect(context).toContain("1234.56 VES");
	});

	it("Discard removes the pending receipt without calling the API", async () => {
		const { buttons, save } = await sendReceipt();
		await tap(buttons.find((b) => b.callback_data.endsWith(":discard"))!.callback_data);
		expect(edits()[0].text).toMatch(/Discarded/);
		await tap(save!.callback_data);
		expect(await financesCalls("createMovement")).toHaveLength(0);
		expect(callbackAnswers().at(-1)).toMatch(/no longer available/i);
	});

	it("answers unknown or malformed callback data without side effects", async () => {
		await tap("p:doesnotexist:save");
		await tap("garbage");
		expect(await financesCalls()).toEqual([]);
		expect(callbackAnswers()).toHaveLength(2);
	});

	it("keeps the receipt pending when the API fails so the user can retry", async () => {
		const { save } = await sendReceipt();
		await financesApi().__failNext("db down");
		await tap(save!.callback_data);
		expect(callbackAnswers().at(-1)).toMatch(/couldn.t save/i);
		expect(callbackAnswers().at(-1)).not.toContain("db down");
		await tap(save!.callback_data);
		expect((await financesApi().__movements()).length).toBe(1);
	});

	it("offers no Save button when amount or currency is missing", async () => {
		const { buttons } = await sendReceipt({ ...RAW, amount: null });
		expect(buttons.map((b) => b.callback_data.split(":")[2])).toEqual(["edit", "discard"]);
	});

	it("Edit asks what to change, revises the receipt from the user's reply and shows it again", async () => {
		const { buttons } = await sendReceipt();
		await tap(buttons.find((b) => b.callback_data.endsWith(":edit"))!.callback_data);
		expect(sentTexts(mock).at(-1)).toMatch(/what should i change/i);

		mock.restore();
		mock = mockFetch();
		mockTelegram(mock);
		mock.on(OPENROUTER_HOST, CHAT_PATH, (call) => {
			const body = call.json();
			expect(body.response_format?.json_schema?.name).toBe("receipt");
			expect(JSON.stringify(body.messages)).toContain("the amount was 1.500,00");
			return jsonResponse(chatCompletion(JSON.stringify({ ...RAW, amount: "Bs. 1.500,00" })));
		});
		await callWorker(await processRequest(textUpdate("the amount was 1.500,00", { chatId })));
		const revised = telegramCalls(mock, "sendMessage")
			.map((c) => c.json())
			.find((m) => m.reply_markup);
		expect(revised.text).toContain("1500.00 VES");
		const save = revised.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data.endsWith(":save"));
		await tap(save.callback_data);
		const [create] = await financesCalls("createMovement");
		expect(create.args.amount).toBe("1500");
	});

	it("without the FINANCES_API binding the receipt is shown without buttons", async () => {
		mockVision();
		await callWorker(await processRequest(photoUpdate({ chatId })), { FINANCES_API: undefined });
		const msgs = telegramCalls(mock, "sendMessage").map((c) => c.json());
		expect(msgs.at(-1).text).toContain("Transaction details");
		expect(msgs.every((m) => !m.reply_markup)).toBe(true);
	});
});

describe("callback queries through the webhook", () => {
	it("publishes callback queries from allowed users", async () => {
		const res = await callWorker(webhookRequest(callbackQueryUpdate("p:abc:save", { userId: 1001 })));
		expect(res.status).toBe(200);
		expect(publishCalls(mock)).toHaveLength(1);
	});
});
