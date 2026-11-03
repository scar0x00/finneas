import { z } from "zod";
import type { OpenRouter } from "./openrouter";
import { escapeHtml } from "./telegram";
import type { LogFields } from "./log";

/**
 * What the vision model returns: everything as printed on the receipt, as strings.
 * Ids and phone numbers stay strings (leading zeros matter). Amount, currency and
 * date are normalised in code (`normaliseReceipt`), not in the prompt.
 */
export const ModelReceiptSchema = z
	.object({
		receiving_bank: z.string().nullable(),
		amount: z.string().nullable().describe("Amount exactly as printed, including currency symbol and separators, e.g. 'Bs. 1.234,56'"),
		currency: z.string().nullable().describe("Currency as printed or ISO 4217 code, e.g. 'Bs', 'USD'"),
		transaction_id: z.string().nullable(),
		date: z.string().nullable().describe("Date as printed"),
		time: z.string().nullable(),
		sender_name: z.string().nullable(),
		recipient_name: z.string().nullable(),
		recipient_id: z.string().nullable().describe("National id (cédula/RIF) as printed"),
		recipient_phone: z.string().nullable().describe("Phone number as printed, keep leading zeros"),
		status: z.enum(["success", "pending", "failed"]).nullable(),
	})
	.strict();

export type ModelReceipt = z.infer<typeof ModelReceiptSchema>;

export const ReceiptSchema = z.object({
	receiving_bank: z.string().nullable(),
	amount: z.number().nullable(),
	/** ISO 4217 */
	currency: z.string().length(3).nullable(),
	transaction_id: z.string().nullable(),
	/** YYYY-MM-DD */
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
	time: z.string().nullable(),
	sender_name: z.string().nullable(),
	recipient_name: z.string().nullable(),
	recipient_id: z.string().nullable(),
	recipient_phone: z.string().nullable(),
	status: z.enum(["success", "pending", "failed"]).nullable(),
});

export type Receipt = z.infer<typeof ReceiptSchema>;

/** JSON Schema sent as `response_format` (strict: every key required, no extras). */
export function receiptJsonSchema(): Record<string, unknown> {
	const { $schema: _ignored, ...schema } = z.toJSONSchema(ModelReceiptSchema) as Record<string, unknown>;
	return schema;
}

const BOLIVAR = /\b(bs\.?\s*[sd]?|ves|ved|bol[ií]vares?)\b|bs\./i;
const DOLLAR = /\$|\busd\b|\bus\$/i;

/**
 * Parses amounts as printed on Venezuelan and US receipts:
 * "Bs. 1.234,56" → 1234.56, "1,234.56" → 1234.56, "0,50" → 0.5.
 */
export function parseAmount(input: string | null | undefined): number | null {
	if (!input) return null;
	const isBolivar = BOLIVAR.test(input);
	const s = input.replace(/[^\d.,-]/g, "");
	if (!/\d/.test(s)) return null;
	const lastDot = s.lastIndexOf(".");
	const lastComma = s.lastIndexOf(",");
	let normalised: string;
	if (lastDot !== -1 && lastComma !== -1) {
		// Whichever separator comes last is the decimal one.
		normalised = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
	} else if (lastComma !== -1) {
		const decimals = s.length - lastComma - 1;
		normalised = (s.match(/,/g)!.length === 1 && decimals !== 3) || decimals <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
	} else if (lastDot !== -1) {
		const dots = s.match(/\./g)!.length;
		const decimals = s.length - lastDot - 1;
		// "1.234.567" is grouping; "1.234" is grouping on bolívar receipts or when there is no other reading.
		normalised = dots > 1 || (decimals === 3 && (isBolivar || !s.startsWith("0"))) ? s.replace(/\./g, "") : s;
	} else {
		normalised = s;
	}
	const n = Number(normalised);
	return Number.isFinite(n) ? n : null;
}

/** Maps printed currency spellings to ISO 4217, falling back to symbols in the amount. */
export function normaliseCurrency(currency: string | null | undefined, amount: string | null | undefined): string | null {
	const c = (currency ?? "").trim();
	if (c) {
		if (BOLIVAR.test(c) || /^bs/i.test(c)) return "VES";
		if (DOLLAR.test(c)) return "USD";
		if (/^[a-z]{3}$/i.test(c)) return c.toUpperCase();
	}
	if (amount) {
		if (BOLIVAR.test(amount)) return "VES";
		if (DOLLAR.test(amount)) return "USD";
	}
	return null;
}

/** "2026-10-30", "30/10/2026" or "30-10-2026" → "2026-10-30" (receipts use day-first dates). */
export function normaliseDate(date: string | null | undefined): string | null {
	if (!date) return null;
	const d = date.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
	const m = d.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
	if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
	return null;
}

export function normaliseReceipt(r: ModelReceipt): Receipt {
	return ReceiptSchema.parse({
		...r,
		amount: parseAmount(r.amount),
		currency: normaliseCurrency(r.currency, r.amount),
		date: normaliseDate(r.date),
		recipient_phone: r.recipient_phone?.replace(/[^\d+]/g, "") || null,
	});
}

export type ExtractResult = { ok: true; receipt: Receipt } | { ok: false; reason: "empty" | "invalid_json" | "invalid_schema"; issues?: string[] };

const PROMPT = `You are a financial receipt parser. Extract the bank transaction shown in this image.
Most receipts are from Venezuelan banks. If the image shows only one person's name, it is most likely the recipient, not the sender.
Copy values exactly as printed (amounts with their symbols and separators, dates as shown). Use null for anything not visible.`;

/** Reads a receipt image. Never throws for bad model output; returns a reason instead. */
export async function extractReceipt(openrouter: OpenRouter, image: ArrayBuffer, logFields: LogFields = {}): Promise<ExtractResult> {
	const res = await openrouter.vision({ prompt: PROMPT, image, schemaName: "receipt", schema: receiptJsonSchema(), logFields });
	if (!res.content) return { ok: false, reason: "empty" };
	let json: unknown;
	try {
		json = JSON.parse(res.content);
	} catch {
		return { ok: false, reason: "invalid_json" };
	}
	const parsed = ModelReceiptSchema.safeParse(json);
	if (!parsed.success) {
		return { ok: false, reason: "invalid_schema", issues: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))] };
	}
	return { ok: true, receipt: normaliseReceipt(parsed.data) };
}

function field(value: unknown): string {
	return value === null || value === undefined || value === "" ? "N/A" : escapeHtml(value);
}

/** Receipt summary for Telegram's HTML parse mode. Every model value is escaped. */
export function formatReceiptHtml(r: Receipt): string {
	const amount = r.amount === null ? "N/A" : `${escapeHtml(r.amount.toFixed(2))} ${escapeHtml(r.currency ?? "")}`.trim();
	const when = [r.date, r.time].filter(Boolean).map(escapeHtml).join(" ") || "N/A";
	return [
		"🧾 <b>Transaction details</b>",
		"",
		`• <b>Bank:</b> ${field(r.receiving_bank)}`,
		`• <b>Amount:</b> ${amount}`,
		`• <b>Recipient:</b> ${field(r.recipient_name)}`,
		`• <b>Recipient ID:</b> ${field(r.recipient_id)}`,
		`• <b>Recipient phone:</b> ${field(r.recipient_phone)}`,
		`• <b>Sender:</b> ${field(r.sender_name)}`,
		`• <b>Date &amp; time:</b> ${when}`,
		`• <b>Ref / ID:</b> <code>${field(r.transaction_id)}</code>`,
		`• <b>Status:</b> ${field(r.status)}`,
	].join("\n");
}
