# Finneas — agent guide

Finneas is a personal-finance Telegram bot on Cloudflare Workers. This file is the
hand-off note for coding agents: read it first, and keep it current when you change
layout, commands, architecture or conventions.

## Layout (pnpm workspace, run `pnpm install` at the root)

| Path | What |
|------|------|
| `finneas-tg-bot/` | The Telegram bot Worker (Worker name `register-bot`). Most work happens here. |
| `finneas-finances-api/` | Hono Worker in front of Neon (Hyperdrive). Still a stub. |
| `extractors/` | Standalone scrapers, **not** part of the workspace. |

There is exactly one `pnpm-lock.yaml` (root). Never add per-package lockfiles or
`pnpm-workspace.yaml` files: a nested `pnpm-workspace.yaml` makes pnpm treat the
package as its own workspace, with a different pnpm version and lockfile.

## Commands

Root: `pnpm test` (all packages), `pnpm typecheck`.

In `finneas-tg-bot/`:

| Command | Purpose |
|---------|---------|
| `pnpm test` | Vitest, single pass (`pnpm test:watch` for watch mode) |
| `pnpm typecheck` | `tsc` over `src` and `test` |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `pnpm dev` / `pnpm deploy` | `wrangler dev` / `wrangler deploy` |

## Cloudflare Workers: fetch current docs first

Your knowledge of Workers APIs and limits may be outdated. Check
https://developers.cloudflare.com/workers/ before touching bindings, Durable Objects,
storage or limits.

## Testing (finneas-tg-bot)

- Work test-first: add or change a spec, see it fail, then implement.
- Tests run fully offline through `@cloudflare/vitest-plugin` (`remoteBindings: false`).
  Fake secrets come from `test/helpers/bindings.ts` via `miniflare.bindings` in
  `vitest.config.mts`; tests never read `.dev.vars`. Add new vars/secrets there too.
- All outbound HTTP goes through `mockFetch()` (`test/helpers/fetchMock.ts`), which
  spies on `globalThis.fetch` and **throws on any unmocked host**. The DO runs in the
  same isolate, so the mock applies to it as well.
- Helpers: `telegram.ts` (update factories, `mockTelegram`, `sentTexts`),
  `openrouter.ts` (`mockChat`, `mockTranscription`, `chatCalls`), `qstashApi.ts`
  (publish mock), `qstash.ts` (`signQStash` builds real QStash JWTs), `worker.ts`
  (`callWorker` waits for `ctx.waitUntil`, `webhookRequest`, `processRequest`).
- Durable Object tests use unique names per test (`getByName`) and
  `runInDurableObject` to read SQLite directly.

## Roadmap status

Issue #9 tracks the review follow-ups (#10–#20). Progress:

- [x] #12 offline test suite (unused `AI` binding removed; nested lockfiles removed)
