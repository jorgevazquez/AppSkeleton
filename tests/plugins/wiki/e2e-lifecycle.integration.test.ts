/**
 * End-to-end wiki test suite for feature #100 ("End-to-end wiki test suite
 * (create/edit/view/search/permission-denied flows)"), step 1: "Assemble a
 * suite driving the real HTTP API (and, where practical, the rendered HTML)
 * through a full page lifecycle including a permission-denied case."
 *
 * Every prior wiki integration suite (feature #94's `http-routes.
 * integration.test.ts`, feature #96's `page-form.integration.test.ts`, ...)
 * proves one route or one concern in isolation. This suite is deliberately
 * different in shape: a *single* end-to-end walk of one page's whole
 * lifecycle — create, view (both the JSON API's rendered `contentHtml` and,
 * "where practical", the real server-rendered HTML edit form), edit,
 * view-again, search, and a permission-denied case — as one caller would
 * actually experience it in order, reusing each step's own response (a
 * created page id, a rendered form's own prefilled values, ...) as the next
 * step's input, the way `http-routes.integration.test.ts`'s own individual
 * `it()`s never do (each of those starts fresh from `loadServer()`).
 *
 * Mirrors `http-routes.integration.test.ts`'s own "real `api-gateway`,
 * `rbac`, `html-renderer`, `wiki` plugins through the real capability broker
 * + loader (`loadPlugins()`), `app.inject()` for real HTTP dispatch, own
 * migrations applied/rolled back directly via `up()`/`down()` rather than
 * the shared checksum-verified runner" pattern in full — see that file's own
 * module doc for the detailed rationale (`docs/plugin-conventions.md`
 * section 5 carve-out) — including its `describe.runIf(mysqlReachable)`
 * self-skip when docker-compose MySQL isn't reachable.
 */
import mysql from "mysql2/promise";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    "[wiki e2e-lifecycle.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #100 wiki end-to-end lifecycle suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
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
/** A tiny same-shape stand-in for `http-routes.integration.test.ts`'s own `/login` fixture — wiki has no login route of its own, so this mints a session cookie for a caller identity this suite's tests then grant roles to. */
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

/** Find the `Set-Cookie` header whose name is `cookieName` among (possibly several) `Set-Cookie` headers. Same helper `http-routes.integration.test.ts` uses. */
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

const NAMESPACE_ID = "feature100-e2e-ns";
const SESSION_SECRET = "a-sufficiently-long-test-secret-for-wiki-e2e-lifecycle-integration";

