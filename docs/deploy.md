# Deploying Finneas

## Environments

| | Local | Staging | Production |
|---|---|---|---|
| Wrangler env | top level | `--env staging` | `--env production` |
| Worker | `finneas-tg-bot-dev` (never deployed) | `finneas-tg-bot-staging` | `register-bot` (unchanged, keeps chat history) |
| Telegram bot | your dev bot | `finneas_staging_bot` | the real bot |
| Deployed by | nobody | CI, on every green push to `main` | `Deploy` workflow, manual or `v*` tag, after approval |

Staging and production have separate bots, secrets, OpenRouter keys and Durable Object data.

## One-time setup

1. **Bots.** Create `finneas_staging_bot` with @BotFather.
2. **Secrets per environment** (repeat with `--env production`):
   ```sh
   cd finneas-tg-bot
   for s in FINNEAS_BOT_TOKEN FINNEAS_BOT_INFO TELEGRAM_WEBHOOK_SECRET QSTASH_TOKEN \
            QSTASH_CURRENT_SIGNING_KEY QSTASH_NEXT_SIGNING_KEY OPENROUTER_API_KEY; do
     pnpm exec wrangler secret put "$s" --env staging
   done
   ```
   or `pnpm exec wrangler secret bulk secrets.staging.json --env staging` (keep that file out of git).
   Use a staging OpenRouter key with a small credit limit, and set a monthly limit on the production key.
3. **Allowlist.** Put your Telegram user id in `ALLOWED_USER_IDS` under `env.production.vars`
   (and `env.staging.vars`) in `wrangler.jsonc`. Empty means nobody can use the bot.
4. **GitHub.**
   - Repository secrets: `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers", this account only)
     and `CLOUDFLARE_ACCOUNT_ID`.
   - Environments `staging` and `production`; give `production` a required reviewer (you).
   - Optional variables `STAGING_HEALTH_URL` / `PRODUCTION_HEALTH_URL`
     (e.g. `https://finneas-tg-bot-staging.<subdomain>.workers.dev/health`) enable the post-deploy smoke test.
   - Branch protection on `main`: require the `check` job from CI.
5. **Webhooks** (after the first deploy of each env):
   ```sh
   node --env-file=secrets.staging.env scripts/webhook.ts set --url https://finneas-tg-bot-staging.<subdomain>.workers.dev/
   ```
   The env file needs `FINNEAS_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` for that bot.

## What's deployed

`GET /health` and the `/version` command return the git SHA the Worker was deployed with
(`--var VERSION:<sha>`), or `dev` locally.

## Rollback

```sh
cd finneas-tg-bot
pnpm exec wrangler deployments list --env production
pnpm exec wrangler rollback --env production            # previous version
pnpm exec wrangler rollback <version-id> --env production
```

A rollback does not undo Durable Object schema migrations. Migrations only add columns or
rows, so older code keeps working with a newer schema.

For gradual rollouts: `wrangler versions upload --env production`, then
`wrangler versions deploy --env production` with a percentage split.

## Custom domains

Once `finneas.dev` is on Cloudflare (#2), uncomment the `routes` entries in `wrangler.jsonc`
(`tghooks.finneas.dev`, `tghooks-staging.finneas.dev`) and re-run `webhook:set` with the new URL.

## Finances API

`finneas-finances-api` is not deployed by the workflow yet. When it is, give it the same
`env.staging` / `env.production` split, each with its own Neon branch and Hyperdrive config id.

## Turning on receipt saving and agent tools (#20)

The bot side is complete but **off** until the finances API implements its RPC methods
(`finneas-finances-api/src/rpc.ts` currently throws; storage is #1/#5). The switch is the
`FINANCES_API` service binding: without it the bot shows receipts read-only and offers the
model no tools.

1. Implement `FinancesApi.createMovement` / `listRecentMovements` / `getBalance` in
   `finneas-finances-api` against the contract in `src/contract.ts` (idempotent on
   `idempotencyKey`, `source` → the `created_via` column from #8), and deploy it per env.
2. Add the binding to each environment in `finneas-tg-bot/wrangler.jsonc`:
   ```jsonc
   "services": [{ "binding": "FINANCES_API", "service": "finneas-finances-api", "entrypoint": "FinancesApi" }]
   ```
   (use the staging API's Worker name under `env.staging`).
3. `pnpm cf-typegen`, then remove the hand-written `FINANCES_API` declaration in
   `src/types/env.d.ts` if the generated type covers it.
