import { Hono } from "hono";
import { version } from "./bot/handlers/commands";
import { AgentDO } from "./lib/AgentDO";
import { processRoute } from "./routes/process";
import { telegramWebhook } from "./routes/webhook";

/**
 * HTTP surface:
 * - POST /         Telegram webhook → QStash (src/routes/webhook.ts)
 * - POST /process  QStash consumer → grammY handlers (src/routes/process.ts)
 * - GET  /health   liveness + deployed version
 */
const app = new Hono<{ Bindings: Env }>();

app.post("/", (c) => telegramWebhook(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.post("/process", (c) => processRoute(c.req.raw, c.env));
app.get("/health", (c) => c.json({ status: "ok", version: version(c.env) }));
app.notFound((c) => c.text("Not Found", 404));

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;

export { AgentDO };
