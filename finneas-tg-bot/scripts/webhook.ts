/**
 * Manage the bot's Telegram webhook.
 *
 *   node --env-file=.dev.vars scripts/webhook.ts set --url https://<tunnel>.trycloudflare.com
 *   node --env-file=.dev.vars scripts/webhook.ts info
 *   node --env-file=.dev.vars scripts/webhook.ts delete [--drop-pending-updates]
 *
 * Needs Node >= 22.18 (built-in TypeScript type stripping). The package scripts
 * `webhook:set|info|delete` wrap these commands.
 */
import { buildWebhookRequest, formatWebhookInfo, parseWebhookArgs, type WebhookInfo } from "./webhook-lib.ts";

async function main(): Promise<void> {
	const cmd = parseWebhookArgs(process.argv.slice(2));
	const { url, body } = buildWebhookRequest(cmd, process.env);
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
	if (!json.ok) throw new Error(`Telegram API error: ${json.description ?? res.status}`);
	if (cmd.command === "info") console.log(formatWebhookInfo(json.result as WebhookInfo));
	else console.log(`${cmd.command}: ${json.description ?? "ok"}`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
