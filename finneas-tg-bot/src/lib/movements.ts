import type { NewMovement, NewMovementType } from "finneas-finances-api/contract";
import { z } from "zod";
import type { Receipt } from "./receipt";
import { escapeHtml } from "./telegram";

/** A movement waiting for the user's explicit confirmation (Save button). */
export interface MovementDraft {
	type: NewMovementType;
	/** Decimal string, or null when unknown (then it cannot be saved). */
	amount: string | null;
	currency: string | null;
	/** YYYY-MM-DD or YYYY-MM-DDTHH:MM */
	madeAt: string | null;
	counterpartyName: string | null;
	description: string | null;
	reference: string | null;
	providerHint: string | null;
}

export type PendingKind = "receipt" | "proposal";
export type PendingStatus = "pending" | "saved" | "discarded";

export interface PendingMovement {
	id: string;
	kind: PendingKind;
	status: PendingStatus;
	draft: MovementDraft;
	/** Only for receipts: the normalised receipt, kept so it can be edited. */
	receipt: Receipt | null;
	movementId: string | null;
}

/** What the bot needs to show a pending movement with its buttons. */
export interface PendingView {
	id: string;
	kind: PendingKind;
	html: string;
	canSave: boolean;
}

export function draftFromReceipt(r: Receipt): MovementDraft {
	return {
		type: "egress",
		amount: r.amount === null ? null : String(r.amount),
		currency: r.currency,
		madeAt: r.date ? (r.time && /^\d{1,2}:\d{2}/.test(r.time) ? `${r.date}T${r.time.slice(0, 5).padStart(5, "0")}` : r.date) : null,
		counterpartyName: r.recipient_name,
		description: null,
		reference: r.transaction_id,
		providerHint: r.receiving_bank,
	};
}

/** Amount, currency and date must be known before anything can be saved. */
export function canSave(d: MovementDraft): boolean {
	return Boolean(d.amount && d.currency && d.madeAt);
}

export function toNewMovement(d: MovementDraft, opts: { idempotencyKey: string; tgUserId: number }): NewMovement {
	if (!canSave(d)) throw new Error("Draft is incomplete");
	return {
		idempotencyKey: opts.idempotencyKey,
		tgUserId: opts.tgUserId,
		type: d.type,
		amount: d.amount!,
		currency: d.currency!,
		madeAt: d.madeAt!,
		counterpartyName: d.counterpartyName,
		description: d.description,
		reference: d.reference,
		providerHint: d.providerHint,
		source: "telegram_bot",
	};
}

export function formatAmount(amount: string | null, currency: string | null): string {
	if (!amount) return "N/A";
	const decimals = amount.split(".")[1]?.length ?? 0;
	const shown = decimals <= 2 ? Number(amount).toFixed(2) : amount;
	return `${shown} ${currency ?? ""}`.trim();
}

/** One-line description for the chat history note. */
export function describeDraft(d: MovementDraft): string {
	const who = d.counterpartyName ? ` ${d.type === "income" ? "from" : "to"} ${d.counterpartyName}` : "";
	return `${formatAmount(d.amount, d.currency)}${who} on ${d.madeAt ?? "unknown date"}`;
}

export function formatDraftHtml(d: MovementDraft): string {
	return [
		"📝 <b>New movement</b>",
		"",
		`• <b>Type:</b> ${d.type === "income" ? "Income" : "Expense"}`,
		`• <b>Amount:</b> ${escapeHtml(formatAmount(d.amount, d.currency))}`,
		`• <b>Date:</b> ${escapeHtml(d.madeAt ?? "N/A")}`,
		`• <b>Counterparty:</b> ${escapeHtml(d.counterpartyName ?? "N/A")}`,
		`• <b>Description:</b> ${escapeHtml(d.description ?? "N/A")}`,
	].join("\n");
}

/** Arguments the model must provide to `register_movement`. */
export const RegisterMovementArgs = z
	.object({
		type: z.enum(["egress", "income"]),
		amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal like 20 or 12.50"),
		currency: z
			.string()
			.regex(/^[A-Za-z]{3,6}$/)
			.transform((c) => c.toUpperCase()),
		made_at: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "made_at must be YYYY-MM-DD"),
		counterparty: z.string().min(1).nullable(),
		description: z.string().nullable(),
	})
	.strict();

export function draftFromToolArgs(a: z.infer<typeof RegisterMovementArgs>): MovementDraft {
	return {
		type: a.type,
		amount: a.amount,
		currency: a.currency,
		madeAt: a.made_at,
		counterpartyName: a.counterparty,
		description: a.description,
		reference: null,
		providerHint: null,
	};
}
