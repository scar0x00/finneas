import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import type { ChatMessage } from "../types/Chat";
import { SYSTEM } from "../SYSTEM_PROMPT";
import { runOpenrouterModel } from "./runOpenrouterModel";

export const DEFAULT_CHAT_MODEL = "google/gemini-3.1-flash-lite";
export const DEFAULT_MAX_CONTEXT_MESSAGES = 30;

export interface ChatInput {
	/** Telegram update id; makes the call idempotent. */
	updateId: number;
	text: string;
	source: "text" | "voice";
}

export type ChatResult = { answer: string; duplicate: false } | { answer: string; duplicate: true; replied: boolean };

/**
 * Ordered schema migrations. Index i migrates from version i to i + 1.
 * Never edit a released migration; append a new one.
 */
const MIGRATIONS: ((sql: SqlStorage) => void)[] = [
	// v1: the original table.
	(sql) => {
		sql.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
			content TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
	},
	// v2: idempotency + usage columns; the system prompt now lives in code.
	(sql) => {
		sql.exec("ALTER TABLE chat_messages ADD COLUMN update_id INTEGER");
		sql.exec("ALTER TABLE chat_messages ADD COLUMN model TEXT");
		sql.exec("ALTER TABLE chat_messages ADD COLUMN prompt_tokens INTEGER");
		sql.exec("ALTER TABLE chat_messages ADD COLUMN completion_tokens INTEGER");
		sql.exec("ALTER TABLE chat_messages ADD COLUMN source TEXT");
		sql.exec("ALTER TABLE chat_messages ADD COLUMN replied_at DATETIME");
		sql.exec("CREATE INDEX IF NOT EXISTS chat_messages_update_id ON chat_messages (update_id)");
		sql.exec("DELETE FROM chat_messages WHERE role = 'system'");
	},
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * One Durable Object per Telegram chat (`getByName(chatId)`), holding the chat
 * history in SQLite. All model calls for a chat run one at a time.
 */
export class AgentDO extends DurableObject<Env> {
	/** Serialises `chat()` calls; see `chat()`. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (!this.ctx.id.name) {
			throw new Error("You must provide a name to use this DO");
		}
		this.ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private migrate(): void {
		const sql = this.ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
		let current = (sql.exec("SELECT MAX(version) AS v FROM schema_migrations").one().v as number | null) ?? 0;
		// DOs created before migrations existed already have the v1 table.
		if (current === 0 && sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'").toArray().length > 0) {
			sql.exec("INSERT INTO schema_migrations (version) VALUES (1)");
			current = 1;
		}
		for (let v = current; v < MIGRATIONS.length; v++) {
			this.ctx.storage.transactionSync(() => {
				MIGRATIONS[v](sql);
				sql.exec("INSERT INTO schema_migrations (version) VALUES (?)", v + 1);
			});
		}
	}

	private get chatModel(): string {
		return this.env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
	}

	private get maxContextMessages(): number {
		const n = Number(this.env.MAX_CONTEXT_MESSAGES);
		return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONTEXT_MESSAGES;
	}

	/**
	 * Answers one user message. Calls are queued so that two messages sent close
	 * together run one after the other and the second sees the first exchange.
	 * (Awaiting `fetch` would otherwise let the next request into the object.)
	 */
	chat(input: ChatInput): Promise<ChatResult> {
		const run = this.queue.then(() => this.doChat(input));
		this.queue = run.catch(() => {});
		return run;
	}

	private async doChat({ updateId, text, source }: ChatInput): Promise<ChatResult> {
		const sql = this.ctx.storage.sql;

		const existing = sql
			.exec("SELECT content, replied_at FROM chat_messages WHERE update_id = ? AND role = 'assistant' LIMIT 1", updateId)
			.toArray();
		if (existing.length > 0) {
			return { answer: existing[0].content as string, duplicate: true, replied: existing[0].replied_at !== null };
		}

		const recent = sql
			.exec("SELECT role, content FROM chat_messages WHERE role IN ('user', 'assistant') ORDER BY id DESC LIMIT ?", this.maxContextMessages - 1)
			.toArray()
			.reverse() as unknown as ChatMessage[];

		const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }, ...recent, { role: "user", content: text }];

		const response = await runOpenrouterModel({
			OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
			messages,
			model: this.chatModel,
			logFields: { chat_id: Number(this.ctx.id.name), update_id: updateId, context_messages: messages.length },
		});

		// Both rows are written together, and only after the model succeeded.
		this.ctx.storage.transactionSync(() => {
			sql.exec("INSERT INTO chat_messages (role, content, update_id, source) VALUES ('user', ?, ?, ?)", text, updateId, source);
			sql.exec(
				"INSERT INTO chat_messages (role, content, update_id, model, prompt_tokens, completion_tokens) VALUES ('assistant', ?, ?, ?, ?, ?)",
				response.answer,
				updateId,
				response.model ?? null,
				response.usage?.prompt_tokens ?? null,
				response.usage?.completion_tokens ?? null,
			);
		});

		return { answer: response.answer, duplicate: false };
	}

	/** Records that the answer for `updateId` reached the user, so a redelivery is not re-sent. */
	async markReplied(updateId: number): Promise<void> {
		this.ctx.storage.sql.exec("UPDATE chat_messages SET replied_at = CURRENT_TIMESTAMP WHERE update_id = ? AND role = 'assistant'", updateId);
	}

	async clearChat(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM chat_messages");
	}
}
