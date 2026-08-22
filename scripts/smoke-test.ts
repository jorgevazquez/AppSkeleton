#!/usr/bin/env -S npx tsx
/**
 * Final end-to-end smoke suite (feature #120 — "Final end-to-end smoke
 * suite: fresh clone through running wiki").
 *
 * The canonical, documented verification procedure (see README's "Final
 * verification" section) is:
 *
 *   ./init.sh
 *   npm test
 *   npm run smoke-test
 *
 * This script is the third step: it boots the *real*, dynamically-
 * discovered kernel (`server/index.ts`'s own `bootstrapKernel()` — the
 * exact same code path `npm run dev`/`npm start` use, never a hand-wired
 * subset of plugins like `scripts/load-test.ts`/`scripts/capability-
 * audit.ts` deliberately use for their own narrower purposes), starts a
 * real HTTP listener on it, drives one real HTTP round-trip through the
 * wiki plugin (fetching — creating first, if this is a genuinely fresh
 * database — the wiki's own "Home" starter page, the same content
 * `wiki/seeds/index.ts` (feature #99) would seed), and confirms every
 * shipped plugin this repo ships (`rbac`, `database-mysql`, `html-
 * renderer`, `api-gateway`, `plugin-builder`, `wiki`) reports healthy in
 * `kernel.introspectWithHealth()`.
 *
 * ## Why this isn't just another `*.integration.test.ts`
 *
 * Every existing wiki integration suite (`http-routes.integration.test.ts`,
 * `e2e-lifecycle.integration.test.ts`, ...) hand-wires a small, deliberate
 * subset of plugins via `loadPlugins()` directly and drives them with
 * `app.inject()` — real Fastify dispatch, but no network socket, and never
 * the real `src/plugins/*` auto-discovery a production boot actually goes
 * through. This script is the one place that exercises the *entire* real
 * boot path end-to-end, exactly as an operator running `./init.sh && npm
 * run dev` would experience it, over a real TCP socket — which is what
 * feature #120 step 1 asks for ("boot the server and fetch the wiki home
 * page over real HTTP") and no existing suite already covers. It lives in
 * `scripts/`, wired via `npm run smoke-test` (not folded into `npm test`),
 * mirroring `load-test.ts`/`kernel-dispatch-benchmark.ts`/`capability-
 * audit.ts`'s own precedent: an operational verification tool with a real
 * MySQL dependency and its own npm script, not a fast, hermetic unit test.
 *
 * ## The two setup gaps this script works around
 *
 * 1. **Wiki tables aren't migrated by any real production path yet.**
 *    `docs/operator-guide.md` §2.3 documents this precisely: `npm run
 *    migrate` only applies `database-mysql`'s own migrations; `wiki` (and
 *    `rbac`) ship a `migrations-dir.ts` pointing at their own migration
 *    files, but nothing shipped calls `db:migrate` from their `onEnable`
 *    yet, so those files are today "exercised only by integration tests."
 *    This script joins that list — like every wiki integration suite and
 *    `load-test.ts` before it, it applies `wiki`'s three migrations
 *    directly (`0001_create_wiki_namespaces`/`0002_create_wiki_pages`/
 *    `0003_create_wiki_revisions`) via their own `up()`, but — unlike those
 *    suites, which tear their tables back down in `afterAll` since they run
 *    against a shared test database — it checks for the tables first
 *    (`db.introspection.getTables()`) and only creates them if truly
 *    absent, so re-running this script against an already-provisioned
 *    database is a no-op here, not a destructive reset.
 * 2. **This codebase ships no real login route.** `wiki`'s own module docs
 *    note session identity is resolved purely from a signed session
 *    cookie (`api-gateway`'s `./src/session.ts`) — there is no first-party
 *    authentication plugin yet to mint one via a real HTTP login flow. Every
 *    existing script/suite that needs an authenticated wiki request already
 *    established the same documented stand-in
 *    (`http-routes.integration.test.ts`'s own module doc calls it exactly
 *    that): mint a session id directly via `issueSessionId()` and grant the
 *    resulting caller RBAC permissions directly through `rbac`'s exported,
 *    deliberately-mutable `policyStore` (see that module's own doc comment
 *    — it is exported "so tests can inspect/tune it" precisely for this
 *    purpose, not test-only despite the phrasing). This script does the
 *    same, importing `policyStore` from the *same* `../src/plugins/rbac/
 *    index.js` module specifier `bootstrapKernel()`'s own dynamic
 *    `import()` resolves to — Node's ES module cache is keyed by resolved
 *    URL, not by which code path performed the import, so both references
 *    are the exact same singleton and a grant made here is immediately
 *    visible to the live kernel's own RBAC checks.
 *
 * Exits non-zero (with a clear, itemized report) if the server fails to
 * boot, the wiki round-trip fails, or any of the six shipped plugins isn't
 * reported loaded-and-healthy. Always attempts a graceful `shutdownKernel()`
 * before exiting, success or failure.
 */
