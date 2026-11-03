# finneas-finances-api

Hono Worker in front of the Finneas Neon Postgres database (through the `NEON_DB`
Hyperdrive binding). It will store movements and expose them to the bot (#1, #5, #3).

Status: a stub that answers `GET /`.

```sh
pnpm dev          # wrangler dev
pnpm typecheck
pnpm build        # wrangler deploy --dry-run
pnpm cf-typegen   # regenerate worker-configuration.d.ts (CloudflareBindings)
```

Deploying is not automated yet; see `../docs/deploy.md` for the planned staging/production split.
