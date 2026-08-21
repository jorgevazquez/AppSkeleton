#!/usr/bin/env -S npx tsx
/**
 * Least-privilege capability audit (feature #118).
 *
 * Compares each shipped plugin's declared `capabilities.requires` against
 * the capability ids it actually invoked at runtime — instrumented via the
 * real capability broker's own audit trail (`core/broker.ts`'s
 * `capability:obtain` events, `core/audit.ts`) — rather than a static
 * source scan. See `src/core/capability-audit.ts`'s module doc for the full
 * rationale (in short: several real `obtain()` call sites in this codebase
 * are lazy/per-request, so only a real run can prove what actually gets
 * reached).
 *
 * ## What this script does
 *
 * 1. Reads every shipped plugin's real `plugin.json` from `src/plugins/*`
 *    (the actual, currently-declared manifests this repo ships) — this is
 *    the "declared" half of the comparison, for every plugin, regardless of
 *    whether step 2 below actually boots it live.
 * 2. Boots a real instance of every plugin that actually declares
 *    `capabilities.requires` (`api-gateway`, `rbac`, `wiki`) plus their
 *    capability providers (`html-renderer`, and a `db-fixture` wrapping a
 *    real MySQL-backed `db:query` — the same "real broker/loader, a thin
 *    fixture only for the one capability that would otherwise need the
 *    full `database-mysql` plugin's own lifecycle" pattern
 *    `tests/plugins/wiki/http-routes.integration.test.ts` already
 *    establishes) through the real `createCapabilityBroker()` +
 *    `loadPlugins()`. `database-mysql`, `hello-world`, and `plugin-builder`
 *    all declare `capabilities.requires: []` in their real manifests (see
 *    step 1) — they have nothing to audit on the "used" side regardless of
 *    whether they're live-booted here, so this script doesn't need to boot
 *    them to produce a complete report.
 * 3. Drives a real HTTP flow (`app.inject()` — no network socket, same
 *    "real Fastify pipeline" meaning this codebase's integration suites
 *    already use) across every reachable `capabilities.obtain()` call site
 *    this plugin set has: wiki's full page lifecycle (create/get/edit/
 *    delete/search/history/diff/attachments/forms/audit) as three
 *    different RBAC roles (to exercise both allowed and denied checks),
 *    plus a 404 with a browser-like `Accept` header (to exercise
 *    api-gateway's `html:error-pages` path).
 * 4. Reads back every `capability:obtain` audit event the run produced and
 *    compares it, via `src/core/capability-audit.ts`'s pure
 *    `auditCapabilityUsage()`, against each plugin's real declared
 *    `capabilities.requires` from step 1.
 * 5. Prints a human-readable report and exits non-zero if anything
 *    unacknowledged was found — see {@link KNOWN_OVER_PRIVILEGED} for this
 *    repo's one current, deliberately-accepted exception.
 *
 * Run via `npm run capability-audit`. Requires a running, migrated MySQL
 * (`./init.sh`, or `docker compose up -d mysql`) — same prerequisite as
 * every `*.integration.test.ts` in this repo and `scripts/load-test.ts`.
 */
