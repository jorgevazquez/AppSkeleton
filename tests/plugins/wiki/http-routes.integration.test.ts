/**
 * Integration test suite for feature #94 ("Wiki HTTP routes via api-gateway
 * (list/get/create/update/delete/search/history/diff)"), step 3: "Write an
 * integration test suite hitting every route over real HTTP against a test
 * server instance."
 *
 * Drives the *real* `api-gateway`, `rbac`, `html-renderer`, and `wiki`
 * plugins through the *real* capability broker + loader (`loadPlugins()`),
 * mirroring `tests/plugins/api-gateway/rbac-protection.integration.test.ts`'s
 * and `csrf.integration.test.ts`'s own "real plugins, real broker, real
 * `app.inject()` HTTP dispatch" pattern — `app.inject()` drives Fastify's
 * actual routing/hook/serialization pipeline end-to-end with no network
 * socket, which is this codebase's own established meaning of "real HTTP
 * against a test server instance" (see those two files).
 *
 * `db:query` is backed by a real MySQL connection (`database-mysql`'s own
 * `pool.ts`/`db.ts`/`query-capability.ts`, wrapped in a tiny fixture plugin
 * that just registers the already-built capability with the broker) rather
 * than by loading the real `database-mysql` plugin's own lifecycle — the
 * same "kernel-integration test crosses into database-mysql's internals
 * directly" carve-out `pages-store.integration.test.ts`'s own module doc
 * already establishes and uses (`docs/plugin-conventions.md` section 5).
 * This suite's own three wiki migrations are applied the same way that file
 * applies them: directly via each migration's `up()`/`down()`, never the
 * shared checksum-verified runner, so this suite can never race a
 * concurrently-running sibling suite's migration bookkeeping (see that
 * file's own module doc for the full rationale) — and rolled back in
 * `afterAll` so it never pollutes the shared `schema_migrations` table for
 * a later suite or a repeat `npm test` run.
 *
 * Skips itself (via `describe.runIf`) when docker-compose MySQL isn't
 * reachable, matching every sibling `*.integration.test.ts` in this
 * directory.
 */
import mysql from "mysql2/promise";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryAuditSink } from "../../../src/core/audit.js";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import {
  issueSessionCookie,
  loadSessionConfig,
  type HttpRouteCapability,
} from "../../../src/plugins/api-gateway/index.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import {
  createDbQueryCapability,
  type DbQueryCapability,
} from "../../../src/plugins/database-mysql/src/query-capability.js";
import * as htmlRendererModule from "../../../src/plugins/html-renderer/index.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import { policyStore, resetPolicyStoreForTests } from "../../../src/plugins/rbac/index.js";
import * as wikiModule from "../../../src/plugins/wiki/index.js";
import * as createNamespaces from "../../../src/plugins/wiki/src/migrations/0001_create_wiki_namespaces.js";
import * as createPages from "../../../src/plugins/wiki/src/migrations/0002_create_wiki_pages.js";
import * as createRevisions from "../../../src/plugins/wiki/src/migrations/0003_create_wiki_revisions.js";

/** Matches docker-compose.yml's `mysql` service credentials — same fixture every sibling integration suite uses. */
const DOCKER_COMPOSE_CONFIG = {
  DB_HOST: "127.0.0.1",
  DB_PORT: 3306,
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: 5,
  DB_SSL: "disabled" as const,
  DB_SSL_REJECT_UNAUTHORIZED: true,
};

const WIKI_TABLES = ["wiki_revisions", "wiki_pages", "wiki_namespaces"] as const;