import "dotenv/config";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  DEFAULT_API_VERSION,
  issueSessionId,
  loadSessionConfig,
  verifySessionId,
} from "../src/plugins/api-gateway/index.js";
import {
  formatIntrospectionReport,
  type KernelIntrospectionReport,
} from "../src/core/introspect.js";
import { createKyselyDb } from "../src/plugins/database-mysql/src/db.js";
import { createDbPoolFromEnv } from "../src/plugins/database-mysql/src/pool.js";
import { policyStore } from "../src/plugins/rbac/index.js";
import * as createNamespaces from "../src/plugins/wiki/src/migrations/0001_create_wiki_namespaces.js";
import * as createPages from "../src/plugins/wiki/src/migrations/0002_create_wiki_pages.js";
import * as createRevisions from "../src/plugins/wiki/src/migrations/0003_create_wiki_revisions.js";
import {
  HOME_PAGE_SLUG,
  MAIN_NAMESPACE_ID,
  SEED_NAMESPACES,
  SEED_PAGES,
} from "../src/plugins/wiki/seeds/index.js";
import { bootstrapKernel, listen, shutdownKernel } from "../src/server/index.js";

/** The six plugins README/spec.md describe as "shipped" — deliberately excludes `hello-world`, the plugin-authoring docs' own scaffolded example (see `docs/ai-plugin-authoring.md`), which is not part of this repo's own shipped-platform surface. */
const REQUIRED_PLUGIN_IDS = [
  "rbac",
  "database-mysql",
  "html-renderer",
  "api-gateway",
  "plugin-builder",
  "wiki",
] as const;

const WIKI_TABLE_MARKER = "wiki_namespaces";

