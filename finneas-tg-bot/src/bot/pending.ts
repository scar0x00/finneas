import { InlineKeyboard } from "grammy";
import type { PendingView } from "../lib/movements";

/** callback_data is limited to 64 bytes, so it carries only `p:<id>:<action>`. */
export const CALLBACK_PATTERN = /^p:([a-z0-9]{1,32}):(save|edit|discard)$/;

export function pendingKeyboard(view: PendingView): InlineKeyboard {
	const kb = new InlineKeyboard();
	if (view.canSave) kb.text("✅ Save", `p:${view.id}:save`);
	if (view.kind === "receipt") kb.text("✏️ Edit", `p:${view.id}:edit`);
	kb.text("🗑 Discard", `p:${view.id}:discard`);
	return kb;
}

export function pendingFooter(view: PendingView): string {
	return view.canSave ? "" : "\n\n⚠️ Amount, currency or date is missing. Tap Edit to fix it.";
}
