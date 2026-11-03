import { afterEach, describe, expect, it, vi } from "vitest";
import { isRetryable, isRetryableStatus, RetryableError } from "../src/lib/errors";
import { openrouterPost } from "../src/lib/openrouterFetch";
import { jsonResponse, mockFetch } from "./helpers/fetchMock";

afterEach(() => vi.restoreAllMocks());

describe("isRetryable", () => {
	it("recognises RetryableError, its name and its message marker (survives RPC)", () => {
		const e = new RetryableError("boom");
		expect(isRetryable(e)).toBe(true);
		const plain = new Error(e.message);
		expect(isRetryable(plain)).toBe(true);
		const named = new Error("x");
		named.name = "RetryableError";
		expect(isRetryable(named)).toBe(true);
	});

	it("unwraps grammY BotError", () => {
		const botError = Object.assign(new Error("Error in middleware"), { error: new RetryableError("inner") });
		expect(isRetryable(botError)).toBe(true);
	});

	it("treats Bot API 429/5xx and network errors as retryable", () => {
		expect(isRetryable(Object.assign(new Error("x"), { error_code: 429 }))).toBe(true);
		expect(isRetryable(Object.assign(new Error("x"), { error_code: 502 }))).toBe(true);
		expect(isRetryable(Object.assign(new Error("x"), { error_code: 400 }))).toBe(false);
		const http = new Error("net");
		http.name = "HttpError";
		expect(isRetryable(http)).toBe(true);
	});

	it("is false for ordinary errors and non-errors", () => {
		expect(isRetryable(new Error("nope"))).toBe(false);
		expect(isRetryable("string")).toBe(false);
		expect(isRetryable(undefined)).toBe(false);
	});

	it("classifies statuses", () => {
		expect([408, 429, 500, 503].every(isRetryableStatus)).toBe(true);
		expect([200, 400, 401, 404].some(isRetryableStatus)).toBe(false);
	});
});

describe("openrouterPost", () => {
	it("throws RetryableError on timeout", async () => {
		const mock = mockFetch();
		mock.spy.mockImplementation(
			(_input: any, init?: any) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
				}),
		);
		await expect(openrouterPost("/chat/completions", {}, "k", 20)).rejects.toSatisfy(isRetryable);
		mock.restore();
	});

	it("throws RetryableError on network failure", async () => {
		const mock = mockFetch();
		mock.spy.mockRejectedValue(new TypeError("fetch failed"));
		await expect(openrouterPost("/x", {}, "k")).rejects.toSatisfy(isRetryable);
		mock.restore();
	});

	it("throws a non-retryable error with the status but not the body on 4xx", async () => {
		const mock = mockFetch();
		mock.on("openrouter.ai", "/api/v1/x", () => jsonResponse({ error: "secret body" }, 401));
		const err = await openrouterPost("/x", {}, "k").catch((e) => e);
		expect(isRetryable(err)).toBe(false);
		expect(err.message).toContain("401");
		expect(err.message).not.toContain("secret body");
		mock.restore();
	});

	it("sends auth and attribution headers", async () => {
		const mock = mockFetch();
		mock.on("openrouter.ai", "/api/v1/x", () => jsonResponse({ ok: 1 }));
		const { data } = await openrouterPost<{ ok: number }>("/x", { a: 1 }, "key-123");
		expect(data).toEqual({ ok: 1 });
		const [call] = mock.calls;
		expect(call.headers.get("Authorization")).toBe("Bearer key-123");
		expect(call.json()).toEqual({ a: 1 });
		mock.restore();
	});
});
