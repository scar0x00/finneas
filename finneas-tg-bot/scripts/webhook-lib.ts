/**
 * Pure helpers for scripts/webhook.ts (no Node APIs, so they are unit-tested
 * in the Workers test pool).
 */
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

export type WebhookCommand =
	| { command: "set"; url: string; dropPending: boolean }
	| { command: "info"; dropPending: boolean }
	| { command: "delete"; dropPending: boolean };

const USAGE = "Usage: webhook <set --url <https-url> | info | delete> [--drop-pending-updates]";

export function parseWebhookArgs(argv: string[]): WebhookCommand {
	const [command, ...rest] = argv;
	let url: string | undefined;
	let dropPending = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--drop-pending-updates") dropPending = true;
		else if (arg === "--url") url = rest[++i];
		else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
		else throw new Error(`Unknown argument ${arg}. ${USAGE}`);
	}
	switch (command) {
		case "set":
			if (!url) throw new Error(`set needs --url. ${USAGE}`);
			return { command, url, dropPending };
		case "info":
		case "delete":
			return { command, dropPending };
		default:
			throw new Error(USAGE);
	}
}

export interface WebhookEnv {
	FINNEAS_BOT_TOKEN?: string;
	TELEGRAM_WEBHOOK_SECRET?: string;
}

export function buildWebhookRequest(cmd: WebhookCommand, env: WebhookEnv): { url: string; body: Record<string, unknown> } {
	if (!env.FINNEAS_BOT_TOKEN) throw new Error("FINNEAS_BOT_TOKEN is not set (pass --env-file=.dev.vars)");
	const api = `https://api.telegram.org/bot${env.FINNEAS_BOT_TOKEN}`;
	switch (cmd.command) {
		case "set": {
			if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET is not set; the Worker rejects webhooks without it");
			const target = new URL(cmd.url);
			if (target.protocol !== "https:") throw new Error("Telegram only delivers to https URLs (use a tunnel for local dev)");
			return {
				url: `${api}/setWebhook`,
				body: {
					url: target.href,
					secret_token: env.TELEGRAM_WEBHOOK_SECRET,
					allowed_updates: ALLOWED_UPDATES,
					drop_pending_updates: cmd.dropPending,
				},
			};
		}
		case "info":
			return { url: `${api}/getWebhookInfo`, body: {} };
		case "delete":
			return { url: `${api}/deleteWebhook`, body: { drop_pending_updates: cmd.dropPending } };
	}
}

export interface WebhookInfo {
	url: string;
	pending_update_count: number;
	last_error_date?: number;
	last_error_message?: string;
	allowed_updates?: string[];
	max_connections?: number;
}

export function formatWebhookInfo(info: WebhookInfo): string {
	const lines = [`URL: ${info.url || "(not set)"}`, `Pending updates: ${info.pending_update_count}`];
	if (info.allowed_updates) lines.push(`Allowed updates: ${info.allowed_updates.join(", ")}`);
	if (info.last_error_date) {
		lines.push(`Last error: ${new Date(info.last_error_date * 1000).toISOString()} ${info.last_error_message ?? ""}`.trimEnd());
	} else {
		lines.push("Last error: none");
	}
	return lines.join("\n");
}
