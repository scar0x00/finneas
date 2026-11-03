import { escapeHtml } from "./telegram";

export type ExtractedReceipt = Record<string, unknown>;

function field(value: unknown): string {
	return value === null || value === undefined || value === "" ? "N/A" : escapeHtml(value);
}

/** Receipt summary for Telegram's HTML parse mode. Every model value is escaped. */
export function formatReceiptHtml(r: ExtractedReceipt): string {
	const amount = [r.amount, r.currency].filter((v) => v !== null && v !== undefined && v !== "").map(escapeHtml).join(" ") || "N/A";
	const when = [r.date, r.time].filter((v) => v !== null && v !== undefined && v !== "").map(escapeHtml).join(" ") || "N/A";
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