async function probeMysqlReachable(): Promise<boolean> {
  try {
    const probe = await mysql.createConnection({
      host: DOCKER_COMPOSE_CONFIG.DB_HOST,
      port: DOCKER_COMPOSE_CONFIG.DB_PORT,
      user: DOCKER_COMPOSE_CONFIG.DB_USER,
      password: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
      database: DOCKER_COMPOSE_CONFIG.DB_NAME,
      connectTimeout: 2000,
    });
    await probe.ping();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

// Resolved via top-level await BEFORE describe.runIf()'s condition is
// evaluated at collection time — see the sibling integration suites this
// file mirrors for why this must not be a still-pending promise then.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[wiki http-routes.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #94 wiki HTTP routes integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

function connect(): { pool: mysql.Pool; db: Kysely<Database>; queryCapability: DbQueryCapability } {
  const pool = createDbPool(DOCKER_COMPOSE_CONFIG);
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);
  return { pool, db, queryCapability };
}

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

const API_GATEWAY_MANIFEST = manifest("api-gateway", {
  provides: ["http:route"],
  requires: ["rbac:check", "render:template", "html:error-pages"],
});
const RBAC_MANIFEST = manifest("rbac", { provides: ["rbac:check", "rbac:manage"] });
const HTML_RENDERER_MANIFEST = manifest("html-renderer", {
  provides: ["render:template", "html:error-pages"],
});
const DB_FIXTURE_MANIFEST = manifest("db-fixture", { provides: ["db:query"] });
const WIKI_MANIFEST = manifest("wiki", {
  dependsOn: { "api-gateway": "^1.0.0" },
  requires: ["rbac:check", "db:query", "render:template", "http:route"],
});
/** A tiny same-shape stand-in for rbac-protection.integration.test.ts's own `/login` fixture — wiki has no login route of its own, so this mints a session cookie for a caller identity this suite's tests then grant roles to. */
const LOGIN_FIXTURE_MANIFEST = manifest("login-fixture", {
  dependsOn: { "api-gateway": "^1.0.0" },
  requires: ["http:route"],
});

function getHttpRoute(): HttpRouteCapability {
  return apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
}

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

function dbFixtureModule(queryCapability: DbQueryCapability): PluginModule {
  return { provides: { "db:query": queryCapability } };
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

const NAMESPACE_ID = "feature94-http-ns";
const SESSION_SECRET = "a-sufficiently-long-test-secret-for-wiki-http-routes-integration";

describe.runIf(mysqlReachable)("wiki HTTP routes — end-to-end over real HTTP (feature #94)", () => {
  let setup: ReturnType<typeof connect>;
  const previousSecret = process.env["SESSION_SECRET"];

  beforeAll(async () => {
    setup = connect();
    for (const table of WIKI_TABLES) {
      await setup.pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await createNamespaces.up(setup.db);
    await createPages.up(setup.db);
    await createRevisions.up(setup.db);

    await setup.db
      .insertInto("wiki_namespaces")
      .values({ id: NAMESPACE_ID, name: "Feature 94 HTTP Routes Namespace" })
      .execute();
  });

  afterAll(async () => {
    const cleanup = connect();
    try {
      await createRevisions.down(cleanup.db);
      await createPages.down(cleanup.db);
      await createNamespaces.down(cleanup.db);
    } finally {
      await cleanup.db.destroy();
      await setup.db.destroy();
    }
  });

  beforeEach(() => {
    process.env["SESSION_SECRET"] = SESSION_SECRET;
    resetPolicyStoreForTests();
    rbacModule.policyStore.rolePermissions.push(
      { roleId: "viewer", permissionId: "wiki:read" },
      { roleId: "editor", permissionId: "wiki:read" },
      { roleId: "editor", permissionId: "wiki:write" },
      { roleId: "admin", permissionId: "wiki:read" },
      { roleId: "admin", permissionId: "wiki:write" },
      { roleId: "admin", permissionId: "wiki:admin" },
    );
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env["SESSION_SECRET"];
    } else {
      process.env["SESSION_SECRET"] = previousSecret;
    }
    resetPolicyStoreForTests();
  });

  async function loadServer(auditSink?: ReturnType<typeof createInMemoryAuditSink>) {
    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: RBAC_MANIFEST, module: rbacModule },
      { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
      { manifest: DB_FIXTURE_MANIFEST, module: dbFixtureModule(setup.queryCapability) },
      { manifest: WIKI_MANIFEST, module: wikiModule },
      { manifest: LOGIN_FIXTURE_MANIFEST, module: loginFixtureModule() },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(
      definitions,
      broker,
      auditSink !== undefined ? { auditSink } : {},
    );
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      throw new Error("fixture plugin load unexpectedly failed");
    }
    expect(loadResult.value.failed).toEqual([]);
    expect(loadResult.value.loaded.map((plugin) => plugin.id).sort()).toEqual(
      ["api-gateway", "db-fixture", "html-renderer", "login-fixture", "rbac", "wiki"].sort(),
    );

    return getHttpRoute().getApp();
  }

  /** Log in as a caller and assign `roleId` to them (a role already seeded with permissions in `beforeEach`). Returns the caller's `sid` cookie pair, for use as a request's `cookie` header. */
  async function loginAs(
    app: Awaited<ReturnType<typeof loadServer>>,
    roleId: "viewer" | "editor" | "admin",
  ): Promise<{ userId: string; sidCookie: string }> {
    const login = await app.inject({ method: "GET", url: "/api/v1/login" });
    expect(login.statusCode).toBe(200);
    const userId = (login.json() as { userId: string }).userId;
    const sidCookie = findSetCookie(login, "sid").split(";")[0] as string;
    policyStore.userRoles.push({ userId, roleId });
    return { userId, sidCookie };
  }

  /** Obtain a `csrf_token` cookie (issued on any request lacking one) and the raw token value to present via the `x-csrf-token` header for a state-changing request. */
  async function obtainCsrf(
    app: Awaited<ReturnType<typeof loadServer>>,
    sidCookie: string,
  ): Promise<{ cookie: string; token: string }> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/wiki/pages",
      headers: { cookie: sidCookie },
    });
    const csrfCookiePair = findSetCookie(res, "csrf_token").split(";")[0] as string;
    const token = csrfCookiePair.slice("csrf_token=".length);
    return { cookie: `${sidCookie}; ${csrfCookiePair}`, token };
  }

  it("list: GET /api/v1/wiki/pages returns pages scoped to the requested namespace for an authenticated reader", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");

    const created = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages?namespaceId=${NAMESPACE_ID}`,
      headers: { cookie: sidCookie },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ pages: expect.any(Array) });

    await apiGatewayModule.onDisable();
  });

  it("list: an unauthenticated request is rejected with 401", async () => {
    const app = await loadServer();

    const res = await app.inject({ method: "GET", url: "/api/v1/wiki/pages" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHENTICATED" });

    await apiGatewayModule.onDisable();
  });

  it("create -> get: a created page is retrievable with its Markdown content rendered to HTML (feature #88)", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "getting-started",
        title: "Getting Started",
        content: "# Hello\n\nWelcome to the **wiki**.",
      },
    });

    expect(create.statusCode).toBe(201);
    const createdPage = create.json() as { id: number; slug: string };
    expect(createdPage.slug).toBe("getting-started");

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${createdPage.id}`,
      headers: { cookie: sidCookie },
    });

    expect(get.statusCode).toBe(200);
    const page = get.json() as { contentHtml: string; title: string };
    expect(page.title).toBe("Getting Started");
    expect(page.contentHtml).toContain("<h1>Hello</h1>");
    expect(page.contentHtml).toContain("<strong>wiki</strong>");

    await apiGatewayModule.onDisable();
  });

  it("get: a nonexistent page id returns 404", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "viewer");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/wiki/pages/999999",
      headers: { cookie: sidCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });

    await apiGatewayModule.onDisable();
  });

  it("create: a viewer (read-only) is rejected with 403 — never reaching the store", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "viewer");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: { namespaceId: NAMESPACE_ID, slug: "denied-page", title: "Nope", content: "x" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });

    await apiGatewayModule.onDisable();
  });

  it("create: a state-changing request with no CSRF token is rejected with 403 (feature #64 still applies to wiki routes)", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie: sidCookie },
      payload: { namespaceId: NAMESPACE_ID, slug: "no-csrf-page", title: "Nope", content: "x" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CSRF_ERROR" });

    await apiGatewayModule.onDisable();
  });

  it("update -> history: a page update is retrievable, and the prior content is recorded as a revision", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "editable-page",
        title: "Original Title",
        content: "Original content.",
      },
    });
    const pageId = (create.json() as { id: number }).id;

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie, "x-csrf-token": token },
      payload: { title: "Updated Title", content: "Updated content." },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ title: "Updated Title", content: "Updated content." });

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/revisions`,
      headers: { cookie: sidCookie },
    });

    expect(history.statusCode).toBe(200);
    const { revisions } = history.json() as {
      revisions: { title: string; content: string }[];
    };
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ title: "Original Title", content: "Original content." });

    await apiGatewayModule.onDisable();
  });

  it("delete: an editor (not admin) is rejected with 403; an admin can delete, after which the page 404s", async () => {
    const app = await loadServer();
    const { sidCookie: editorSid } = await loginAs(app, "editor");
    const { cookie: editorCookie, token: editorToken } = await obtainCsrf(app, editorSid);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie: editorCookie, "x-csrf-token": editorToken },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "deletable-page",
        title: "To Delete",
        content: "Bye.",
      },
    });
    const pageId = (create.json() as { id: number }).id;

    const deniedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie: editorCookie, "x-csrf-token": editorToken },
    });
    expect(deniedDelete.statusCode).toBe(403);

    const { sidCookie: adminSid } = await loginAs(app, "admin");
    const { cookie: adminCookie, token: adminToken } = await obtainCsrf(app, adminSid);

    const allowedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie: adminCookie, "x-csrf-token": adminToken },
    });
    expect(allowedDelete.statusCode).toBe(200);
    expect(allowedDelete.json()).toEqual({ id: pageId, deleted: true });

    const getAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie: adminSid },
    });
    expect(getAfterDelete.statusCode).toBe(404);

    await apiGatewayModule.onDisable();
  });

  it("search: finds a page whose content matches the query term and excludes an irrelevant page", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "search-target",
        title: "Findable Page",
        content: "This page mentions the unique-search-marker-alpha somewhere in its body.",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "search-irrelevant",
        title: "Unrelated Page",
        content: "Nothing interesting here.",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/search?q=unique-search-marker-alpha&namespaceId=${NAMESPACE_ID}`,
      headers: { cookie: sidCookie },
    });

    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: { slug: string; snippet: string }[] };
    expect(results.map((result) => result.slug)).toContain("search-target");
    expect(results.map((result) => result.slug)).not.toContain("search-irrelevant");
    expect(results.find((result) => result.slug === "search-target")?.snippet).toContain(
      "unique-search-marker-alpha",
    );

    await apiGatewayModule.onDisable();
  });

  it("diff: identifies additions and deletions between two revisions of the same page", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "diff-target",
        title: "Diff Target",
        content: "line one\nline two\nline three",
      },
    });
    const pageId = (create.json() as { id: number }).id;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie, "x-csrf-token": token },
      payload: { content: "line one\nline two changed\nline three\nline four" },
    });

    const historyRes = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/revisions`,
      headers: { cookie: sidCookie },
    });
    const { revisions } = historyRes.json() as { revisions: { id: number }[] };
    const fromRevisionId = revisions[0]?.id as number;

    // "to" the current content: create a second revision by editing again,
    // so both sides of the diff are real, retrievable wiki_revisions rows.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie, "x-csrf-token": token },
      payload: { content: "line one\nline two changed\nline three\nline four\nline five" },
    });
    const historyRes2 = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/revisions`,
      headers: { cookie: sidCookie },
    });
    const { revisions: revisions2 } = historyRes2.json() as { revisions: { id: number }[] };
    const toRevisionId = revisions2[0]?.id as number;

    const diff = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/diff?from=${fromRevisionId}&to=${toRevisionId}`,
      headers: { cookie: sidCookie },
    });

    expect(diff.statusCode).toBe(200);
    const { lines, html } = diff.json() as {
      lines: { type: string; value: string }[];
      html: string;
    };
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "removed", value: "line two" }),
        expect.objectContaining({ type: "added", value: "line two changed" }),
      ]),
    );

    // Feature #90 step 2: the diff is also rendered to safe HTML via
    // render:template, with a class per line marking it added/removed/
    // unchanged — not just returned as raw JSON edit-script data.
    expect(html).toContain('<div class="diff-line diff-removed">line two</div>');
    expect(html).toContain('<div class="diff-line diff-added">line two changed</div>');
    expect(html).toContain('<div class="diff-line diff-unchanged">line one</div>');

    await apiGatewayModule.onDisable();
  });

  it("diff: an XSS-style payload in a revision's content is neutralized in the rendered HTML (feature #90 step 2)", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "diff-xss-target",
        title: "Diff XSS Target",
        content: "safe line",
      },
    });
    const pageId = (create.json() as { id: number }).id;

    // Feature #89: an edit snapshots the *previous* content into
    // wiki_revisions before applying the change — so this first edit's
    // resulting revision row captures "safe line" (the create-time
    // content), matching the "identifies additions and deletions" test
    // above's own from/to construction.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        content: '<script>alert(document.cookie)</script>\n<img src=x onerror="alert(1)">',
      },
    });
    const historyRes = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/revisions`,
      headers: { cookie: sidCookie },
    });
    const fromRevisionId = (
      (historyRes.json() as { revisions: { id: number }[] }).revisions[0] as { id: number }
    ).id;

    // A second edit's resulting revision row now captures the malicious
    // payload set above, so it's a real, retrievable wiki_revisions row on
    // the "to" side of the diff, exactly like the non-XSS diff test.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie, "x-csrf-token": token },
      payload: { content: "safe line again" },
    });
    const historyRes2 = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/revisions`,
      headers: { cookie: sidCookie },
    });
    const toRevisionId = (
      (historyRes2.json() as { revisions: { id: number }[] }).revisions[0] as { id: number }
    ).id;

    const diff = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/diff?from=${fromRevisionId}&to=${toRevisionId}`,
      headers: { cookie: sidCookie },
    });

    expect(diff.statusCode).toBe(200);
    const { html } = diff.json() as { html: string };
    // No raw HTML injection from diffed content — the payload text survives
    // only as HTML-escaped text inside a fixed diff-line wrapper.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;script&gt;alert(document.cookie)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");

    await apiGatewayModule.onDisable();
  });

  it("diff: a nonexistent revision id returns 404", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "diff-missing-revision",
        title: "Diff Missing",
        content: "content",
      },
    });
    const pageId = (create.json() as { id: number }).id;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/diff?from=1&to=999999`,
      headers: { cookie: sidCookie },
    });

    expect(res.statusCode).toBe(404);

    await apiGatewayModule.onDisable();
  });

  it("every wiki route is reachable only under /api/v1 (feature #62 — API versioning)", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "viewer");

    const versioned = await app.inject({
      method: "GET",
      url: "/api/v1/wiki/pages",
      headers: { cookie: sidCookie },
    });
    const unversioned = await app.inject({
      method: "GET",
      url: "/wiki/pages",
      headers: { cookie: sidCookie },
    });

    expect(versioned.statusCode).toBe(200);
    expect(unversioned.statusCode).toBe(404);

    await apiGatewayModule.onDisable();
  });

  it("audit: GET /api/v1/wiki/audit requires admin — an editor is rejected with 403", async () => {
    const app = await loadServer(createInMemoryAuditSink());
    const { sidCookie } = await loginAs(app, "editor");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/wiki/audit",
      headers: { cookie: sidCookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });

    await apiGatewayModule.onDisable();
  });

  it("audit: GET /api/v1/wiki/audit (feature #98, step 2) lists recent create/update/delete/permission-denied entries with actor and page identity, for an admin", async () => {
    const auditSink = createInMemoryAuditSink();
    const app = await loadServer(auditSink);
    const { userId: editorId, sidCookie: editorSid } = await loginAs(app, "editor");
    const { cookie: editorCookie, token: editorToken } = await obtainCsrf(app, editorSid);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie: editorCookie, "x-csrf-token": editorToken },
      payload: {
        namespaceId: NAMESPACE_ID,
        slug: "audit-target",
        title: "Audit Target",
        content: "v1",
      },
    });
    expect(create.statusCode).toBe(201);
    const pageId = (create.json() as { id: number }).id;

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie: editorCookie, "x-csrf-token": editorToken },
      payload: { content: "v2" },
    });
    expect(update.statusCode).toBe(200);

    // Editor is not admin — this delete attempt is denied, and should be
    // recorded as a "denied" permission event, not a "deleted" one.
    const deniedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie: editorCookie, "x-csrf-token": editorToken },
    });
    expect(deniedDelete.statusCode).toBe(403);

    const { sidCookie: adminSid } = await loginAs(app, "admin");
    const { cookie: adminCookie, token: adminToken } = await obtainCsrf(app, adminSid);

    const allowedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/wiki/pages/${pageId}`,
      headers: { cookie: adminCookie, "x-csrf-token": adminToken },
    });
    expect(allowedDelete.statusCode).toBe(200);

    const auditRes = await app.inject({
      method: "GET",
      url: "/api/v1/wiki/audit",
      headers: { cookie: adminSid },
    });
    expect(auditRes.statusCode).toBe(200);
    const { entries } = auditRes.json() as {
      entries: {
        actor: string;
        action: string;
        target: string;
        outcome: string;
        timestamp: number;
      }[];
    };

    const pageTarget = "wiki:page:" + String(pageId);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: editorId,
          action: "wiki:create",
          target: pageTarget,
          outcome: "created",
        }),
        expect.objectContaining({
          actor: editorId,
          action: "wiki:update",
          target: pageTarget,
          outcome: "updated",
        }),
        expect.objectContaining({
          actor: editorId,
          action: "wiki:admin",
          target: pageTarget,
          outcome: "denied",
        }),
        expect.objectContaining({
          action: "wiki:delete",
          target: pageTarget,
          outcome: "deleted",
        }),
      ]),
    );

    await apiGatewayModule.onDisable();
  });
});
