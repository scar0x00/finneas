import { jsonResponse, type FetchMock, type RecordedCall } from "./fetchMock";

/** Accepts every publish. Use `publishCalls()` to inspect them. */
export function mockQStashPublish(mock: FetchMock): FetchMock {
	let n = 0;
	return mock.on("qstash-us-east-1.upstash.io", /\/v2\/publish\//, () => jsonResponse({ messageId: `msg_${n++}` }));
}

export function publishCalls(mock: FetchMock): RecordedCall[] {
	return mock.calls.filter((c) => c.url.host.includes("qstash") && c.url.pathname.startsWith("/v2/publish/"));
}

/** Destination URL a publish call targets (the path after /v2/publish/). */
export function publishDestination(call: RecordedCall): string {
	return decodeURIComponent(call.url.pathname.replace(/^\/v2\/publish\//, ""));
}
