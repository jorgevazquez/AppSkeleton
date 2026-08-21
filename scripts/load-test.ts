#!/usr/bin/env -S npx tsx
/**
 * Load-testing harness for feature #110 ("Load testing harness with a
 * documented baseline").
 *
 * Wired up via `npm run load-test` (see package.json). Drives `autocannon`
 * against a handful of "key api-gateway and wiki routes" (step 1) mounted
 * on a *real* local instance of this codebase's own plugins — the exact
 * same `api-gateway` + `rbac` + `html-renderer` + `wiki` modules production
 * loads, wired through the real capability broker/loader
 * (`createCapabilityBroker()`/`loadPlugins()`), backed by a real MySQL
 * connection — not a mock server. This mirrors
 * `tests/plugins/wiki/http-routes.integration.test.ts`'s own "real plugins,
 * real broker" pattern (including that suite's `login-fixture` stand-in,
 * since wiki has no login route of its own — see that file's module doc),
 * except this script calls `app.listen()` to accept real HTTP/TCP
 * connections instead of `app.inject()`, since `autocannon` needs an actual
 * socket to hammer.
 *
 * What this script does NOT do: run the full `bootstrapKernel()` dynamic
 * plugin-discovery path `src/server/index.ts` uses for a real deployment.
 * It wires only the plugins the target routes actually need, the same
 * deliberate scope `http-routes.integration.test.ts` already established —
 * a full `npm run dev` server point is equally valid to load-test manually
 * (see `docs/performance-baseline.md`'s notes), but exercising every
 * unrelated plugin's own `onEnable` adds nothing to *this* script's own
 * numbers while adding real setup/teardown complexity (seeding every other
 * plugin's own tables).
 *
 * Requires a running MySQL instance (`docker compose up -d mysql`, or
 * `./init.sh`) with migrations already applied (`npm run migrate`) — same
 * prerequisite as every `*.integration.test.ts` in this repo.
 *
 * Usage:
 *   npm run load-test
 *   LOAD_TEST_DURATION_S=30 LOAD_TEST_CONNECTIONS=50 npm run load-test
 *
 * Env overrides (all optional, sane defaults below):
 *   LOAD_TEST_DURATION_S    — seconds each scenario runs for (default 10)
 *   LOAD_TEST_CONNECTIONS   — concurrent connections per scenario (default 20)
 *   LOAD_TEST_PORT          — port the throwaway server binds to (default 4100)
 *   LOAD_TEST_SEED_PAGES    — number of wiki pages pre-seeded for read
 *                              scenarios to page through (default 50)
 *
 * Every scenario runs sequentially (never overlapping) so one scenario's
 * load never contends with another's for the numbers to stay comparable —
 * see `docs/performance-baseline.md` for the recorded baseline this script
 * produced and how to interpret it.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
// `autocannon` (v8) ships no type declarations of its own, and
// `@types/autocannon` on npm only covers up to v7 — rather than depend on
// a mismatched third-party types package or sprinkle `any` through this
// file, {@link AutocannonRunOptions}/{@link AutocannonResult} below declare
// only the small slice of autocannon's actual runtime shape this script
// uses (verified against `node_modules/autocannon/lib/`), and
// `runAutocannon` is the one place the import is cast to that shape.
import autocannonImport from "autocannon";
import { createCapabilityBroker } from "../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../src/core/loader.js";
import { createLogger } from "../src/core/logger.js";
import type { PluginManifest } from "../src/core/manifest.js";
import { isOk } from "../src/core/types.js";
import * as apiGatewayModule from "../src/plugins/api-gateway/index.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  issueSessionCookie,
  loadSessionConfig,
  type HttpRouteCapability,
} from "../src/plugins/api-gateway/index.js";
import { createKyselyDb } from "../src/plugins/database-mysql/src/db.js";
import { createDbPoolFromEnv } from "../src/plugins/database-mysql/src/pool.js";
import { createDbQueryCapability } from "../src/plugins/database-mysql/src/query-capability.js";
import * as htmlRendererModule from "../src/plugins/html-renderer/index.js";
import * as rbacModule from "../src/plugins/rbac/index.js";
import { policyStore } from "../src/plugins/rbac/index.js";
import * as wikiModule from "../src/plugins/wiki/index.js";
// `npm run migrate` only discovers `database-mysql`'s own migrations
// directory (see `src/plugins/database-mysql/src/migrate.ts`'s
// `MIGRATIONS_DIR`) — there is no wired-up `db:migrate` capability that
// applies a plugin's own `src/migrations/` yet (see
// `src/plugins/wiki/src/migrations-dir.ts`'s own doc comment, which
// explicitly names "this feature's own integration test" as the allowed
// caller today). So, exactly like
// `tests/plugins/wiki/http-routes.integration.test.ts`, this script applies
// wiki's three page/namespace/revision migrations directly and rolls them
// back when done, leaving the shared dev database exactly as it found it.
import * as createNamespaces from "../src/plugins/wiki/src/migrations/0001_create_wiki_namespaces.js";
import * as createPages from "../src/plugins/wiki/src/migrations/0002_create_wiki_pages.js";
import * as createRevisions from "../src/plugins/wiki/src/migrations/0003_create_wiki_revisions.js";

const DURATION_S = Number(process.env["LOAD_TEST_DURATION_S"] ?? 10);
const CONNECTIONS = Number(process.env["LOAD_TEST_CONNECTIONS"] ?? 20);
const PORT = Number(process.env["LOAD_TEST_PORT"] ?? 4100);
const SEED_PAGE_COUNT = Number(process.env["LOAD_TEST_SEED_PAGES"] ?? 50);
const NAMESPACE_ID = `load-test-${randomUUID().slice(0, 8)}`;
const SESSION_SECRET =
  process.env["SESSION_SECRET"] ?? "load-test-session-secret-at-least-32-characters-long";

function manifest(
  id: string,
  options: { dependsOn?: Record<string, string>; provides?: string[]; requires?: string[] } = {},
): PluginManifest {
  return {
    id,
    version: "1.0.0",
    depends_on: options.dependsOn ?? {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

/** Same stand-in `http-routes.integration.test.ts` uses — wiki has no login route of its own, so this mints a session cookie for a caller identity this script then grants RBAC roles to directly (see that file's own module doc for the precedent). Load-test only; never mounted by `bootstrapKernel()`. */
function loginFixtureModule(): PluginModule {
  return {
    onEnable(context) {
      const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
      if (!obtained.ok) {
        throw obtained.error;
      }
      obtained.value.registerRoute({
        method: "GET",
        path: "/login",
        schema: {
          querystring: { type: "object" },
          response: {
            200: {
              type: "object",
              properties: { userId: { type: "string" } },
              required: ["userId"],
            },
          },
        },
        handler: async (_request, reply) => ({
          userId: issueSessionCookie(reply, loadSessionConfig()),
        }),
      });
    },
  };
}

