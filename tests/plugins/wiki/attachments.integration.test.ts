/**
 * Integration test suite for feature #97 ("Attachments/file upload support
 * for wiki pages"), step 3: "Write a test asserting an oversized or
 * disallowed-type upload is rejected, and a valid upload is retrievable
 * only by an authorized user."
 *
 * Mirrors `http-routes.integration.test.ts`'s own "real api-gateway/rbac/
 * html-renderer/wiki plugins through the real broker + loader,
 * `app.inject()` HTTP dispatch, db:query backed by a real MySQL connection"
 * fixture harness line-for-line (see that file's own module doc for the
 * full rationale) — this suite only needs `wiki_namespaces`/`wiki_pages`/
 * `wiki_attachments`, not the full five-migration set, since none of its
 * assertions touch revisions/search.
 *
 * Attachment blobs are written to a disposable per-suite temp directory
 * (`mkdtempSync`, the same pattern `tests/core/config.test.ts` and this
 * plugin's own `attachment-storage.test.ts` already use) via
 * `WIKI_ATTACHMENTS_DIR`/`WIKI_ATTACHMENT_MAX_BYTES` env overrides — never
 * the real default `<cwd>/var/wiki-attachments` — and removed in
 * `afterAll`.
 *
 * Skips itself (via `describe.runIf`) when docker-compose MySQL isn't
 * reachable, matching every sibling `*.integration.test.ts` in this
 * directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import * as createAttachments from "../../../src/plugins/wiki/src/migrations/0005_create_wiki_attachments.js";
import * as createNamespaces from "../../../src/plugins/wiki/src/migrations/0001_create_wiki_namespaces.js";
import * as createPages from "../../../src/plugins/wiki/src/migrations/0002_create_wiki_pages.js";

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

const WIKI_TABLES = ["wiki_attachments", "wiki_pages", "wiki_namespaces"] as const;

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
    "[wiki attachments.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #97 wiki attachments integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
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
/** Same-shape stand-in for `http-routes.integration.test.ts`'s own `/login` fixture — wiki has no login route of its own, so this mints a session cookie for a caller identity this suite's tests then grant roles to. */
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

const NAMESPACE_ID = "feature97-attachments-ns";
const SESSION_SECRET = "a-sufficiently-long-test-secret-for-wiki-attachments-integration";

