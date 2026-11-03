import type { FinancesApiRpc } from "finneas-finances-api/contract";
import { z } from "zod";
import { logError } from "./log";
import { draftFromToolArgs, type MovementDraft, RegisterMovementArgs } from "./movements";
import type { ToolCall, ToolDefinition } from "./openrouter";

export const MAX_TOOL_ROUNDS = 5;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "register_movement",
			description:
				"Propose recording an expense (egress) or income. This does NOT save anything: the user is shown the movement " +
				"with a Save button and must tap it. Only call it once you know the amount, currency, date and counterparty; " +
				"ask the user for anything missing first. Never tell the user it was saved.",
			parameters: z.toJSONSchema(RegisterMovementArgs, { io: "input" }) as Record<string, unknown>,
		},
	},
	{
		type: "function",
		function: {
			name: "list_recent_movements",
			description: "List the user's most recent saved movements, newest first.",
			parameters: {
				type: "object",
				properties: { limit: { type: "integer", minimum: 1, maximum: 20, description: "How many movements (default 10)" } },
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_balance",
			description: "Get the current balance of each of the user's accounts and wallets.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
];

export interface ToolContext {
	api: FinancesApiRpc;
	tgUserId: number;
	chatId: number;
	/** Stores a draft as a pending movement and returns its id. */
	propose(draft: MovementDraft): string;
}

function parseArgs(call: ToolCall): unknown {
	try {
		return JSON.parse(call.function.arguments || "{}");
	} catch {
		return null;
	}
}

/** Runs one tool call and returns the content of the `tool` message for the model. Never throws. */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<string> {
	const args = parseArgs(call);
	try {
		switch (call.function.name) {
			case "register_movement": {
				const parsed = RegisterMovementArgs.safeParse(args);
				if (!parsed.success) {
					return `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
				}
				const id = ctx.propose(draftFromToolArgs(parsed.data));
				return `Proposed movement ${id}. It is NOT saved yet: the user now sees it with a Save button and must confirm. Ask them to check the details and tap Save.`;
			}
			case "list_recent_movements": {
				const raw = (args as { limit?: unknown } | null)?.limit;
				const limit = Number.isInteger(raw) ? Math.min(Math.max(raw as number, 1), 20) : 10;
				return JSON.stringify(await ctx.api.listRecentMovements({ tgUserId: ctx.tgUserId, limit }));
			}
			case "get_balance":
				return JSON.stringify(await ctx.api.getBalance({ tgUserId: ctx.tgUserId }));
			default:
				return `error: unknown tool ${call.function.name}`;
		}
	} catch (err) {
		logError("tool.failed", err, { chat_id: ctx.chatId, tool: call.function.name });
		return "error: the finances service could not be reached. Tell the user to try again later.";
	}
}
