import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("finances API fake binding", () => {
	it("is reachable over RPC", async () => {
		const api = (env as any).FINANCES_API;
		await api.__reset();
		const created = await api.createMovement({ idempotencyKey: "k", tgUserId: 1, type: "egress", amount: "1", currency: "USD" });
		expect(created).toEqual({ id: "1", duplicate: false });
		expect(await api.createMovement({ idempotencyKey: "k" })).toEqual({ id: "1", duplicate: true });
	});
});
