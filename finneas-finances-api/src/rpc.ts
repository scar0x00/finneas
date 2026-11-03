import { WorkerEntrypoint } from "cloudflare:workers";
import type { CreatedMovement, FinancesApiRpc, InstrumentBalance, MovementSummary, NewMovement } from "./contract";

/**
 * Service-binding entrypoint used by the Telegram bot.
 *
 * NOT IMPLEMENTED YET: the storage behind it is tracked in #1 / #5 (schema on the
 * `dev` branch, `FINNEAS_DB.SQL`). Until then every method throws, and the bot keeps
 * receipt saving switched off by not binding FINANCES_API (see docs/deploy.md).
 */
export class FinancesApi extends WorkerEntrypoint<CloudflareBindings> implements FinancesApiRpc {
	async createMovement(_movement: NewMovement): Promise<CreatedMovement> {
		throw new Error("createMovement is not implemented yet (#5)");
	}

	async listRecentMovements(_input: { tgUserId: number; limit: number }): Promise<MovementSummary[]> {
		throw new Error("listRecentMovements is not implemented yet (#5)");
	}

	async getBalance(_input: { tgUserId: number }): Promise<InstrumentBalance[]> {
		throw new Error("getBalance is not implemented yet (#5)");
	}
}
