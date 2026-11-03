import type { FinancesApiRpc } from "finneas-finances-api/contract";

declare global {
	interface Env {
		/**
		 * Service binding to finneas-finances-api's `FinancesApi` entrypoint. Not in
		 * wrangler.jsonc yet: receipt saving and agent tools stay off until #5 implements
		 * the API (see docs/deploy.md). Tests bind an in-memory fake.
		 */
		FINANCES_API?: FinancesApiRpc;
	}
}
