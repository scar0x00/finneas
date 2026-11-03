# Finneas

Finneas is a personal-finance assistant on Telegram: send it a text, a voice note or a
photo of a bank receipt and it helps you register expenses. It runs on Cloudflare Workers.

Still a work in progress.

## Architecture

```
Telegram ──POST /──▶ finneas-tg-bot Worker ──publish──▶ QStash ──POST /process──▶ finneas-tg-bot Worker
                     (secret + allowlist + rate limit)          (signed, retried)   grammY handlers
                                                                                    ├─ AgentDO (one per chat, SQLite history) ─▶ OpenRouter chat
                                                                                    ├─ voice ─▶ OpenRouter Whisper
                                                                                    └─ photo ─▶ OpenRouter vision (receipt JSON)
```

| Package | What |
|---|---|
| `finneas-tg-bot/` | The Telegram bot Worker |
| `finneas-finances-api/` | Hono Worker in front of the Neon database (in progress) |
| `extractors/` | Standalone scrapers (not part of the workspace) |

## Prerequisites

- Node.js 22.18+ and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up)
- A **separate dev bot** from [@BotFather](https://t.me/BotFather), e.g. `finneas_dev_bot`.
  A bot can only have one webhook, so never point the production bot at your laptop.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the tunnel
- An OpenRouter key with a low credit limit

## Setup

```sh
pnpm install
cd finneas-tg-bot
cp .dev.vars.example .dev.vars   # fill it in; DIRECT_PROCESSING=true skips QStash locally
```

Get `FINNEAS_BOT_INFO` from `https://api.telegram.org/bot<token>/getMe` (the `result` JSON),
`TELEGRAM_WEBHOOK_SECRET` from `openssl rand -hex 32`, and your Telegram user id for
`ALLOWED_USER_IDS` from [@userinfobot](https://t.me/userinfobot).

## Local loop

Three terminals, all in `finneas-tg-bot/`:

```sh
pnpm dev                                   # wrangler dev on :8787
pnpm dev:tunnel                            # prints https://<random>.trycloudflare.com
pnpm webhook:set --url https://<random>.trycloudflare.com
```

Message your dev bot. With `DIRECT_PROCESSING=true` the update is processed inline, no
QStash needed. `pnpm webhook:info` shows the current URL, pending updates and the last
delivery error; `pnpm webhook:delete` removes it.

To test the QStash path, run the local QStash server (`pnpx @upstash/qstash-cli dev`),
copy the token and signing keys it prints into `.dev.vars`, set
`QSTASH_URL=http://127.0.0.1:8080` and `DIRECT_PROCESSING=false`.

## Commands

| Where | Command | What |
|---|---|---|
| root | `pnpm test` / `pnpm typecheck` / `pnpm build` | All packages |
| bot | `pnpm test` (`test:watch`) | Offline test suite (Vitest + workerd) |
| bot | `pnpm dev` / `pnpm dev:tunnel` | Local Worker / public tunnel |
| bot | `pnpm webhook:set --url …` / `webhook:info` / `webhook:delete` | Manage the Telegram webhook |
| bot | `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `FINNEAS_BOT_TOKEN`, `FINNEAS_BOT_INFO` | secret | Telegram bot |
| `TELEGRAM_WEBHOOK_SECRET` | secret | Webhook `secret_token`; requests without it get 401 |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | secret | QStash |
| `OPENROUTER_API_KEY` | secret | All model calls |
| `ALLOWED_USER_IDS` | var | Comma-separated Telegram user ids allowed to use the bot |
| `QSTASH_URL`, `CHAT_MODEL`, `MAX_CONTEXT_MESSAGES` | var | See `wrangler.jsonc` |
| `DIRECT_PROCESSING` | local only | `true` skips QStash in `wrangler dev` |
