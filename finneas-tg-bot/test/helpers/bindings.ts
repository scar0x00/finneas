/**
 * Fake secrets and vars injected into the Worker under test (see vitest.config.mts).
 * Kept in a plain module so tests can import the same values to sign requests.
 */
export const TEST_BOT_ID = 7_000_000_001;
export const TEST_BOT_TOKEN = `${TEST_BOT_ID}:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz`;

export const TEST_BINDINGS = {
	FINNEAS_BOT_TOKEN: TEST_BOT_TOKEN,
	FINNEAS_BOT_INFO: JSON.stringify({
		id: TEST_BOT_ID,
		is_bot: true,
		first_name: "Finneas Test",
		username: "finneas_test_bot",
		can_join_groups: false,
		can_read_all_group_messages: false,
		supports_inline_queries: false,
		can_connect_to_business: false,
		has_main_web_app: false,
	}),
	QSTASH_TOKEN: "test-qstash-token",
	QSTASH_CURRENT_SIGNING_KEY: "sig_test_current_key",
	QSTASH_NEXT_SIGNING_KEY: "sig_test_next_key",
	OPENROUTER_API_KEY: "test-openrouter-key",
} as const;
