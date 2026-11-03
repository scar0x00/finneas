# Finneas — agent guide

Finneas is a personal-finance Telegram bot on Cloudflare Workers. This file is the
hand-off note for coding agents: read it first, and keep it current when you change
layout, commands, architecture or conventions.

## Layout (pnpm workspace, run `pnpm install` at the root)

| Path | What |
|------|------|
| `finneas-tg-bot/` | The Telegram bot Worker (package `finneas-tg-bot`, production Worker name `register-bot`). Most work happens here. |
| `finneas-finances-api/` | Hono Worker in front of Neon (Hyperdrive). Still a stub. |
| `extractors/` | Standalone Node scrapers. Outputs are gitignored; never commit scraped data. |
| `docs/deploy.md` | Environments, secrets, deploys, rollback |

There is exactly one `pnpm-lock.yaml` (root). Never add per-package lockfiles or
`pnpm-workspace.yaml` files: a nested `pnpm-workspace.yaml` makes pnpm treat the
package as its own workspace, with a different pnpm version and lockfile.
Shared dependency versions live in the `catalog:` of the root `pnpm-workspace.yaml`
(use `"catalog:"` in package.json). Every package's `tsconfig.json` extends
`tsconfig.base.json`.

## Commands

Root: `pnpm test` (all packages), `pnpm typecheck`, `pnpm build`, `pnpm lint`
(`biome check`: lint + format + import order), `pnpm format` (write).

CI (`.github/workflows/ci.yml`) runs on every PR and on `main`: frozen install,
`pnpm lint`, `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`
(`wrangler deploy --dry-run`). It has no secrets; keep tests offline. Run those same
commands before pushing.

Tooling: Biome (`biome.json`; tabs, width 140, Markdown excluded; `noConsole` everywhere
except `src/lib/log.ts`, tests, scripts, extractors). lefthook pre-commit runs
`biome check --write` on staged files and `pnpm -r typecheck` (`LEFTHOOK=0` to skip).
Renovate (`renovate.json`) groups Cloudflare tooling. Conventional Commits; PRs use
`.github/pull_request_template.md`. Bulk-format commits go in `.git-blame-ignore-revs`
(merge PRs that contain one with a merge commit, not a squash, or the SHA changes).

In `finneas-tg-bot/`:

| Command | Purpose |
|---------|---------|
| `pnpm test` | Vitest, single pass (`pnpm test:watch` for watch mode) |
| `pnpm typecheck` | `tsc` over `src` and `test` |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `pnpm build` | `wrangler deploy --dry-run` for the top level, staging and production |
| `pnpm deploy:staging` / `deploy:production` | Emergency manual deploys; normally CI deploys (see `docs/deploy.md`) |
| `pnpm dev` / `pnpm dev:tunnel` | `wrangler dev` / `cloudflared` quick tunnel to :8787 |
| `pnpm webhook:set --url <https>` / `webhook:info` / `webhook:delete` | Telegram webhook via `scripts/webhook.ts` (Node 22.18+ type stripping, reads `.dev.vars`) |

Local dev: see the root `README.md`. Use a separate dev bot. `DIRECT_PROCESSING=true`
(in `.dev.vars` only) makes `POST /` run `processUpdate()` inline via `ctx.waitUntil`
instead of publishing to QStash. `scripts/webhook-lib.ts` holds the testable logic;
`scripts/` has its own tsconfig (Node types).

## Environments and deploys

See `docs/deploy.md`. Top level of `finneas-tg-bot/wrangler.jsonc` = local dev
(Worker `finneas-tg-bot-dev`, never deployed); `env.staging` = `finneas-tg-bot-staging`;
`env.production` = `register-bot` (do not rename: that would orphan the DO namespace with
chat history). `vars`, `durable_objects`, `ratelimits` are repeated per env; change all
three. There is no plain `deploy` script on purpose. `.github/workflows/deploy.yml` deploys
staging after green CI on `main` and production only via the approved `production` env.
`GET /health` and `/version` report `VERSION` (git SHA).

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
- Never use `expect(stubCall()).rejects` on a DO RPC promise: it reads pipelined
  properties, which create extra promises that reject unhandled and fail the run in CI.
  Use `.then(() => null, (e) => e)` and assert on the error.
- Check the exit code of `pnpm test`, not just the summary: unhandled rejections fail
  the run even when every test passes.
- Durable Object tests use unique names per test (`getByName`) and
  `runInDurableObject` to read SQLite directly.

## Code map (finneas-tg-bot/src)