describe.runIf(mysqlReachable)("wiki attachments — end-to-end over real HTTP (feature #97)", () => {
  let setup: ReturnType<typeof connect>;
  let attachmentsDir: string;
  const previousSecret = process.env["SESSION_SECRET"];
  const previousDir = process.env["WIKI_ATTACHMENTS_DIR"];
  const previousMaxBytes = process.env["WIKI_ATTACHMENT_MAX_BYTES"];

  beforeAll(async () => {
    setup = connect();
    for (const table of WIKI_TABLES) {
      await setup.pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await createNamespaces.up(setup.db);
    await createPages.up(setup.db);
    await createAttachments.up(setup.db);

    await setup.db
      .insertInto("wiki_namespaces")
      .values({ id: NAMESPACE_ID, name: "Feature 97 Attachments Namespace" })
      .execute();
  });

  afterAll(async () => {
    const cleanup = connect();
    try {
      await createAttachments.down(cleanup.db);
      await createPages.down(cleanup.db);
      await createNamespaces.down(cleanup.db);
    } finally {
      await cleanup.db.destroy();
      await setup.db.destroy();
    }
  });

  beforeEach(() => {
    attachmentsDir = mkdtempSync(join(tmpdir(), "appskeleton-wiki-attachments-it-"));
    process.env["SESSION_SECRET"] = SESSION_SECRET;
    process.env["WIKI_ATTACHMENTS_DIR"] = attachmentsDir;
    // A small per-suite limit so an "oversized" test payload can stay
    // tiny (fast, and nowhere near api-gateway's own default 1 MiB
    // REQUEST_BODY_LIMIT_BYTES, which would otherwise mask this
    // plugin's own size check behind a generic 413 — see
    // `attachment-storage-config.ts`'s module docs).
    process.env["WIKI_ATTACHMENT_MAX_BYTES"] = "64";
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
    if (previousDir === undefined) {
      delete process.env["WIKI_ATTACHMENTS_DIR"];
    } else {
      process.env["WIKI_ATTACHMENTS_DIR"] = previousDir;
    }
    if (previousMaxBytes === undefined) {
      delete process.env["WIKI_ATTACHMENT_MAX_BYTES"];
    } else {
      process.env["WIKI_ATTACHMENT_MAX_BYTES"] = previousMaxBytes;
    }
    resetPolicyStoreForTests();
    rmSync(attachmentsDir, { recursive: true, force: true });
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
    const loadResult = await loadPlugins(definitions, broker, {});
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

  /** Create a fresh page as `editorCookie`/`editorToken` and return its id. */
  async function createPage(
    app: Awaited<ReturnType<typeof loadServer>>,
    editorCookie: string,
    editorToken: string,
    slug: string,
  ): Promise<number> {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie: editorCookie, "x-csrf-token": editorToken },
      payload: { namespaceId: NAMESPACE_ID, slug, title: "Attachments Target", content: "body" },
    });
    expect(create.statusCode).toBe(201);
    return (create.json() as { id: number }).id;
  }

  it("upload: a disallowed content type is rejected with 400, and never written to disk", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);
    const pageId = await createPage(app, cookie, token, "disallowed-type-page");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        filename: "payload.html",
        contentType: "text/html",
        contentBase64: Buffer.from("<script>alert(1)</script>").toString("base64"),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie: sidCookie },
    });
    expect((list.json() as { attachments: unknown[] }).attachments).toEqual([]);

    await apiGatewayModule.onDisable();
  });

  it("upload: an oversized upload is rejected with 400, and never written to disk", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);
    const pageId = await createPage(app, cookie, token, "oversized-page");

    // WIKI_ATTACHMENT_MAX_BYTES is 64 (beforeEach) — 200 raw bytes is
    // comfortably over the limit, and its base64 form is still nowhere
    // near api-gateway's own default 1 MiB request body limit.
    const oversizedData = Buffer.alloc(200, 1);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        filename: "too-big.png",
        contentType: "image/png",
        contentBase64: oversizedData.toString("base64"),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie: sidCookie },
    });
    expect((list.json() as { attachments: unknown[] }).attachments).toEqual([]);

    await apiGatewayModule.onDisable();
  });

  it("upload: a viewer (read-only) is rejected with 403 — never reaching the store", async () => {
    const app = await loadServer();
    const { sidCookie: editorSid } = await loginAs(app, "editor");
    const { cookie: editorCookie, token: editorToken } = await obtainCsrf(app, editorSid);
    const pageId = await createPage(app, editorCookie, editorToken, "viewer-denied-page");

    const { sidCookie: viewerSid } = await loginAs(app, "viewer");
    const { cookie: viewerCookie, token: viewerToken } = await obtainCsrf(app, viewerSid);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie: viewerCookie, "x-csrf-token": viewerToken },
      payload: {
        filename: "note.txt",
        contentType: "text/plain",
        contentBase64: Buffer.from("hi").toString("base64"),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });

    await apiGatewayModule.onDisable();
  });

  it("upload -> download: a valid attachment is retrievable, byte-for-byte, with its content-type and filename", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);
    const pageId = await createPage(app, cookie, token, "valid-upload-page");

    const fileData = Buffer.from("a small, valid text file");
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        filename: "notes.txt",
        contentType: "text/plain",
        contentBase64: fileData.toString("base64"),
      },
    });

    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json() as {
      id: number;
      pageId: number;
      filename: string;
      contentType: string;
      sizeBytes: number;
    };
    expect(uploaded).toMatchObject({
      pageId,
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: fileData.byteLength,
    });
    // The randomized on-disk storage name must never leak to the client.
    expect(uploaded).not.toHaveProperty("storageName");

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments/${uploaded.id}`,
      headers: { cookie: sidCookie },
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("text/plain");
    expect(download.headers["content-disposition"]).toContain('filename="notes.txt"');
    expect(Buffer.from(download.rawPayload).equals(fileData)).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie: sidCookie },
    });
    expect((list.json() as { attachments: { id: number }[] }).attachments.map((a) => a.id)).toEqual(
      [uploaded.id],
    );

    await apiGatewayModule.onDisable();
  });

  it("download: an unauthenticated request is rejected with 401", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);
    const pageId = await createPage(app, cookie, token, "unauth-download-page");

    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/wiki/pages/${pageId}/attachments`,
      headers: { cookie, "x-csrf-token": token },
      payload: {
        filename: "secret.txt",
        contentType: "text/plain",
        contentBase64: Buffer.from("shh").toString("base64"),
      },
    });
    const attachmentId = (upload.json() as { id: number }).id;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments/${attachmentId}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHENTICATED" });

    await apiGatewayModule.onDisable();
  });

  it("download: a nonexistent attachment id on a real page returns 404", async () => {
    const app = await loadServer();
    const { sidCookie } = await loginAs(app, "editor");
    const { cookie, token } = await obtainCsrf(app, sidCookie);
    const pageId = await createPage(app, cookie, token, "missing-attachment-page");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/wiki/pages/${pageId}/attachments/999999`,
      headers: { cookie: sidCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });

    await apiGatewayModule.onDisable();
  });
});
