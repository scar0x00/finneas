My stack:

- DB: Neon, SQLite DOs, D1, DuckDB (for analytics)
- Compute: Cloudflare Workers,  Google Cloud `Cloud Run` containers, Cloudflare Containers
- Service communication: CF Queues, QStash
- Object Storage: R2 + S3 (for archiving)
- Caching and distributed locking/coordination: Upstash, Cloudflare KV
- Search (vector, fts, etc): Upstash Search, Upstash Vector, DuckDB
- Long running tasks: Cloudflare Workflows, QStash
- Scheduling: QStash
- Email: Cloudflare Email service/Resend