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

Root: `pnpm test` (all packages), `pnpm typecheck`, `pnpm build`.

CI (`.github/workflows/ci.yml`) runs on every PR and on `main`: frozen install,
`pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` (`wrangler deploy --dry-run`).
It has no secrets; keep tests offline. Run those same commands before pushing.

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

## Security model (finneas-tg-bot)

- `POST /` requires `X-Telegram-Bot-Api-Secret-Token` == `TELEGRAM_WEBHOOK_SECRET`
  (constant-time compare in `src/lib/security.ts`), else 401. An unset secret rejects everything.
- `ALLOWED_USER_IDS` (var, comma-separated) gates both `POST /` and `/process`. Unknown
  senders get 200 and nothing happens (so Telegram does not retry). Empty list = nobody.
- `USER_RATE_LIMIT` (Workers rate limiting binding, 20/min per user) drops excess updates with 200.
  `callWorker()` in tests swaps it for an unlimited fake; pass the real binding to test it.
- `/process` verifies the QStash JWT including `url` (`<origin>/process`); any
  verification error is 401, never 500.
- Never send `err.message` or other internals to the chat.

## Request pipeline and retry policy (finneas-tg-bot)

Telegram → `POST /` → QStash publish (`deduplicationId = update_id`) → `POST /process`
→ grammY handlers → `AgentDO` / OpenRouter → reply.

- `POST /` answers 200 for everything except a bad secret (401) or a failed QStash
  publish (500, so Telegram redelivers; the dedupe id makes that safe). Unsupported
  update types and malformed JSON are acknowledged and dropped. The typing action runs
  in `ctx.waitUntil` after the publish and never blocks it.
- `/process` → `processUpdate()`: an error boundary middleware tracks whether anything
  was sent to the user (`SENDING_METHODS`, via an API transformer).
  - `RetryableError` (OpenRouter 408/429/5xx, timeouts, network; Bot API 429/5xx) before
    any reply → `/process` returns 503 → QStash retries.
  - Anything else, or anything after a reply → logged, one friendly message if nothing was
    sent yet, `/process` returns 200 (no retry, no duplicate reply).
  - Errors lose their class across DO RPC, so `RetryableError` also carries a
    `[retryable] ` message prefix; always test with `isRetryable(err)`.
- All OpenRouter calls go through `openrouterPost()` (`src/lib/openrouterFetch.ts`):
  shared headers, 25 s timeout (cleared timer, not `AbortSignal.timeout`, which kept DOs
  busy and hung `evictDurableObject` in tests), status checks, no response bodies in errors.
- Replies go through `sendLongMessage()` (splits at 4096 chars). Model-provided values in
  formatted messages use HTML parse mode with `escapeHtml()`; never legacy Markdown.

## Logging

- Use `log` / `logWarn` / `logError` from `finneas-tg-bot/src/lib/log.ts` (one JSON line
  per call, with an `event` name). It is the only module allowed to use `console`.
- Never log message text, transcriptions, chat history, model output or receipt fields.
  Log ids, sizes, timings and token counts. `test/logging.spec.ts` enforces this by
  spying on `console` during full text/voice/photo flows.
- Standard fields: `update_id`, `chat_id`, `handler` (`text|voice|photo|command|callback`),
  `duration_ms`; model calls log `model.call` with `kind`, `model`, `prompt_tokens`,
  `completion_tokens`. A normal message produces `update.received`, `model.call`, `update.done`.

## Roadmap status

Issue #9 tracks the review follow-ups (#10–#20). Progress:

- [x] #12 offline test suite (unused `AI` binding removed; nested lockfiles removed)
- [x] #10 webhook secret, allowlist, rate limit, QStash URL check. **Before deploying**:
  `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, set `ALLOWED_USER_IDS`, and re-register
  the webhook with `secret_token` (see #16 scripts).
- [x] #11 structured JSON logs, no personal data
- [x] #14 idempotent pipeline (DO-level `update_id` dedupe lands with #15)
- [x] #13 CI workflow. Branch protection on `main` (require `check`) must be set by Oscar in GitHub settings.
