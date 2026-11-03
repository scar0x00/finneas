import { TEST_BINDINGS } from "./bindings";

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
	const u8 = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
	let bin = "";
	for (const b of u8) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SignOptions {
	/** Destination URL the signature is issued for (`sub` claim). */
	url: string;
	/** Signing key. Defaults to the test current signing key. */
	key?: string;
	/** Overrides for the JWT claims. */
	claims?: Record<string, unknown>;
}

/**
 * Signs `body` the way QStash does: an HS256 JWT with
 * `iss: "Upstash"`, `sub: <url>`, `body: base64url(sha256(body))`, `nbf`, `exp`.
 */
export async function signQStash(body: string, { url, key = TEST_BINDINGS.QSTASH_CURRENT_SIGNING_KEY, claims = {} }: SignOptions): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const bodyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	const header = { alg: "HS256", typ: "JWT" };
	const payload = {
		iss: "Upstash",
		sub: url,
		exp: now + 300,
		nbf: now - 1,
		iat: now,
		jti: crypto.randomUUID(),
		body: base64url(bodyHash),
		...claims,
	};
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signingInput));
	return `${signingInput}.${base64url(signature)}`;
}
