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

import { mockFetch } from "./helpers/fetchMock";

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