import "dotenv/config";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInMemoryAuditSink } from "../src/core/audit.js";
import { createCapabilityBroker } from "../src/core/broker.js";
import {
  auditCapabilityUsage,
  formatCapabilityAuditReport,
  isCapabilityAuditReportClean,
} from "../src/core/capability-audit.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../src/core/loader.js";
import { validateManifest, type PluginManifest } from "../src/core/manifest.js";
import { isErr, isOk } from "../src/core/types.js";
import * as apiGatewayModule from "../src/plugins/api-gateway/index.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  issueSessionCookie,
  loadSessionConfig,
  type HttpRouteCapability,
} from "../src/plugins/api-gateway/index.js";
import { createKyselyDb } from "../src/plugins/database-mysql/src/db.js";
import { createDbPool } from "../src/plugins/database-mysql/src/pool.js";
import {
  createDbQueryCapability,
  type DbQueryCapability,
} from "../src/plugins/database-mysql/src/query-capability.js";
import * as htmlRendererModule from "../src/plugins/html-renderer/index.js";
import * as rbacModule from "../src/plugins/rbac/index.js";
import { policyStore, resetPolicyStoreForTests } from "../src/plugins/rbac/index.js";
import * as wikiModule from "../src/plugins/wiki/index.js";
import * as createNamespaces from "../src/plugins/wiki/src/migrations/0001_create_wiki_namespaces.js";
import * as createPages from "../src/plugins/wiki/src/migrations/0002_create_wiki_pages.js";
import * as createRevisions from "../src/plugins/wiki/src/migrations/0003_create_wiki_revisions.js";
import * as addFulltextIndex from "../src/plugins/wiki/src/migrations/0004_add_wiki_pages_fulltext_index.js";
import * as createAttachments from "../src/plugins/wiki/src/migrations/0005_create_wiki_attachments.js";

/**
 * Known, deliberate "declares more than it currently uses" exceptions —
 * see `src/core/capability-audit.ts`'s `AuditCapabilityOptions.acknowledgedOverPrivileged`
 * docs. This repo currently has exactly one: `api-gateway`'s manifest
 * requires `render:template`, but api-gateway's own code never actually
 * calls `capabilities.obtain("render:template")` anywhere — its one
 * HTML-producing surface (`/docs`, `src/plugins/api-gateway/src/openapi.ts`'s
 * `renderApiDocsHtml`) deliberately hand-rolls its own dependency-free HTML
 * rather than going through html-renderer (see that file's own "Why /docs
 * renders a static table instead of embedding real Swagger UI" doc
 * comment), and its error pages go through the higher-level
 * `html:error-pages` capability instead (`src/plugins/api-gateway/src/error-handler.ts`),
 * which itself calls `render:template` from *inside* html-renderer's own
 * plugin — not across a broker boundary, so it never shows up as
 * api-gateway obtaining it.
 *
 * This is not dead configuration to delete: it is an explicit, previously
 * reviewed and load-bearing design decision, pinned by
 * `tests/plugins/api-gateway/manifest.test.ts` ("declares rbac:check,
 * render:template, and html:error-pages as required capabilities it may
 * consume") and documented in spec.md §4, `docs/ai-plugin-authoring.md`
 * §5.2 ("`api-gateway`'s manifest requires both `rbac:check` and
 * `render:template` 'optionally' ... its code must handle `obtain()`
 * returning `Err` for either one gracefully, not assume both always
 * succeed") and §7.3 (api-gateway's exact `requires` shape is this
 * codebase's own worked example of "declare a capability your plugin may
 * need from another plugin"), and `docs/capability-index.md`. Removing the
 * declaration would contradict that documented, tested design for the sake
 * of a lower "unused capability" count — the ceiling
 * `capabilities.requires` describes is deliberately wider than any one
 * boot's exercised code paths here (`docs/plugin-conventions.md`'s own
 * "ceiling, not a guarantee" language, echoed by
 * `plugin-builder/src/conventions-linter.ts`'s own
 * `unsatisfied_capability_requirement` check treating a comparable gap as
 * a warning, not an error).
 *
 * Any OTHER over-privileged finding this script produces is a fresh,
 * unreviewed regression — not covered by this allowlist — and fails the
 * run (see `main()`'s exit-code logic below).
 */
const KNOWN_OVER_PRIVILEGED: Readonly<Record<string, readonly string[]>> = {
  "api-gateway": ["render:template"],
};

const SHIPPED_PLUGIN_IDS = [
  "api-gateway",
  "database-mysql",
  "hello-world",
  "html-renderer",
  "plugin-builder",
  "rbac",
  "wiki",
] as const;

const PLUGINS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/plugins");

