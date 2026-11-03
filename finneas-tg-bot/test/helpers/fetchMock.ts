import { vi, type MockInstance } from "vitest";

/** A recorded outbound request. The body is read eagerly so tests can inspect it. */
export interface RecordedCall {
	method: string;
	url: URL;
	headers: Headers;
	bodyText: string;
	/** Parses `bodyText` as JSON (throws if it is not JSON). */
	json<T = any>(): T;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

interface Route {
	host: string;
	path?: string | RegExp;
	method?: string;
	responder: Responder;
	/** When set, the route is used this many times and then skipped. */
	remaining?: number;
}

export interface FetchMock {
	/** Every outbound request, in order. */
	readonly calls: RecordedCall[];
	/** Registers a persistent route. Later routes win over earlier ones. */
	on(host: string, path: string | RegExp | undefined, responder: Responder, opts?: { method?: string }): FetchMock;
	/** Registers a route that answers only the next `times` matching requests (default 1). */
	once(host: string, path: string | RegExp | undefined, responder: Responder, opts?: { method?: string; times?: number }): FetchMock;
	/** Calls whose host (and optionally path) match. */
	callsTo(host: string, path?: string | RegExp): RecordedCall[];
	restore(): void;
	readonly spy: MockInstance<typeof fetch>;
}

function matchesPath(pathname: string, path?: string | RegExp): boolean {
	if (path === undefined) return true;
	if (typeof path === "string") return pathname === path || pathname.endsWith(path);
	return path.test(pathname);
}

/**
 * Replaces `globalThis.fetch` with a router of fake responses.
 *
 * Any request to a host/path that has no route throws, so a test can never
 * reach the real network by accident.
 */
export function mockFetch(): FetchMock {
	const routes: Route[] = [];
	const calls: RecordedCall[] = [];

	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init);
		const bodyText = request.body ? await request.clone().text() : "";
		const call: RecordedCall = {
			method: request.method,
			url: new URL(request.url),
			headers: request.headers,
			bodyText,
			json: () => JSON.parse(bodyText),
		};
		calls.push(call);

		for (let i = routes.length - 1; i >= 0; i--) {
			const route = routes[i];
			if (route.remaining !== undefined && route.remaining <= 0) continue;
			if (route.host !== call.url.host) continue;
			if (route.method && route.method !== call.method) continue;
			if (!matchesPath(call.url.pathname, route.path)) continue;
			if (route.remaining !== undefined) route.remaining--;
			return route.responder(call);
		}
		throw new Error(`Unmocked fetch: ${call.method} ${call.url.href}`);
	});

	const mock: FetchMock = {
		calls,
		spy,
		on(host, path, responder, opts) {
			routes.push({ host, path, responder, method: opts?.method });
			return mock;
		},
		once(host, path, responder, opts) {
			routes.push({ host, path, responder, method: opts?.method, remaining: opts?.times ?? 1 });
			return mock;
		},
		callsTo(host, path) {
			return calls.filter((c) => c.url.host === host && matchesPath(c.url.pathname, path));
		},
		restore() {
			spy.mockRestore();
		},
	};
	return mock;
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
