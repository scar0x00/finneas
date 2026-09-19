import type { Env } from "../index";

export interface AgentParams {
    SYSTEM: string;
    chatId: number;
    env: Env;
    model?: string;
}