interface WikiPageJson {
  readonly id: number;
  readonly namespaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly content: string;
  readonly contentHtml?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

/** Ensure `wiki`'s own tables exist (see this file's module doc, gap 1) — a no-op if they were already provisioned by a prior run/seed. */
async function ensureWikiSchema(db: ReturnType<typeof createKyselyDb>): Promise<void> {
  const tables = await db.introspection.getTables();
  if (tables.some((table) => table.name === WIKI_TABLE_MARKER)) {
    process.stdout.write(
      `-> wiki tables already present (found "${WIKI_TABLE_MARKER}") — skipping migration.\n`,
    );
    return;
  }
  process.stdout.write("-> wiki tables not found — applying wiki's own migrations directly...\n");
  await createNamespaces.up(db);
  await createPages.up(db);
  await createRevisions.up(db);
}

/** Ensure the `main` namespace (the wiki's own starter-content namespace, feature #99) exists — a no-op if it's already there. */
async function ensureMainNamespace(db: ReturnType<typeof createKyselyDb>): Promise<void> {
  const spec =
    SEED_NAMESPACES.find((namespace) => namespace.id === MAIN_NAMESPACE_ID) ??
    fail(`expected wiki/seeds/index.ts to declare a "${MAIN_NAMESPACE_ID}" namespace`);

  const existing = await db
    .selectFrom("wiki_namespaces")
    .select("id")
    .where("id", "=", MAIN_NAMESPACE_ID)
    .executeTakeFirst();
  if (existing) {
    process.stdout.write(`-> namespace "${MAIN_NAMESPACE_ID}" already exists — skipping insert.\n`);
    return;
  }
  process.stdout.write(`-> creating namespace "${MAIN_NAMESPACE_ID}"...\n`);
  await db
    .insertInto("wiki_namespaces")
    .values({
      id: spec.id,
      parent_id: spec.parentId,
      name: spec.name,
      description: spec.description,
    })
    .execute();
}

/** Read a `Set-Cookie` pair (`name=value`, no attributes) named `cookieName` out of `response`, or throw. */
function findSetCookiePair(response: Response, cookieName: string): string {
  const cookies = response.headers.getSetCookie();
  const match = cookies.find((value) => value.startsWith(`${cookieName}=`));
  if (match === undefined) {
    fail(`expected a Set-Cookie header named "${cookieName}" in the response`);
  }
  return match.split(";")[0] as string;
}

/**
 * Mint a session for a synthetic "smoke-test" caller and grant it the wiki
 * permissions it needs (read/write/admin, global scope) directly through
 * `rbac`'s `policyStore` — see this file's module doc, gap 2, for why this
 * is the established, documented way to drive an authenticated real-HTTP
 * wiki request in this codebase absent a real login route.
 */
function mintAuthenticatedSession(): { cookieHeader: string; userId: string } {
  const sessionConfig = loadSessionConfig();
  const signedSessionId = issueSessionId(sessionConfig.SESSION_SECRET);
  const userId =
    verifySessionId(signedSessionId, sessionConfig.SESSION_SECRET) ??
    fail(
      "just-issued session id failed to verify against its own secret — this should be unreachable",
    );

  const roleId = "smoke-test-caller";
  policyStore.rolePermissions.push(
    { roleId, permissionId: "wiki:read" },
    { roleId, permissionId: "wiki:write" },
    { roleId, permissionId: "wiki:admin" },
  );
  policyStore.userRoles.push({ userId, roleId });

  return { cookieHeader: `${sessionConfig.SESSION_COOKIE_NAME}=${signedSessionId}`, userId };
}

/**
 * Fetch — creating it first over real HTTP if this is a genuinely fresh
 * database — the wiki's own "Home" starter page (feature #99's content),
 * proving the full stack (real HTTP → api-gateway routing → RBAC → wiki →
 * database-mysql → html-renderer's Markdown rendering) works end-to-end.
 */
async function fetchWikiHomePage(
  baseUrl: string,
  sidCookie: string,
): Promise<{ readonly status: number; readonly page: WikiPageJson }> {
  const homeSpec =
    SEED_PAGES.find(
      (page) => page.namespaceId === MAIN_NAMESPACE_ID && page.slug === HOME_PAGE_SLUG,
    ) ??
    fail(
      `expected wiki/seeds/index.ts to declare a "${HOME_PAGE_SLUG}" page in "${MAIN_NAMESPACE_ID}"`,
    );

  const listUrl = `${baseUrl}/api/${DEFAULT_API_VERSION}/wiki/pages?namespaceId=${MAIN_NAMESPACE_ID}`;
  const listRes = await fetch(listUrl, { headers: { cookie: sidCookie } });
  if (!listRes.ok) {
    fail(`GET ${listUrl} returned ${String(listRes.status)}: ${await listRes.text()}`);
  }
  const csrfCookie = findSetCookiePair(listRes, CSRF_COOKIE_NAME);
  const csrfToken = csrfCookie.slice(`${CSRF_COOKIE_NAME}=`.length);
  const { pages } = (await listRes.json()) as { pages: WikiPageJson[] };

  const existing = pages.find((page) => page.slug === HOME_PAGE_SLUG);
  let pageId: number;
  if (existing) {
    process.stdout.write(
      `-> wiki Home page already exists (id ${String(existing.id)}) — reusing it.\n`,
    );
    pageId = existing.id;
  } else {
    process.stdout.write("-> wiki Home page not found — creating it over real HTTP...\n");
    const createUrl = `${baseUrl}/api/${DEFAULT_API_VERSION}/wiki/pages`;
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        cookie: `${sidCookie}; ${csrfCookie}`,
        [CSRF_HEADER_NAME]: csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        namespaceId: MAIN_NAMESPACE_ID,
        slug: homeSpec.slug,
        title: homeSpec.title,
        content: homeSpec.content,
      }),
    });
    if (createRes.status !== 201) {
      fail(`POST ${createUrl} returned ${String(createRes.status)}: ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as WikiPageJson;
    pageId = created.id;
  }

  const getUrl = `${baseUrl}/api/${DEFAULT_API_VERSION}/wiki/pages/${String(pageId)}`;
  const getRes = await fetch(getUrl, { headers: { cookie: sidCookie } });
  if (!getRes.ok) {
    fail(`GET ${getUrl} returned ${String(getRes.status)}: ${await getRes.text()}`);
  }
  const page = (await getRes.json()) as WikiPageJson;
  return { status: getRes.status, page };
}

/** Check every {@link REQUIRED_PLUGIN_IDS} entry is `"loaded"` and, where a `health` field is present, `"healthy"`. Returns a list of human-readable problems — empty means everything's healthy. */
function checkShippedPluginHealth(report: KernelIntrospectionReport): string[] {
  const problems: string[] = [];
  for (const id of REQUIRED_PLUGIN_IDS) {
    const entry = report.plugins.find((plugin) => plugin.id === id);
    if (!entry) {
      problems.push(`"${id}" did not appear in the kernel introspection report at all.`);
      continue;
    }
    if (entry.status !== "loaded") {
      const detail = entry.error !== undefined ? ` (${entry.error})` : "";
      problems.push(`"${id}" is not loaded — status: "${entry.status}"${detail}.`);
      continue;
    }
    if (entry.health && entry.health.status !== "healthy") {
      const detail = entry.health.error !== undefined ? `: ${entry.health.error}` : "";
      problems.push(`"${id}" reported unhealthy${detail}.`);
    }
  }
  return problems;
}

/**
 * `config.ts`'s `CoreConfigSchema`-adjacent session config rejects the
 * unedited `.env.example` placeholder value outright (a real, deliberate
 * security guard from a prior feature) — so a truly untouched `.env` (the
 * "fresh clone, run init.sh, nothing hand-edited yet" case this whole
 * script is meant to exercise) would otherwise fail here before ever
 * reaching the HTTP round-trip below. `load-test.ts` hits the exact same
 * concern and resolves it the same way: this script unconditionally
 * overrides `SESSION_SECRET` for its own run, restoring whatever was
 * there afterwards, rather than requiring the operator to hand-edit
 * secrets before a non-interactive smoke test can pass.
 */
const SMOKE_TEST_SESSION_SECRET = "smoke-test-session-secret-at-least-32-characters-long";

async function main(): Promise<void> {
  process.stdout.write("== AppSkeleton smoke test (feature #120) ==\n\n");
  const previousSessionSecret = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = SMOKE_TEST_SESSION_SECRET;

  process.stdout.write("-> Connecting to MySQL...\n");
  const pool = createDbPoolFromEnv();
  try {
    await pool.query("SELECT 1");
  } catch (cause) {
    pool.end().catch(() => undefined);
    fail(
      "Could not reach MySQL — run `./init.sh` (or `docker compose up -d mysql`) first. " +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const db = createKyselyDb(pool);
  try {
    await ensureWikiSchema(db);
    await ensureMainNamespace(db);
  } finally {
    await db.destroy();
  }

  process.stdout.write(
    "\n-> Booting the real kernel (bootstrapKernel(), same path as `npm run dev`)...\n",
  );
  const kernel = await bootstrapKernel();

  const problems: string[] = [];
  try {
    try {
      await listen(kernel);
      const baseUrl = `http://127.0.0.1:${String(kernel.config.PORT)}`;
      process.stdout.write(`-> Listening at ${baseUrl}.\n`);

      process.stdout.write(
        "\n-> Minting an authenticated session and fetching the wiki home page over real HTTP...\n",
      );
      const { cookieHeader } = mintAuthenticatedSession();
      const { status, page } = await fetchWikiHomePage(baseUrl, cookieHeader);
      process.stdout.write(
        `-> GET /api/${DEFAULT_API_VERSION}/wiki/pages/${String(page.id)} -> ${String(status)} ` +
          `"${page.title}" (${String(page.contentHtml?.length ?? 0)} bytes of rendered HTML)\n`,
      );
      if (status !== 200 || page.title !== "Home" || !page.contentHtml) {
        problems.push(
          `wiki home page fetch did not come back as expected: status=${String(status)}, ` +
            `title=${JSON.stringify(page.title)}, contentHtml present=${String(Boolean(page.contentHtml))}.`,
        );
      }

      process.stdout.write(
        "\n-> Checking kernel introspection for every shipped plugin's health...\n",
      );
      const report = await kernel.introspectWithHealth();
      process.stdout.write(formatIntrospectionReport(report) + "\n");
      problems.push(...checkShippedPluginHealth(report));
    } finally {
      process.stdout.write("\n-> Shutting down gracefully...\n");
      await shutdownKernel(kernel);
    }
  } finally {
    if (previousSessionSecret === undefined) {
      delete process.env["SESSION_SECRET"];
    } else {
      process.env["SESSION_SECRET"] = previousSessionSecret;
    }
  }

  process.stdout.write("\n" + "=".repeat(72) + "\n");
  if (problems.length > 0) {
    process.stdout.write(`SMOKE TEST FAILED — ${String(problems.length)} problem(s):\n`);
    for (const problem of problems) {
      process.stdout.write(`  - ${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "SMOKE TEST PASSED — fresh clone through running wiki, all six shipped plugins healthy.\n",
  );
}

main().catch((error: unknown) => {
  console.error("smoke-test failed:", error);
  process.exitCode = 1;
});