/** Matches docker-compose.yml's `mysql` service credentials — same fixture every sibling integration suite / script in this repo uses. */
const DB_CONFIG = {
  DB_HOST: process.env["DB_HOST"] ?? "127.0.0.1",
  DB_PORT: Number(process.env["DB_PORT"] ?? 3306),
  DB_USER: process.env["DB_USER"] ?? "appskeleton",
  DB_PASSWORD: process.env["DB_PASSWORD"] ?? "change-me",
  DB_NAME: process.env["DB_NAME"] ?? "appskeleton",
  DB_CONNECTION_LIMIT: 5,
  DB_SSL: "disabled" as const,
  DB_SSL_REJECT_UNAUTHORIZED: true,
};

const WIKI_TABLES = [
  "wiki_attachments",
  "wiki_revisions",
  "wiki_pages",
  "wiki_namespaces",
] as const;
const NAMESPACE_ID = "capability-audit-ns";
const SESSION_SECRET =
  process.env["SESSION_SECRET"] ?? "capability-audit-session-secret-at-least-32-characters-long";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8";

/** Read + validate one shipped plugin's real `plugin.json` — the "declared" half of this audit, for every plugin regardless of whether it's live-booted below. */
function readRealManifest(pluginId: string): PluginManifest {
  const raw = readFileSync(path.join(PLUGINS_ROOT, pluginId, "plugin.json"), "utf-8");
  const validated = validateManifest(JSON.parse(raw));
  if (isErr(validated)) {
    throw new Error(
      `"${pluginId}"'s real plugin.json failed manifest validation: ${validated.error.message}`,
    );
  }
  return validated.value;
}

/** A tiny same-shape stand-in for `http-routes.integration.test.ts`'s own `/login` fixture — wiki has no login route of its own, so this mints a session cookie this script then grants an RBAC role to directly. Not one of the audited plugins (`SHIPPED_PLUGIN_IDS`) — pure test scaffolding to reach real, lazy per-request `obtain()` call sites over real HTTP. */
function loginFixtureManifest(): PluginManifest {
  return {
    id: "login-fixture",
    version: "1.0.0",
    depends_on: { "api-gateway": "^0.1.0" },
    capabilities: { provides: [], requires: ["http:route"] },
    entry_point: "index.ts",
  };
}

