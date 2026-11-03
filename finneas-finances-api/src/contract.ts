/**
 * RPC contract between the Telegram bot and the finances API (#20).
 *
 * The bot reaches the API through a service binding (`FINANCES_API`) to the
 * `FinancesApi` WorkerEntrypoint, so no public URL or shared secret is needed.
 * Users are identified by their Telegram user id (`users.tg_id`).
 *
 * Amounts are decimal strings ("1234.56") to avoid float rounding; currencies are
 * the `currencies.currency_code` values (e.g. "VES", "USD").
 */

/** Where a movement was created (#8). */
export type MovementSource = "telegram_bot" | "web_app" | "unknown";

export type NewMovementType = "egress" | "income";

export interface NewMovement {
	/**
	 * Stable key for this movement. Calling `createMovement` again with the same
	 * key must return the existing movement instead of creating a second one.
	 */
	idempotencyKey: string;
	tgUserId: number;
	type: NewMovementType;
	amount: string;
	currency: string;
	/** ISO 8601 date (YYYY-MM-DD) or date-time. */
	madeAt: string;
	/** Free-text payee/payer; the API resolves or creates the counterparty. */
	counterpartyName: string | null;
	description: string | null;
	/** Bank reference / transaction id from the receipt, if any. */
	reference: string | null;
	/** Bank or provider name as printed on the receipt, used to pick the instrument. */
	providerHint: string | null;
	source: MovementSource;
}

export interface CreatedMovement {
	id: string;
	/** True when the idempotency key had already been used. */
	duplicate: boolean;
}

export interface MovementSummary {
	id: string;
	type: string;
	amount: string;
	currency: string;
	madeAt: string;
	counterpartyName: string | null;
	description: string | null;
}

export interface InstrumentBalance {
	instrument: string;
	currency: string;
	balance: string;
}

export interface FinancesApiRpc {
	createMovement(movement: NewMovement): Promise<CreatedMovement>;
	listRecentMovements(input: { tgUserId: number; limit: number }): Promise<MovementSummary[]>;
	getBalance(input: { tgUserId: number }): Promise<InstrumentBalance[]>;
}
