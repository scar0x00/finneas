import { DurableObject } from "cloudflare:workers";
import { systemPrompt } from "../SYSTEM_PROMPT";
import {
	canSave,
	describeDraft,
	draftFromReceipt,
	formatDraftHtml,
	type MovementDraft,
	type PendingKind,
	type PendingMovement,
	type PendingStatus,
	type PendingView,
} from "./movements";
import { type ChatMessage, type ChatResponse, createOpenRouter, type ToolCall } from "./openrouter";
import { formatReceiptHtml, type Receipt } from "./receipt";
import { MAX_TOOL_ROUNDS, runTool, TOOL_DEFINITIONS } from "./tools";

export const DEFAULT_MAX_CONTEXT_MESSAGES = 30;

export interface ChatInput {
	/** Telegram update id; makes the call idempotent. */
	updateId: number;
	text: string;
	source: "text" | "voice";
	/** Telegram user id; needed for the finances tools. Without it no tools are offered. */
	userId?: number;
}

export type ChatResult =
	| { answer: string; duplicate: false; proposals: PendingView[] }
	| { answer: string; duplicate: true; replied: boolean; proposals: PendingView[] };

const TOOL_LOOP_FALLBACK = "Sorry, I couldn't finish that. Could you rephrase or split it into smaller steps?";

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
	// v3: tool calls (#20) and pending movements awaiting confirmation. SQLite cannot
	// change a CHECK constraint, so chat_messages is rebuilt. 'system' rows are now
	// short notes (e.g. "receipt saved as movement 12"), never the prompt.
	(sql) => {
		sql.exec(`CREATE TABLE chat_messages_v3 (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
			content TEXT,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			update_id INTEGER,
			model TEXT,
			prompt_tokens INTEGER,
			completion_tokens INTEGER,
			source TEXT,
			replied_at DATETIME,
			tool_calls TEXT,
			tool_call_id TEXT
		)`);
		sql.exec(`INSERT INTO chat_messages_v3 (id, role, content, created_at, update_id, model, prompt_tokens, completion_tokens, source, replied_at)
			SELECT id, role, content, created_at, update_id, model, prompt_tokens, completion_tokens, source, replied_at FROM chat_messages`);
		sql.exec("DROP TABLE chat_messages");
		sql.exec("ALTER TABLE chat_messages_v3 RENAME TO chat_messages");
		sql.exec("CREATE INDEX IF NOT EXISTS chat_messages_update_id ON chat_messages (update_id)");
		sql.exec(`CREATE TABLE IF NOT EXISTS pending_movements (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('receipt', 'proposal')),
			status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'discarded')),
			draft TEXT NOT NULL,
			receipt TEXT,
			movement_id TEXT,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		sql.exec("CREATE TABLE IF NOT EXISTS chat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	},
];

export const SCHEMA_VERSION = MIGRATIONS.length;

type Row = Record<string, SqlStorageValue>;

function newPendingId(): string {
	// 10 base-36 chars: short enough for callback_data, unique enough per chat.
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-2);
}

/** Turns stored rows into model messages. */
function toMessage(r: Row): ChatMessage {
	const m: ChatMessage = { role: r.role as ChatMessage["role"], content: (r.content as string | null) ?? null };
	if (r.tool_calls) m.tool_calls = JSON.parse(r.tool_calls as string) as ToolCall[];
	if (r.tool_call_id) m.tool_call_id = r.tool_call_id as string;
	return m;
}

/**
 * One Durable Object per Telegram chat (`getByName(chatId)`), holding the chat
 * history and pending movements in SQLite. All model calls for a chat run one at a time.
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
		sql.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
		);
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

	private get chatId(): number {
		return Number(this.ctx.id.name);
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

	/** The last stored messages, never starting with an orphan `tool` message. */
	private context(): ChatMessage[] {
		const rows = this.ctx.storage.sql
			.exec("SELECT role, content, tool_calls, tool_call_id FROM chat_messages ORDER BY id DESC LIMIT ?", this.maxContextMessages - 1)
			.toArray()
			.reverse();
		while (rows.length > 0 && rows[0].role === "tool") rows.shift();
		return rows.map(toMessage);
	}

	private async doChat({ updateId, text, source, userId }: ChatInput): Promise<ChatResult> {
		const sql = this.ctx.storage.sql;

		const existing = sql
			.exec(
				"SELECT content, replied_at FROM chat_messages WHERE update_id = ? AND role = 'assistant' AND tool_calls IS NULL LIMIT 1",
				updateId,
			)
			.toArray();
		if (existing.length > 0) {
			return { answer: existing[0].content as string, duplicate: true, replied: existing[0].replied_at !== null, proposals: [] };
		}

		const api = this.env.FINANCES_API;
		const toolsEnabled = Boolean(api && userId);
		const openrouter = createOpenRouter(this.env);
		const history = this.context();
		const userMessage: ChatMessage = { role: "user", content: text };
		const turn: ChatMessage[] = [];
		const turnUsage: (ChatResponse | null)[] = [];
		const proposals: { id: string; draft: MovementDraft }[] = [];
		let answer: string | null = null;
		let last: ChatResponse | null = null;

		for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
			last = await openrouter.chat({
				messages: [{ role: "system", content: systemPrompt() }, ...history, userMessage, ...turn],
				tools: toolsEnabled ? TOOL_DEFINITIONS : undefined,
				logFields: { chat_id: this.chatId, update_id: updateId, round, context_messages: history.length + turn.length + 2 },
			});
			if (last.toolCalls.length === 0 || !toolsEnabled) {
				answer = last.content ?? "";
				break;
			}
			if (round === MAX_TOOL_ROUNDS) break;
			turn.push({ role: "assistant", content: last.content, tool_calls: last.toolCalls });
			turnUsage.push(last);
			for (const call of last.toolCalls) {
				const content = await runTool(call, {
					api: api!,
					tgUserId: userId!,
					chatId: this.chatId,
					propose: (draft) => {
						const id = newPendingId();
						proposals.push({ id, draft });
						return id;
					},
				});
				turn.push({ role: "tool", content, tool_call_id: call.id });
				turnUsage.push(null);
			}
		}
		if (answer === null || answer === "") answer = answer || TOOL_LOOP_FALLBACK;

		// Everything for this turn is written together, and only after the model succeeded.
		this.ctx.storage.transactionSync(() => {
			sql.exec("INSERT INTO chat_messages (role, content, update_id, source) VALUES ('user', ?, ?, ?)", text, updateId, source);
			turn.forEach((m, i) => {
				const usage = turnUsage[i];
				sql.exec(
					"INSERT INTO chat_messages (role, content, update_id, model, prompt_tokens, completion_tokens, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					m.role,
					m.content,
					updateId,
					usage?.model ?? null,
					usage?.usage?.prompt_tokens ?? null,
					usage?.usage?.completion_tokens ?? null,
					m.tool_calls ? JSON.stringify(m.tool_calls) : null,
					m.tool_call_id ?? null,
				);
			});
			sql.exec(
				"INSERT INTO chat_messages (role, content, update_id, model, prompt_tokens, completion_tokens) VALUES ('assistant', ?, ?, ?, ?, ?)",
				answer,
				updateId,
				last?.model ?? null,
				last?.usage?.prompt_tokens ?? null,
				last?.usage?.completion_tokens ?? null,
			);
			for (const p of proposals) this.insertPending(p.id, "proposal", p.draft, null);
		});

		return { answer, duplicate: false, proposals: proposals.map((p) => this.view(p.id, "proposal", p.draft, null)) };
	}

	/** Records that the answer for `updateId` reached the user, so a redelivery is not re-sent. */
	async markReplied(updateId: number): Promise<void> {
		this.ctx.storage.sql.exec(
			"UPDATE chat_messages SET replied_at = CURRENT_TIMESTAMP WHERE update_id = ? AND role = 'assistant'",
			updateId,
		);
	}

	async clearChat(): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM chat_messages");
			this.ctx.storage.sql.exec("DELETE FROM chat_state");
			this.ctx.storage.sql.exec(
				"UPDATE pending_movements SET status = 'discarded', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending'",
			);
		});
	}

	// ---------------------------------------------------------------------------
	// Pending movements (receipts and agent proposals awaiting the Save button)
	// ---------------------------------------------------------------------------

	private insertPending(id: string, kind: PendingKind, draft: MovementDraft, receipt: Receipt | null): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO pending_movements (id, kind, draft, receipt) VALUES (?, ?, ?, ?)",
			id,
			kind,
			JSON.stringify(draft),
			receipt ? JSON.stringify(receipt) : null,
		);
	}

	private view(id: string, kind: PendingKind, draft: MovementDraft, receipt: Receipt | null): PendingView {
		return { id, kind, html: receipt ? formatReceiptHtml(receipt) : formatDraftHtml(draft), canSave: canSave(draft) };
	}

	/** Stores a parsed receipt until the user saves, edits or discards it. */
	async createPendingReceipt(receipt: Receipt): Promise<PendingView> {
		const id = newPendingId();
		const draft = draftFromReceipt(receipt);
		this.insertPending(id, "receipt", draft, receipt);
		return this.view(id, "receipt", draft, receipt);
	}

	async getPending(id: string): Promise<(PendingMovement & { view: PendingView }) | null> {
		const rows = this.ctx.storage.sql.exec("SELECT * FROM pending_movements WHERE id = ?", id).toArray();
		if (rows.length === 0) return null;
		const r = rows[0];
		const draft = JSON.parse(r.draft as string) as MovementDraft;
		const receipt = r.receipt ? (JSON.parse(r.receipt as string) as Receipt) : null;
		const kind = r.kind as PendingKind;
		return {
			id,
			kind,
			status: r.status as PendingStatus,
			draft,
			receipt,
			movementId: (r.movement_id as string | null) ?? null,
			view: this.view(id, kind, draft, receipt),
		};
	}

	/** Marks a pending movement saved and leaves a note in the history for follow-ups. */
	async markPendingSaved(id: string, movementId: string): Promise<void> {
		const pending = await this.getPending(id);
		if (pending?.status !== "pending") return;
		const what = pending.kind === "receipt" ? "User sent a receipt" : "User confirmed a movement";
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				"UPDATE pending_movements SET status = 'saved', movement_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
				movementId,
				id,
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO chat_messages (role, content, source) VALUES ('system', ?, 'note')",
				`${what}: ${describeDraft(pending.draft)}, saved as movement ${movementId}.`,
			);
		});
	}

	/** Returns true if the movement was pending and is now discarded. */
	async discardPending(id: string): Promise<boolean> {
		const res = this.ctx.storage.sql.exec(
			"UPDATE pending_movements SET status = 'discarded', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending' RETURNING id",
			id,
		);
		return res.toArray().length > 0;
	}

	/** The next text message in this chat edits receipt `id`. */
	async startEditing(id: string): Promise<void> {
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO chat_state (key, value) VALUES ('editing', ?)", id);
	}

	/** Returns (and clears) the receipt being edited, if it is still pending. */
	async takeEditing(): Promise<(PendingMovement & { view: PendingView }) | null> {
		const rows = this.ctx.storage.sql.exec("DELETE FROM chat_state WHERE key = 'editing' RETURNING value").toArray();
		if (rows.length === 0) return null;
		const pending = await this.getPending(rows[0].value as string);
		return pending?.status === "pending" && pending.receipt ? pending : null;
	}

	async updatePendingReceipt(id: string, receipt: Receipt): Promise<PendingView | null> {
		const draft = draftFromReceipt(receipt);
		const res = this.ctx.storage.sql.exec(
			"UPDATE pending_movements SET receipt = ?, draft = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending' RETURNING id",
			JSON.stringify(receipt),
			JSON.stringify(draft),
			id,
		);
		return res.toArray().length > 0 ? this.view(id, "receipt", draft, receipt) : null;
	}
}
