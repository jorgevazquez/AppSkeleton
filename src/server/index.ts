/**
 * Bootstrap entry point.
 *
 * This is intentionally a minimal placeholder so the toolchain (build, dev
 * server, tests) is provable end-to-end before the kernel exists. The real
 * bootstrap sequence — load config, construct the plugin kernel, discover
 * and load plugins from src/plugins/*, mount api-gateway's Fastify instance,
 * listen — is built out by the early, high-priority items in
 * feature_list.json. Do not hand-build the kernel here; track it as
 * features so progress stays visible in feature_list.json.
 */
import Fastify from "fastify";
import { createLogger } from "../core/logger.js";

export function buildServer() {
  const app = Fastify({
    // Use the kernel's own createLogger() rather than Fastify's built-in
    // `logger: true` pino instance — the latter has no knowledge of this
    // codebase's secret-redaction hook, so a future route handler logging
    // e.g. `request.log.info({ headers: request.headers }, ...)` would emit
    // an Authorization header (or any other secret-shaped field) in the
    // clear. `loggerInstance` reuses one already-redacting logger for
    // Fastify's own request logging and every `request.log` child logger
    // derived from it.
    loggerInstance: createLogger({ context: { module: "http" } }),
  });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

async function main() {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("index.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
