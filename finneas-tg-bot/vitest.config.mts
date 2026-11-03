import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_BINDINGS } from "./test/helpers/bindings.ts";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Tests must never need Cloudflare credentials or a network connection.
			remoteBindings: false,
			miniflare: {
				// Fake values so tests never read `.dev.vars`.
				bindings: TEST_BINDINGS,
				// In-memory finances API behind the same service binding the bot uses in production.
				serviceBindings: {
					FINANCES_API: { name: "finances-api-fake", entrypoint: "FinancesApi" },
				},
				workers: [
					{
						name: "finances-api-fake",
						modules: true,
						scriptPath: "./test/fixtures/financesApiFake.js",
						compatibilityDate: "2026-09-07",
					},
				],
			},
		}),
	],
});
