import type { ChatMessage } from "../types/Chat";
import type { Env } from "../index";
import { DurableObject } from "cloudflare:workers";
import { AgentDOParams } from "../types/AgentDOParams";
import { runOpenrouterModel } from "./runOpenrouterModel";

export type AgentDOHistory = (ChatMessage | Record<string, SqlStorageValue>)[];

export class AgentDO extends DurableObject<Env> {
    SYSTEM: string;
    chatId: string;
    model: string = "google/gemini-3.1-flash-lite";
    history: AgentDOHistory;

    async init({
        SYSTEM,
        model,
    }: AgentDOParams): Promise<void> {
        if (model) this.model = model;
        this.SYSTEM = SYSTEM;
        this.history = this.ctx.storage.sql.exec(`
            SELECT role, content
            FROM chat_messages
            ORDER BY id ASC;
        `).toArray();
        if (this.history.length === 0) {
            const initMessage = {
                role: "system",
                content: this.SYSTEM,
            } as ChatMessage;
            this.appendMessage(initMessage);
            this.history = [
                initMessage,
            ];
        }
        console.log(new Date(), "init done", this.history);
    }

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        if (!this.ctx.id.name) {
            throw new Error("You must provide a name to use this DO");
        }
        this.chatId = this.ctx.id.name;
        this.SYSTEM = "";
        this.history = [];
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
                content TEXT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );    
        `);
    }

    async run(userMssg: string): Promise<string> {
        const messages: AgentDOHistory = [
            ...this.history,
            {
                role: "user",
                content: userMssg,
            },
        ];
        console.log(new Date(), "Chat so far", messages);

        const response = await runOpenrouterModel({
            OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
            messages,
            model: this.model
        });

        this.appendMessages([
            {
                role: "user",
                content: userMssg,
            },
            {
                role: "assistant",
                content: response.answer,
            },
        ]);
        this.history = [
            ...this.history,
            {
                role: "user",
                content: userMssg,
            },
            {
                role: "assistant",
                content: response.answer,
            },
        ];
        return response.answer;
    }

    async clearChat() {
        this.ctx.storage.sql.exec(`DELETE FROM chat_messages;`);
        this.history = [];
    }

    private async appendMessage(message: ChatMessage) {
        this.ctx.storage.sql.exec(
            `INSERT INTO chat_messages (role, content) VALUES (?, ?)`,
            message.role,
            message.content,
        );
    }
    appendMessages(messages: ChatMessage[]) {
        if (messages.length === 0) return;

        // Creates "(?, ?), (?, ?), ..." based on the array length
        const placeholders = messages.map(() => "(?, ?)").join(", ");

        // Flattens [{role, content}, ...] into [role1, content1, role2, content2, ...]
        const values = messages.flatMap((m) => [m.role, m.content]);

        this.ctx.storage.sql.exec(
            `INSERT INTO chat_messages (role, content) VALUES ${placeholders};`,
            ...values,
        );
    }
}
