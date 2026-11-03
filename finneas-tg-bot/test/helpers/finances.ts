import { env } from "cloudflare:workers";

/** The in-memory finances API bound as FINANCES_API (test/fixtures/financesApiFake.js). */
export const financesApi = () => (env as any).FINANCES_API;

export async function financesCalls(method?: string): Promise<{ method: string; args: any }[]> {
	const calls = await financesApi().__calls();
	return method ? calls.filter((c: any) => c.method === method) : calls;
}