function findSetCookie(headers: Record<string, unknown>, cookieName: string): string {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const match = values.find((value) => value.startsWith(`${cookieName}=`));
  if (match === undefined) {
    throw new Error(`expected a Set-Cookie header named "${cookieName}"`);
  }
  return match.split(";")[0] as string;
}

/** autocannon's `client` argument to `setupClient` — only the methods this script actually calls. */
interface AutocannonClient {
  on(event: "request", listener: () => void): void;
  setBody(body: string): void;
}

/** The subset of autocannon's `Options` this script passes — see this file's header doc comment on why this is hand-declared instead of `@types/autocannon`. */
interface AutocannonRunOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  connections?: number;
  duration?: number;
  setupClient?: (client: AutocannonClient) => void;
}

/** The subset of autocannon's `Result` this script reads — see this file's header doc comment. */
interface AutocannonResult {
  requests: { average: number };
  latency: { average: number; p50: number; p99: number };
  "2xx": number;
  non2xx: number;
  errors: number;
}

const runAutocannon = autocannonImport as unknown as (
  opts: AutocannonRunOptions,
) => Promise<AutocannonResult>;

interface ScenarioResult {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly result: AutocannonResult;
}

async function runScenario(name: string, opts: AutocannonRunOptions): Promise<ScenarioResult> {
  process.stdout.write(
    `\n-> Running scenario "${name}" (${DURATION_S}s, ${CONNECTIONS} connections)...\n`,
  );
  const result = await runAutocannon({
    connections: CONNECTIONS,
    duration: DURATION_S,
    ...opts,
  });
  process.stdout.write(
    `   ${result.requests.average.toFixed(1)} req/s avg, ${result.latency.p99}ms p99 latency, ` +
      `${result["2xx"]} 2xx / ${result.non2xx} non-2xx / ${result.errors} errors\n`,
  );
  return {
    name,
    method: opts.method ?? "GET",
    path: opts.url.replace(`http://127.0.0.1:${PORT}`, ""),
    result,
  };
}

function formatBaselineTable(scenarios: readonly ScenarioResult[]): string {
  const header =
    "| Scenario | Method | Path | Req/s (avg) | Latency p50 (ms) | Latency p99 (ms) | 2xx | non-2xx | Errors |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = scenarios.map((s) => {
    const r = s.result;
    return `| ${s.name} | ${s.method} | \`${s.path}\` | ${r.requests.average.toFixed(1)} | ${r.latency.p50} | ${r.latency.p99} | ${r["2xx"]} | ${r.non2xx} | ${r.errors} |`;
  });
  return [header, divider, ...rows].join("\n");
}