function loginFixtureModule(): PluginModule {
  return {
    onEnable(context) {
      const obtained = context.capabilities.obtain<HttpRouteCapability>("http:route");
      if (isErr(obtained)) {
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

function dbFixtureManifest(): PluginManifest {
  return {
    id: "db-fixture",
    version: "1.0.0",
    depends_on: {},
    capabilities: { provides: ["db:query"], requires: [] },
    entry_point: "index.ts",
  };
}

function dbFixtureModule(queryCapability: DbQueryCapability): PluginModule {
  return { provides: { "db:query": queryCapability } };
}

function getHttpRoute(): HttpRouteCapability {
  return apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
}

/** Find the `Set-Cookie` header whose name is `cookieName` among (possibly several) `Set-Cookie` headers. */
function findSetCookie(res: { headers: Record<string, unknown> }, cookieName: string): string {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const match = headers.find(
    (value): value is string => typeof value === "string" && value.startsWith(`${cookieName}=`),
  );
  if (match === undefined) {
    throw new Error(`expected a Set-Cookie header named "${cookieName}" in the response`);
  }
  return match;
}

type InjectableApp = ReturnType<typeof getHttpRoute>["getApp"] extends () => infer R ? R : never;

async function loginAs(
  app: InjectableApp,
  roleId: "viewer" | "editor" | "admin",
): Promise<{ userId: string; sidCookie: string }> {
  const login = await app.inject({ method: "GET", url: "/api/v1/login" });
  if (login.statusCode !== 200) {
    throw new Error(`login-fixture GET /api/v1/login unexpectedly returned ${login.statusCode}`);
  }
  const userId = (login.json() as { userId: string }).userId;
  const sidCookie = findSetCookie(login, "sid").split(";")[0] as string;
  policyStore.userRoles.push({ userId, roleId });
  return { userId, sidCookie };
}

async function obtainCsrf(
  app: InjectableApp,
  sidCookie: string,
): Promise<{ cookie: string; token: string }> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/wiki/pages?namespaceId=${NAMESPACE_ID}`,
    headers: { cookie: sidCookie },
  });
  const csrfCookiePair = findSetCookie(res, CSRF_COOKIE_NAME).split(";")[0] as string;
  const token = csrfCookiePair.slice(`${CSRF_COOKIE_NAME}=`.length);
  return { cookie: `${sidCookie}; ${csrfCookiePair}`, token };
}

/**
 * Drive a comprehensive HTTP flow across every reachable
 * `capabilities.obtain()` call site this plugin set has — see this
 * module's own docs, step 3.
 */
async function exerciseCapabilities(app: InjectableApp): Promise<void> {
  const editor = await loginAs(app, "editor");
  const viewer = await loginAs(app, "viewer");
  const admin = await loginAs(app, "admin");
  const { cookie: editorCookie, token: editorCsrf } = await obtainCsrf(app, editor.sidCookie);

  // General smoke — no capability requirement of its own, but confirms the
  // server is actually up before the capability-specific flow below.
  await app.inject({ method: "GET", url: "/health" });
  await app.inject({ method: "GET", url: "/api/v1/openapi.json" });

  // Unauthenticated: 401, never reaches rbac:check (see rbac-protection.ts's
  // own docs — obtain() only happens once a session id is present).
  await app.inject({ method: "GET", url: "/api/v1/wiki/pages" });

  // 404 with a browser-like Accept header — exercises api-gateway's own
  // lazy `html:error-pages` obtain (error-handler.ts).
  await app.inject({
    method: "GET",
    url: "/this-route-does-not-exist",
    headers: { accept: BROWSER_ACCEPT },
  });

  // create (editor: write) -> db:query, rbac:check
  const create = await app.inject({
    method: "POST",
    url: "/api/v1/wiki/pages",
    headers: { cookie: editorCookie, [CSRF_HEADER_NAME]: editorCsrf },
    payload: {
      namespaceId: NAMESPACE_ID,
      slug: "capability-audit-page",
      title: "Capability Audit Page",
      content: "# Hello\n\nExercised by scripts/capability-audit.ts.",
    },
  });
  if (create.statusCode !== 201) {
    throw new Error(`create page unexpectedly returned ${create.statusCode}: ${create.body}`);
  }
  const pageId = (create.json() as { id: number }).id;

  // get (editor: read, contentHtml rendered) -> db:query, rbac:check, render:template
  await app.inject({
    method: "GET",
    url: `/api/v1/wiki/pages/${pageId}`,
    headers: { cookie: editor.sidCookie },
  });

  // edit -> new revision
  await app.inject({
    method: "PATCH",
    url: `/api/v1/wiki/pages/${pageId}`,
    headers: { cookie: editorCookie, [CSRF_HEADER_NAME]: editorCsrf },
    payload: { title: "Capability Audit Page (edited)", content: "# Hello again\n\nEdited." },
  });

  // history/diff
  const history = await app.inject({
    method: "GET",
    url: `/api/v1/wiki/pages/${pageId}/revisions`,
    headers: { cookie: editor.sidCookie },
  });
  const revisions = (history.json() as { revisions: { id: number }[] }).revisions;
  if (revisions.length >= 2) {
    const [first, second] = revisions;
    await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/diff?from=${first?.id}&to=${second?.id}`,
      headers: { cookie: editor.sidCookie },
    });
  }

  // search
  await app.inject({
    method: "GET",
    url: `/api/v1/wiki/search?q=Exercised&namespaceId=${NAMESPACE_ID}`,
    headers: { cookie: editor.sidCookie },
  });

  // attachments: upload -> list -> download
  const upload = await app.inject({
    method: "POST",
    url: `/api/v1/wiki/pages/${pageId}/attachments`,
    headers: { cookie: editorCookie, [CSRF_HEADER_NAME]: editorCsrf },
    payload: {
      filename: "note.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("capability audit attachment").toString("base64"),
    },
  });
  if (upload.statusCode === 201) {
    const attachmentId = (upload.json() as { id: number }).id;
    await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie: editor.sidCookie },
    });
    await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments/${attachmentId}`,
      headers: { cookie: editor.sidCookie },
    });
  }

  // HTML forms — always render:template, unconditional on Accept.
  await app.inject({
    method: "GET",
    url: "/api/v1/wiki/pages/new",
    headers: { cookie: editor.sidCookie },
  });
  await app.inject({
    method: "GET",
    url: `/api/v1/wiki/pages/${pageId}/edit`,
    headers: { cookie: editor.sidCookie },
  });

  // admin: audit view (wiki:admin) and the one permission-denied path
  // (viewer attempting a write, and a non-admin attempting delete).
  await app.inject({
    method: "GET",
    url: "/api/v1/wiki/audit",
    headers: { cookie: admin.sidCookie },
  });

  // rbac's own admin routes are the only ones in this plugin set wired
  // through api-gateway's generic `requiredPermission` preHandler hook
  // (see the `rbac:manage` grant above) — this is what actually exercises
  // api-gateway's own lazy `capabilities.obtain("rbac:check")` call site.
  await app.inject({
    method: "GET",
    url: "/api/v1/rbac/roles",
    headers: { cookie: admin.sidCookie },
  });

  const { cookie: viewerCookie, token: viewerCsrf } = await obtainCsrf(app, viewer.sidCookie);
  await app.inject({
    method: "POST",
    url: "/api/v1/wiki/pages",
    headers: { cookie: viewerCookie, [CSRF_HEADER_NAME]: viewerCsrf },
    payload: { namespaceId: NAMESPACE_ID, slug: "viewer-denied", title: "Denied", content: "n/a" },
  });
  await app.inject({
    method: "DELETE",
    url: `/api/v1/wiki/pages/${pageId}`,
    headers: { cookie: viewerCookie, [CSRF_HEADER_NAME]: viewerCsrf },
  });

  // admin: delete (final cleanup of the page this run created)
  const { cookie: adminCookie, token: adminCsrf } = await obtainCsrf(app, admin.sidCookie);
  await app.inject({
    method: "DELETE",
    url: `/api/v1/wiki/pages/${pageId}`,
    headers: { cookie: adminCookie, [CSRF_HEADER_NAME]: adminCsrf },
  });
}

async function main(): Promise<void> {
  // Step 1 — the "declared" half: every shipped plugin's real manifest,
  // regardless of whether step 2 below actually boots it live.
  const realManifests = SHIPPED_PLUGIN_IDS.map(readRealManifest);

  // Step 2/3 setup — a real MySQL connection for wiki's own migrations +
  // db:query (mirrors http-routes.integration.test.ts's own fixture setup).
  const pool = createDbPool(DB_CONFIG);
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);

  for (const table of WIKI_TABLES) {
    await pool.query("DROP TABLE IF EXISTS `" + table + "`");
  }
  await createNamespaces.up(db);
  await createPages.up(db);
  await createRevisions.up(db);
  await addFulltextIndex.up(db);
  await createAttachments.up(db);
  await db
    .insertInto("wiki_namespaces")
    .values({ id: NAMESPACE_ID, name: "Capability Audit" })
    .execute();

  const attachmentsDir = mkdtempSync(path.join(tmpdir(), "capability-audit-attachments-"));
  const previousAttachmentsDir = process.env["WIKI_ATTACHMENTS_DIR"];
  const previousSecret = process.env["SESSION_SECRET"];
  process.env["WIKI_ATTACHMENTS_DIR"] = attachmentsDir;
  process.env["SESSION_SECRET"] = SESSION_SECRET;
  resetPolicyStoreForTests();
  policyStore.rolePermissions.push(
    { roleId: "viewer", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:read" },
    { roleId: "editor", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:read" },
    { roleId: "admin", permissionId: "wiki:write" },
    { roleId: "admin", permissionId: "wiki:admin" },
    // rbac:manage — grants the admin role access to rbac's own admin HTTP
    // routes (registered with `requiredPermission: "rbac:manage"`), the
    // ONLY routes in this plugin set that go through api-gateway's generic
    // `requiredPermission` preHandler hook (`rbac-protection.ts`) — wiki's
    // own routes deliberately omit `requiredPermission` and perform their
    // own per-namespace authorization instead (see wiki/index.ts's own
    // module doc). Without exercising an `rbac:manage`-protected route,
    // api-gateway's own `capabilities.obtain("rbac:check")` call site would
    // never actually run, and it would show up as a false
    // over-privileged finding below.
    { roleId: "admin", permissionId: "rbac:manage" },
  );

  const auditSink = createInMemoryAuditSink();
  const broker = createCapabilityBroker({ auditSink });

  const definitions: PluginDefinition[] = [
    { manifest: readRealManifest("api-gateway"), module: apiGatewayModule },
    { manifest: readRealManifest("rbac"), module: rbacModule },
    { manifest: readRealManifest("html-renderer"), module: htmlRendererModule },
    { manifest: dbFixtureManifest(), module: dbFixtureModule(queryCapability) },
    { manifest: readRealManifest("wiki"), module: wikiModule },
    { manifest: loginFixtureManifest(), module: loginFixtureModule() },
  ];

  try {
    const loadResult = await loadPlugins(definitions, broker, { auditSink });
    if (!isOk(loadResult)) {
      throw new Error(`plugin load failed: ${loadResult.error.message}`);
    }
    if (loadResult.value.failed.length > 0) {
      throw new Error(
        `plugin(s) failed to load: ${loadResult.value.failed.map((f) => `${f.id}: ${f.error.message}`).join("; ")}`,
      );
    }

    const app = getHttpRoute().getApp();
    await exerciseCapabilities(app);
    await apiGatewayModule.onDisable();
  } finally {
    if (previousAttachmentsDir === undefined) {
      delete process.env["WIKI_ATTACHMENTS_DIR"];
    } else {
      process.env["WIKI_ATTACHMENTS_DIR"] = previousAttachmentsDir;
    }
    if (previousSecret === undefined) {
      delete process.env["SESSION_SECRET"];
    } else {
      process.env["SESSION_SECRET"] = previousSecret;
    }
    resetPolicyStoreForTests();
    rmSync(attachmentsDir, { recursive: true, force: true });

    await addFulltextIndex.down(db);
    await createAttachments.down(db);
    await createRevisions.down(db);
    await createPages.down(db);
    await createNamespaces.down(db);
    await db.destroy();
  }

  // Step 4/5 — compare declared vs. actually-observed usage and report.
  const report = auditCapabilityUsage(realManifests, auditSink.all(), {
    acknowledgedOverPrivileged: KNOWN_OVER_PRIVILEGED,
  });

  console.log(formatCapabilityAuditReport(report));

  if (!isCapabilityAuditReportClean(report)) {
    console.error(
      "\nCapability audit FAILED: at least one unacknowledged over-privileged declaration or " +
        "impossible usage was found (see above). Either remove the unused capability from that " +
        "plugin's capabilities.requires, or — if it's a deliberate, documented exception — add it " +
        "to this script's own KNOWN_OVER_PRIVILEGED allowlist with a clear justification.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nCapability audit passed: no unacknowledged findings.");
}

main().catch((error: unknown) => {
  console.error("capability-audit failed:", error);
  process.exitCode = 1;
});