describe.runIf(mysqlReachable)("wiki end-to-end page lifecycle (feature #100)", () => {
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
      .values({ id: NAMESPACE_ID, name: "Feature 100 E2E Lifecycle Namespace" })
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

  async function loadServer() {
    const definitions: PluginDefinition[] = [
      { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
      { manifest: RBAC_MANIFEST, module: rbacModule },
      { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
      { manifest: DB_FIXTURE_MANIFEST, module: dbFixtureModule(setup.queryCapability) },
      { manifest: WIKI_MANIFEST, module: wikiModule },
      { manifest: LOGIN_FIXTURE_MANIFEST, module: loginFixtureModule() },
    ];

    const broker = createCapabilityBroker();
    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      throw new Error("fixture plugin load unexpectedly failed");
    }
    expect(loadResult.value.failed).toEqual([]);

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

  it(
    "walks one page through its full lifecycle: create-form -> create -> view -> edit-form -> edit -> " +
      "view-again -> search -> permission-denied, all over real HTTP against a real server instance",
    async () => {
      const app = await loadServer();
      const { sidCookie: editorSid } = await loginAs(app, "editor");
      const { cookie: editorCookie, token: editorToken } = await obtainCsrf(app, editorSid);

      // --- create-form: the real server-rendered HTML a browser would load
      // before ever submitting a new page (feature #96) ---
      const createForm = await app.inject({
        method: "GET",
        url: "/api/v1/wiki/pages/new",
        headers: { cookie: editorSid },
      });
      expect(createForm.statusCode).toBe(200);
      expect(createForm.headers["content-type"]).toContain("text/html");
      expect(createForm.body).toContain(
        'data-action="&#x2F;api&#x2F;v1&#x2F;wiki&#x2F;pages" data-method="POST"',
      );

      // --- create: the real JSON API submission that form's own inline
      // script would issue ---
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/wiki/pages",
        headers: { cookie: editorCookie, "x-csrf-token": editorToken },
        payload: {
          namespaceId: NAMESPACE_ID,
          slug: "e2e-lifecycle-page",
          title: "E2E Lifecycle Page",
          content: "# Welcome\n\nThis page mentions e2e-lifecycle-marker-one.",
        },
      });
      expect(create.statusCode).toBe(201);
      const pageId = (create.json() as { id: number }).id;

      // --- view: the JSON API's own rendered-to-HTML Markdown content
      // (feature #88) ---
      const view = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/pages/${pageId}`,
        headers: { cookie: editorSid },
      });
      expect(view.statusCode).toBe(200);
      const viewed = view.json() as { title: string; contentHtml: string };
      expect(viewed.title).toBe("E2E Lifecycle Page");
      expect(viewed.contentHtml).toContain("<h1>Welcome</h1>");

      // --- edit-form: the real server-rendered edit form, prefilled with
      // the page's current title/content (feature #96) ---
      const editForm = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/pages/${pageId}/edit`,
        headers: { cookie: editorSid },
      });
      expect(editForm.statusCode).toBe(200);
      expect(editForm.headers["content-type"]).toContain("text/html");
      // Attribute-value context (feature #47's auto-escaping) turns the
      // space in the title into `&#x20;` — the same escaped-but-round-trips
      // guarantee `page-form.integration.test.ts` already asserts for
      // `data-action`/`data-method`.
      expect(editForm.body).toContain('value="E2E&#x20;Lifecycle&#x20;Page"');
      // The textarea's HTML-body context leaves ordinary text (including
      // hyphens) unescaped, so the marker survives verbatim.
      expect(editForm.body).toContain("e2e-lifecycle-marker-one");
      expect(editForm.body).toContain(
        `data-action="&#x2F;api&#x2F;v1&#x2F;wiki&#x2F;pages&#x2F;${pageId}" data-method="PATCH"`,
      );

      // --- edit: the real JSON API submission that edit form's own inline
      // script would issue ---
      const edit = await app.inject({
        method: "PATCH",
        url: `/api/v1/wiki/pages/${pageId}`,
        headers: { cookie: editorCookie, "x-csrf-token": editorToken },
        payload: {
          title: "E2E Lifecycle Page (Revised)",
          content: "# Welcome Back\n\nNow mentioning e2e-lifecycle-marker-two instead.",
        },
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.json()).toMatchObject({ title: "E2E Lifecycle Page (Revised)" });

      // The prior content was captured as a revision (feature #89) — proof
      // this "edit" step genuinely went through the same history-preserving
      // path a real editor's edit would.
      const history = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/pages/${pageId}/revisions`,
        headers: { cookie: editorSid },
      });
      expect(history.statusCode).toBe(200);
      const { revisions } = history.json() as { revisions: { title: string }[] };
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ title: "E2E Lifecycle Page" });

      // --- view-again: the edit is reflected back through the same view
      // route, re-rendered to HTML ---
      const viewAgain = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/pages/${pageId}`,
        headers: { cookie: editorSid },
      });
      expect(viewAgain.statusCode).toBe(200);
      const viewedAgain = viewAgain.json() as { title: string; contentHtml: string };
      expect(viewedAgain.title).toBe("E2E Lifecycle Page (Revised)");
      expect(viewedAgain.contentHtml).toContain("<h1>Welcome Back</h1>");

      // --- search: the revised content is now findable by its new marker,
      // and no longer by its old one ---
      const searchNew = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/search?q=e2e-lifecycle-marker-two&namespaceId=${NAMESPACE_ID}`,
        headers: { cookie: editorSid },
      });
      expect(searchNew.statusCode).toBe(200);
      const { results: newResults } = searchNew.json() as { results: { slug: string }[] };
      expect(newResults.map((result) => result.slug)).toContain("e2e-lifecycle-page");

      const searchOld = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/search?q=e2e-lifecycle-marker-one&namespaceId=${NAMESPACE_ID}`,
        headers: { cookie: editorSid },
      });
      expect(searchOld.statusCode).toBe(200);
      const { results: oldResults } = searchOld.json() as { results: { slug: string }[] };
      expect(oldResults.map((result) => result.slug)).not.toContain("e2e-lifecycle-page");

      // --- permission-denied: a read-only viewer cannot edit this same
      // page — rejected with 403 before ever reaching the store, and the
      // page's content is left completely unchanged by the attempt ---
      const { sidCookie: viewerSid } = await loginAs(app, "viewer");
      const { cookie: viewerCookie, token: viewerToken } = await obtainCsrf(app, viewerSid);

      const deniedEdit = await app.inject({
        method: "PATCH",
        url: `/api/v1/wiki/pages/${pageId}`,
        headers: { cookie: viewerCookie, "x-csrf-token": viewerToken },
        payload: { title: "Hijacked Title", content: "Hijacked content." },
      });
      expect(deniedEdit.statusCode).toBe(403);
      expect(deniedEdit.json()).toMatchObject({ code: "FORBIDDEN" });

      // --- permission-denied: an unauthenticated caller cannot even view
      // the page — rejected with 401, never reaching the rbac check at all ---
      const deniedView = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/pages/${pageId}`,
      });
      expect(deniedView.statusCode).toBe(401);
      expect(deniedView.json()).toMatchObject({ code: "UNAUTHENTICATED" });

      // The page itself was never touched by either denied attempt.
      const finalView = await app.inject({
        method: "GET",
        url: `/api/v1/wiki/pages/${pageId}`,
        headers: { cookie: viewerSid },
      });
      expect(finalView.statusCode).toBe(200);
      expect(finalView.json()).toMatchObject({ title: "E2E Lifecycle Page (Revised)" });

      await apiGatewayModule.onDisable();
    },
  );
});
