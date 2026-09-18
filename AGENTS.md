# Finneas — register-bot

Cloudflare Worker that receives Telegram updates and runs an AI expense-registration assistant. All source lives in `register-bot/`; the git root is this directory. Run every command from `register-bot/`.

## Cloudflare Workers: fetch current docs first

Your knowledge of Workers APIs and limits may be outdated. Retrieve current docs before touching bindings, Durable Objects, storage, or limits:

- https://developers.cloudflare.com/workers/
- Limits/quotas: the product's `/platform/limits/` page (e.g. `/workers/platform/limits/`)
- MCP: `https://docs.mcp.cloudflare.com/mcp`

## Commands (run in `register-bot/`)

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install. pnpm only (`pnpm-lock.yaml`); `pnpm-workspace.yaml` pre-approves the `esbuild`/`workerd` build scripts required by pnpm 11+ |
| `pnpm dev` | Local dev (`wrangler dev`) |
| `pnpm test` | Vitest watch; `pnpm test -- run` for a single pass |
| `pnpx tsc --noEmit` | Typecheck — there is no `typecheck` script |
| `pnpx wrangler types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` bindings |
| `pnpm deploy` | Deploy to Cloudflare |

## Architecture

- `src/index.ts` `fetch` is the entire HTTP surface:
  - `POST /` — Telegram webhook. Sends a typing action, publishes the update to QStash, returns 200 immediately.
  - `POST /process` — verifies `Upstash-Signature` with the QStash signing keys, builds a grammY `Bot`, registers handlers, then calls `bot.handleUpdate`. Async processing goes through QStash, **not** Cloudflare Queues (the `queues` block in `wrangler.jsonc` is commented out).
- `src/lib/AgentDO.ts` — `AgentDO` Durable Object, one per Telegram chat via `env.AGENT_DO.getByName(chatId)`. History is stored in SQLite (`ctx.storage.sql`) in a `chat_messages` table. The constructor throws if the DO is not named.
- `src/lib/runOpenrouterModel.ts`, `transcribe.ts`, `extractTransactionInfo.ts` — all model calls go to OpenRouter over `fetch` (chat / Whisper / vision). The `AI` binding in `wrangler.jsonc` is declared but unused.
- `Env` is hand-written in `src/index.ts` while `worker-configuration.d.ts` is generated; keep them consistent.

## Environment / secrets

- `.dev.vars` (gitignored) holds `FINNEAS_BOT_TOKEN`, `FINNEAS_BOT_INFO`, `QSTASH_*`, `OPENROUTER_API_KEY`. OpenRouter-dependent features fail locally because the key ships empty. Never commit this file.

## Testing quirks

- `test/index.spec.ts` is stale create-cloudflare boilerplate: it expects `"Hello World!"` but the worker returns `"Not Found"` for GET, so `pnpm test` currently fails. Fix or replace it; do not treat it as a spec.
- Vitest runs through `@cloudflare/vitest-plugin` bound to `wrangler.jsonc`; tests use their own `test/tsconfig.json`.