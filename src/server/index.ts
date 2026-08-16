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

export function buildServer() {
  const app = Fastify({
    logger: true,
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