| Path | What |
|---|---|
| `index.ts` | Hono app: `POST /`, `POST /process`, `GET /health`; exports `AgentDO` |
| `routes/webhook.ts` | Telegram webhook: secret, allowlist, rate limit, QStash publish / inline processing |
| `routes/process.ts` | QStash consumer: signature check → `processUpdate()` |
| `bot/processUpdate.ts` | Builds the bot per update, error boundary + retry policy, `handlerKind` |
| `bot/createBot.ts` | Registers handlers (commands before text) |
| `bot/handlers/{commands,text,voice,photo}.ts` | One handler each; receive `env` |
| `bot/replyWithAgent.ts` | Shared text/voice → `AgentDO.chat()` → reply |
| `bot/files.ts` | Telegram file download with the 20 MB guard |
| `lib/openrouter.ts` | **Only** OpenRouter client: `chat`, `vision` (strict `json_schema`), `transcribe`; models from `CHAT_MODEL`/`VISION_MODEL`/`STT_MODEL` |
| `lib/receipt.ts` | Zod `ModelReceiptSchema` (raw strings from the model) → `normaliseReceipt` (amount/currency/date parsing in code) → `ReceiptSchema`; `extractReceipt` never throws on bad model output |
| `lib/AgentDO.ts` | Per-chat Durable Object |
| `lib/{errors,log,security,telegram}.ts` | Retry classification, structured logs, auth, Telegram output helpers |

`Env` is the generated global from `worker-configuration.d.ts` (no hand-written interface).
`pnpm cf-typegen` reads `.dev.vars.example` so secrets are typed: add every new secret
there. `tsconfig.json` has no Node types (no `nodejs_compat`); `scripts/` has its own.

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
- All OpenRouter calls go through `openrouterPost()` in `src/lib/openrouter.ts`:
  shared headers, 25 s timeout (cleared timer, not `AbortSignal.timeout`, which kept DOs
  busy and hung `evictDurableObject` in tests), status checks, no response bodies in errors.
- Replies go through `sendLongMessage()` (splits at 4096 chars). Model-provided values in
  formatted messages use HTML parse mode with `escapeHtml()`; never legacy Markdown.

## AgentDO (finneas-tg-bot/src/lib/AgentDO.ts)

- One DO per chat (`env.AGENT_DO.getByName(chatId)`), history in SQLite `chat_messages`.
- Single RPC: `chat({ updateId, text, source })` → `{ answer, duplicate }`. Then
  `markReplied(updateId)` after the reply is sent. A repeated `updateId` never calls the
  model; the stored answer is re-sent only if `replied` is false (first reply failed).
- Calls are serialised with a promise-chain queue (not `blockConcurrencyWhile`, which
  would also block `/new`). User + assistant rows are written in one transaction after
  the model succeeds, with `update_id`, `model`, token counts.
- The system prompt (`src/SYSTEM_PROMPT.ts`) is prepended at call time and never stored.
  Context = system + last `MAX_CONTEXT_MESSAGES - 1` stored rows + the new message
  (var, default 30). Model from `CHAT_MODEL` var.
- Schema changes: append to `MIGRATIONS` (never edit a released one). They run in the
  constructor under `blockConcurrencyWhile`, tracked in `schema_migrations`. Current: v2.
  SQLite cannot alter a CHECK constraint; rebuilding the table is needed for new roles.

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
- [x] #14 idempotent pipeline
- [x] #15 AgentDO: one `chat()` RPC, live system prompt, bounded context, per-chat queue,
  migrations. Conversation summaries (optional in the issue) are not implemented.
- [x] #17 staging/production envs, deploy workflow, `/health`. Needs Oscar: Cloudflare
  token + account id secrets, GitHub environments, staging bot + secrets, custom domains (#2).
- [x] #18 refactor: Hono + split handlers, single OpenRouter client, Zod receipt schema,
  generated `Env`, 20 MB / 120 s input guards, dead code removed. **Unverified**: that
  `VISION_MODEL` (`deepseek/deepseek-v4.1-flash`) supports image input + structured outputs
  on OpenRouter (no network from the dev container). Swap the var if it doesn't.
- [x] #16 local dev: `.dev.vars.example`, tunnel, `DIRECT_PROCESSING`, webhook scripts, README
- [x] #13 CI workflow. Branch protection on `main` (require `check`) must be set by Oscar in GitHub settings.
- [x] #19 hygiene: catalog, base tsconfig, Biome + lefthook + Renovate, `.gitignore`,
  extractors in the workspace with outputs ignored, package rename. The scraped
  `tuzonamarket-productos-carabobo.json` and `TuZonaMarketSession.md` were removed from the
  tree (still in history at `de96847`); uploading the JSON to R2 is left to Oscar.
