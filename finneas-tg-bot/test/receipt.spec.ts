import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { mockFetch, jsonResponse, type FetchMock } from "./helpers/fetchMock";
import { chatCompletion, CHAT_PATH, OPENROUTER_HOST } from "./helpers/openrouter";
import { mockTelegram, photoUpdate, sentTexts, telegramCalls } from "./helpers/telegram";
import { callWorker, processRequest } from "./helpers/worker";
import { createOpenRouter } from "../src/lib/openrouter";
import { extractReceipt, normaliseReceipt, parseAmount, normaliseCurrency, normaliseDate, ModelReceiptSchema, receiptJsonSchema } from "../src/lib/receipt";

const raw = {
	receiving_bank: "Banesco",
	amount: "Bs. 1.234,56",
	currency: "Bs",
	transaction_id: "000123",
	date: "30/10/2026",
	time: "14:05",
	sender_name: null,
	recipient_name: "Ana",
	recipient_id: "V-12.345.678",
	recipient_phone: "04141234567",
	status: "success",
};

describe("parseAmount", () => {
	it.each([
		["Bs. 1.234,56", 1234.56],
		["1.234,56", 1234.56],
		["1,234.56", 1234.56],
		["$25.00", 25],
		["25", 25],
		["0,50", 0.5],
		["Bs 1.234.567,89", 1234567.89],
		["1.234", 1234],
		["12.5", 12.5],
	])("%s → %d", (input, expected) => {
		expect(parseAmount(input)).toBe(expected);
	});

	it("returns null for unparseable input", () => {
		expect(parseAmount("n/a")).toBeNull();
		expect(parseAmount(null)).toBeNull();
		expect(parseAmount("")).toBeNull();
	});
});

describe("normaliseCurrency / normaliseDate", () => {
	it("maps bolívar spellings to VES and dollar signs to USD", () => {
		for (const c of ["Bs", "Bs.", "BsS", "Bs.S", "bs", "VES", "VED", "Bs.D"]) expect(normaliseCurrency(c, null)).toBe("VES");
		for (const c of ["$", "USD", "usd", "US$"]) expect(normaliseCurrency(c, null)).toBe("USD");
		expect(normaliseCurrency("EUR", null)).toBe("EUR");
	});

	it("infers the currency from the amount when missing", () => {
		expect(normaliseCurrency(null, "Bs. 10,00")).toBe("VES");
		expect(normaliseCurrency(null, "$10")).toBe("USD");
		expect(normaliseCurrency(null, "10")).toBeNull();
	});

	it("normalises dates to YYYY-MM-DD", () => {
		expect(normaliseDate("2026-10-30")).toBe("2026-10-30");
		expect(normaliseDate("30/10/2026")).toBe("2026-10-30");
		expect(normaliseDate("30-10-2026")).toBe("2026-10-30");
		expect(normaliseDate("yesterday")).toBeNull();
	});
});

describe("receipt schema", () => {
	it("validates model output with ids and phones as strings", () => {
		expect(ModelReceiptSchema.safeParse(raw).success).toBe(true);
		expect(ModelReceiptSchema.safeParse({ ...raw, recipient_phone: 4141234567 }).success).toBe(false);
	});

	it("normalises into a typed receipt and keeps leading zeros", () => {
		expect(normaliseReceipt(ModelReceiptSchema.parse(raw))).toEqual({
			receiving_bank: "Banesco",
			amount: 1234.56,
			currency: "VES",
			transaction_id: "000123",
			date: "2026-10-30",
			time: "14:05",
			sender_name: null,
			recipient_name: "Ana",
			recipient_id: "V-12.345.678",
			recipient_phone: "04141234567",
			status: "success",
		});
	});

	it("exports a strict-compatible JSON schema (all properties required, no extras)", () => {
		const schema = receiptJsonSchema() as any;
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect([...schema.required].sort()).toEqual(Object.keys(raw).sort());
	});
});

describe("extractReceipt", () => {
	let mock: FetchMock;
	beforeEach(() => {
		mock = mockFetch();
	});
	afterEach(() => mock.restore());

	it("returns a normalised receipt", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(JSON.stringify(raw))));
		const res = await extractReceipt(createOpenRouter(env as any), new Uint8Array([1]).buffer);
		expect(res).toMatchObject({ ok: true, receipt: { amount: 1234.56, currency: "VES" } });
		expect(mock.calls[0].json().response_format.json_schema.name).toBe("receipt");
	});

	it("reports invalid JSON as a validation failure instead of throwing", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion("not json")));
		const res = await extractReceipt(createOpenRouter(env as any), new Uint8Array([1]).buffer);
		expect(res).toEqual({ ok: false, reason: "invalid_json" });
	});

	it("reports schema violations with the failing paths (not the values)", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(JSON.stringify({ ...raw, recipient_phone: 4141 }))));
		const res = await extractReceipt(createOpenRouter(env as any), new Uint8Array([1]).buffer);
		expect(res).toMatchObject({ ok: false, reason: "invalid_schema", issues: ["recipient_phone"] });
	});
});

describe("photo handler", () => {
	let mock: FetchMock;
	let logs: string[];
	beforeEach(() => {
		logs = [];
		vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(l));
		vi.spyOn(console, "error").mockImplementation((l: string) => void logs.push(l));
		mock = mockFetch();
		mockTelegram(mock);
	});
	afterEach(() => {
		mock.restore();
		vi.restoreAllMocks();
	});

	it("invalid model JSON gives a clear user message and a logged validation error", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(JSON.stringify({ amount: 5 }))));
		const res = await callWorker(await processRequest(photoUpdate()));
		expect(res.status).toBe(200);
		expect(sentTexts(mock).at(-1)).toMatch(/couldn.t read/i);
		const ev = logs.map((l) => JSON.parse(l)).find((e) => e.event === "receipt.invalid");
		expect(ev).toMatchObject({ reason: "invalid_schema" });
	});

	it("does not send a debug message with image dimensions", async () => {
		mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(JSON.stringify(raw))));
		await callWorker(await processRequest(photoUpdate()));
		expect(sentTexts(mock).join("\n")).not.toMatch(/Dimensions/);
	});

	it("rejects files over Telegram's 20 MB download limit without downloading them", async () => {
		await callWorker(await processRequest(photoUpdate({ fileSize: 21 * 1024 * 1024 })));
		expect(telegramCalls(mock, "getFile")).toHaveLength(0);
		expect(sentTexts(mock).at(-1)).toMatch(/too large/i);
	});
});
