// In-memory stand-in for finneas-finances-api's FinancesApi entrypoint (see
// finneas-finances-api/src/contract.ts). Bound as FINANCES_API in vitest.config.mts.
import { WorkerEntrypoint } from "cloudflare:workers";

let state;
function reset() {
	state = { calls: [], movements: [], byKey: new Map(), nextId: 1, failures: [] };
}
reset();

function record(method, args) {
	state.calls.push({ method, args });
	const failure = state.failures.shift();
	if (failure) throw new Error(failure);
}

export class FinancesApi extends WorkerEntrypoint {
	async createMovement(movement) {
		record("createMovement", movement);
		const existing = state.byKey.get(movement.idempotencyKey);
		if (existing) return { id: existing.id, duplicate: true };
		const saved = { ...movement, id: String(state.nextId++) };
		state.movements.push(saved);
		state.byKey.set(movement.idempotencyKey, saved);
		return { id: saved.id, duplicate: false };
	}

	async listRecentMovements(input) {
		record("listRecentMovements", input);
		return state.movements
			.filter((m) => m.tgUserId === input.tgUserId)
			.slice(-input.limit)
			.reverse()
			.map((m) => ({
				id: m.id,
				type: m.type,
				amount: m.amount,
				currency: m.currency,
				madeAt: m.madeAt,
				counterpartyName: m.counterpartyName,
				description: m.description,
			}));
	}

	async getBalance(input) {
		record("getBalance", input);
		return [{ instrument: "Banesco", currency: "VES", balance: "1000.00" }];
	}

	// Test controls
	async __reset() {
		reset();
	}
	async __calls() {
		return state.calls;
	}
	async __movements() {
		return state.movements;
	}
	/** The next call throws with this message. */
	async __failNext(message) {
		state.failures.push(message);
	}
}

export default {
	fetch() {
		return new Response("finances api fake");
	},
};
