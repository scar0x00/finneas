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
			},
		}),
	],
});
