import { describe, expect, it } from "vitest";
import { arrayBufferToBase64 } from "../src/lib/arrayBufferToBase64";

describe("arrayBufferToBase64", () => {
	it("encodes an empty buffer", () => {
		expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe("");
	});

	it("encodes a small buffer", () => {
		expect(arrayBufferToBase64(new TextEncoder().encode("hello").buffer as ArrayBuffer)).toBe(btoa("hello"));
	});

	it("encodes a buffer larger than one 32 KB chunk without corrupting chunk boundaries", () => {
		const size = 0x8000 * 3 + 17;
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
		let bin = "";
		for (const b of bytes) bin += String.fromCharCode(b);
		expect(arrayBufferToBase64(bytes.buffer)).toBe(btoa(bin));
	});
});

import { extractTransactionInfo } from "../src/lib/extractTransactionInfo";
import { afterEach as after, beforeEach as before } from "vitest";
import { mockFetch, jsonResponse, type FetchMock } from "./helpers/fetchMock";
import { chatCompletion, CHAT_PATH, OPENROUTER_HOST } from "./helpers/openrouter";
import { env } from "cloudflare:workers";

describe("receipt JSON extraction", () => {
	let mock: FetchMock;
	before(() => {
		mock = mockFetch();
	});
	after(() => mock.restore());

	const receipt = { amount: 25, currency: "USD", recipient_name: "Ana" };
	const cases: [string, string][] = [
		["plain JSON", JSON.stringify(receipt)],
		["a ```json fence", "```json\n" + JSON.stringify(receipt) + "\n```"],
		["a <think> block followed by a fence", "<think>let me look</think>\n```json\n" + JSON.stringify(receipt) + "\n```"],
	];
	for (const [name, content] of cases) {
		it(`parses ${name}`, async () => {
			mock.on(OPENROUTER_HOST, CHAT_PATH, () => jsonResponse(chatCompletion(content)));
			const result = await extractTransactionInfo({ image: "data:image/jpeg;base64,AAAA", env: env as any });
			expect(result).toMatchObject(receipt);
		});
	}
});

describe("fetch mock", () => {
	it("throws on any unmocked host", async () => {
		const mock = mockFetch();
		try {
			await expect(fetch("https://example.org/")).rejects.toThrow(/Unmocked fetch/);
		} finally {
			mock.restore();
		}
	});
});
