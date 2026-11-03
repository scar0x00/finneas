import { describe, expect, it } from "vitest";
import { escapeHtml, splitMessage, TELEGRAM_MAX_MESSAGE } from "../src/lib/telegram";

describe("splitMessage", () => {
	it("returns short text unchanged", () => {
		expect(splitMessage("hello")).toEqual(["hello"]);
	});

	it("never returns an empty array, even for empty text", () => {
		expect(splitMessage("")).toEqual([""]);
	});

	it("splits on paragraph boundaries first", () => {
		const a = "a".repeat(3000);
		const b = "b".repeat(3000);
		expect(splitMessage(`${a}\n\n${b}`)).toEqual([a, b]);
	});

	it("falls back to line boundaries", () => {
		const a = "a".repeat(3000);
		const b = "b".repeat(3000);
		expect(splitMessage(`${a}\n${b}`)).toEqual([a, b]);
	});

	it("hard-splits a single huge word", () => {
		const parts = splitMessage("x".repeat(10_000));
		expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
	});

	it("respects a custom limit and keeps all content", () => {
		const text = "one two three four five six seven eight nine ten";
		const parts = splitMessage(text, 10);
		expect(parts.every((p) => p.length <= 10)).toBe(true);
		expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text);
	});

	it("exports Telegram's limit", () => {
		expect(TELEGRAM_MAX_MESSAGE).toBe(4096);
	});
});

describe("escapeHtml", () => {
	it("escapes &, < and >", () => {
		expect(escapeHtml("a & b <i>c</i>")).toBe("a &amp; b &lt;i&gt;c&lt;/i&gt;");
	});

	it("leaves Markdown characters alone", () => {
		expect(escapeHtml("_*`[]")).toBe("_*`[]");
	});

	it("stringifies numbers and handles null", () => {
		expect(escapeHtml(12.5)).toBe("12.5");
		expect(escapeHtml(null)).toBe("");
	});
});