const WIKI_TABLES = ["wiki_revisions", "wiki_pages", "wiki_namespaces"] as const;

async function main(): Promise<void> {
  const pool = createDbPoolFromEnv();
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);

  // Ensure a clean slate, then apply wiki's own migrations directly (see
  // this file's header import comment) — mirrors
  // http-routes.integration.test.ts's own beforeAll exactly.
  for (const table of WIKI_TABLES) {
    await pool.query("DROP TABLE IF EXISTS `" + table + "`");
  }
  await createNamespaces.up(db);
  await createPages.up(db);
  await createRevisions.up(db);

  // Raise the rate limit for the duration of this load test — the
  // production default (RATE_LIMIT_MAX=300/minute, see
  // docs/rate-limiting.md) exists to bound *abusive* traffic, and would
  // otherwise dominate these numbers with 429s well before connection/DB
  // throughput becomes the real bottleneck we're trying to measure. See
  // docs/performance-baseline.md's own notes section for how the
  // production default behaves under this same load instead (documented
  // qualitatively there, not as a separate scenario here, since it's a
  // deliberate, already-covered-by-tests config behavior rather than
  // something this throughput baseline needs to re-measure).
  const previousRateLimitMax = process.env["RATE_LIMIT_MAX"];
  process.env["RATE_LIMIT_MAX"] = "1000000";
  process.env["SESSION_SECRET"] = SESSION_SECRET;

  const API_GATEWAY_MANIFEST = manifest("api-gateway", {
    provides: ["http:route"],
    requires: ["rbac:check", "render:template", "html:error-pages"],
  });
  const RBAC_MANIFEST = manifest("rbac", {
    dependsOn: { "api-gateway": "^1.0.0" },
    provides: ["rbac:check", "rbac:manage"],
    requires: ["http:route"],
  });
  const HTML_RENDERER_MANIFEST = manifest("html-renderer", {
    provides: ["render:template", "html:error-pages"],
  });
  const DB_FIXTURE_MANIFEST = manifest("db-fixture", { provides: ["db:query"] });
  const WIKI_MANIFEST = manifest("wiki", {
    dependsOn: { "api-gateway": "^1.0.0" },
    requires: ["rbac:check", "db:query", "render:template", "http:route"],
  });
  const LOGIN_FIXTURE_MANIFEST = manifest("login-fixture", {
    dependsOn: { "api-gateway": "^1.0.0" },
    requires: ["http:route"],
  });

  const definitions: PluginDefinition[] = [
    { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
    { manifest: RBAC_MANIFEST, module: rbacModule },
    { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
    { manifest: DB_FIXTURE_MANIFEST, module: { provides: { "db:query": queryCapability } } },
    { manifest: WIKI_MANIFEST, module: wikiModule },
    { manifest: LOGIN_FIXTURE_MANIFEST, module: loginFixtureModule() },
  ];

  const broker = createCapabilityBroker();
  // "warn" (not the kernel's usual "info" default) — otherwise Fastify's
  // per-request access log (api-gateway's own `loggerInstance`, see
  // ../src/plugins/api-gateway/index.ts) would emit one line per load-test
  // request, drowning out this script's own scenario summaries.
  const loadResult = await loadPlugins(definitions, broker, {
    logger: createLogger({ level: "warn", context: { module: "load-test" } }),
  });
  if (!isOk(loadResult) || loadResult.value.failed.length > 0) {
    throw new Error(`fixture plugin load failed: ${JSON.stringify(loadResult)}`);
  }

  const app = (apiGatewayModule.provides?.["http:route"] as HttpRouteCapability).getApp();

  // Seed RBAC: viewer/editor/admin permission grants, matching the real
  // production policy shape (`policyStore` is in-memory, exported mutable
  // state — see `rbac/index.ts`'s own docs — so pushing to it directly here
  // is the same thing `rbac:manage` would do over HTTP, just without the
  // network round trip).
  policyStore.rolePermissions.push(
    { roleId: "viewer", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:read" },
    { roleId: "admin", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:admin" },
  );

  await db
    .insertInto("wiki_namespaces")
    .values({ id: NAMESPACE_ID, name: "Load Test Namespace" })
    .execute();

  process.stdout.write(
    `-> Seeding ${SEED_PAGE_COUNT} wiki pages in namespace "${NAMESPACE_ID}"...\n`,
  );
  for (let i = 0; i < SEED_PAGE_COUNT; i++) {
    await db
      .insertInto("wiki_pages")
      .values({
        namespace_id: NAMESPACE_ID,
        slug: `seed-page-${i}`,
        title: `Load Test Page ${i}`,
        content: `This is seeded load-test content for page ${i}. It mentions the word "throughput" so search queries have something to match.`,
      })
      .execute();
  }
  const firstPage = await db
    .selectFrom("wiki_pages")
    .select("id")
    .where("namespace_id", "=", NAMESPACE_ID)
    .orderBy("id", "asc")
    .executeTakeFirstOrThrow();

  const address = await app.listen({ port: PORT, host: "127.0.0.1" });
  process.stdout.write(`-> Server listening at ${address}\n`);

  try {
    // Mint an authenticated ("editor") session the same way
    // http-routes.integration.test.ts does: hit the login-fixture route
    // over real HTTP, then grant the returned userId the "editor" role.
    const loginRes = await fetch(`${address}/api/v1/login`);
    const loginBody = (await loginRes.json()) as { userId: string };
    const sidCookie = findSetCookie(Object.fromEntries(loginRes.headers.entries()), "sid");
    policyStore.userRoles.push({ userId: loginBody.userId, roleId: "editor" });

    // Obtain a csrf_token cookie + matching header value for the write
    // scenario (any request without one gets issued one — see
    // src/plugins/api-gateway/src/csrf.ts).
    const csrfRes = await fetch(`${address}/api/v1/wiki/pages?namespaceId=${NAMESPACE_ID}`, {
      headers: { cookie: sidCookie },
    });
    const csrfCookie = findSetCookie(
      Object.fromEntries(csrfRes.headers.entries()),
      CSRF_COOKIE_NAME,
    );
    const csrfToken = csrfCookie.slice(`${CSRF_COOKIE_NAME}=`.length);
    const authCookie = `${sidCookie}; ${csrfCookie}`;

    const scenarios: ScenarioResult[] = [];

    scenarios.push(
      await runScenario("api-gateway: health check", {
        url: `${address}/health`,
        method: "GET",
      }),
    );

    scenarios.push(
      await runScenario("api-gateway: OpenAPI document", {
        url: `${address}/api/v1/openapi.json`,
        method: "GET",
      }),
    );

    scenarios.push(
      await runScenario("wiki: list pages (authenticated read)", {
        url: `${address}/api/v1/wiki/pages?namespaceId=${NAMESPACE_ID}`,
        method: "GET",
        headers: { cookie: sidCookie },
      }),
    );

    scenarios.push(
      await runScenario("wiki: get single page (authenticated read)", {
        url: `${address}/api/v1/wiki/pages/${firstPage.id}`,
        method: "GET",
        headers: { cookie: sidCookie },
      }),
    );

    scenarios.push(
      await runScenario("wiki: full-text search (authenticated read)", {
        url: `${address}/api/v1/wiki/search?q=throughput&namespaceId=${NAMESPACE_ID}`,
        method: "GET",
        headers: { cookie: sidCookie },
      }),
    );

    scenarios.push(
      await runScenario("wiki: create page (authenticated write)", {
        url: `${address}/api/v1/wiki/pages`,
        method: "POST",
        headers: {
          cookie: authCookie,
          [CSRF_HEADER_NAME]: csrfToken,
          "content-type": "application/json",
        },
        // Every request needs a unique slug (namespace+slug is a unique
        // index — see 0002_create_wiki_pages.ts) — setupClient's 'request'
        // hook regenerates the body immediately before each send, the
        // documented autocannon pattern for per-request dynamic payloads.
        setupClient: (client) => {
          client.on("request", () => {
            client.setBody(
              JSON.stringify({
                namespaceId: NAMESPACE_ID,
                slug: `created-${randomUUID()}`,
                title: "Load Test Created Page",
                content: "Created during the load-test write scenario.",
              }),
            );
          });
        },
      }),
    );

    process.stdout.write("\n" + "=".repeat(72) + "\n");
    process.stdout.write(
      "Baseline summary (markdown table — paste into docs/performance-baseline.md)\n",
    );
    process.stdout.write("=".repeat(72) + "\n\n");
    process.stdout.write(formatBaselineTable(scenarios) + "\n");
  } finally {
    await app.close();
    // Roll back the migrations this run applied at startup, leaving the
    // shared dev database exactly as this script found it (mirrors
    // http-routes.integration.test.ts's own afterAll).
    await createRevisions.down(db);
    await createPages.down(db);
    await createNamespaces.down(db);
    await db.destroy();
    if (previousRateLimitMax === undefined) {
      delete process.env["RATE_LIMIT_MAX"];
    } else {
      process.env["RATE_LIMIT_MAX"] = previousRateLimitMax;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("load-test failed:", error);
    process.exit(1);
  });
