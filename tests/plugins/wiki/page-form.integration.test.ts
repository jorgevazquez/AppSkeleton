/**
 * Integration test suite for feature #96 ("Page edit form UI with
 * CSRF-protected submission"), step 3: "Write a test asserting a
 * submission without a valid CSRF token is rejected end-to-end through
 * the real UI flow."
 *
 * "Through the real UI flow" means: drive the actual `GET
 * /api/v1/wiki/pages/new` page this feature adds (`../../../src/plugins/wiki/index.ts`,
 * `../../../src/plugins/wiki/src/page-form.ts`) — the same page a browser
 * would load and whose rendered `<form>` a user would submit — then replay
 * exactly the request that form's own inline script would issue (a JSON
 * `fetch()` to the form's own `data-action`/`data-method`), first without a
 * valid `x-csrf-token` header, and confirm feature #64's CSRF protection
 * (already proven end-to-end for a synthetic fixture route in
 * `tests/plugins/api-gateway/csrf.integration.test.ts`) actually covers
 * *this* route reached *this* way — not a mock, not the JSON API asserted
 * in isolation, but the real page's real declared submission target.
 *
 * Mirrors `http-routes.integration.test.ts`'s "real `api-gateway`/`wiki`
 * plugins through the real capability broker + loader, `app.inject()` for
 * real HTTP dispatch" pattern, but deliberately loads neither `rbac` nor a
 * `db:query` provider: CSRF validation (`api-gateway/src/csrf.ts`) runs in
 * a `preHandler` hook *before* any route handler — including the wiki
 * `create` handler's own `rbac:check`/`db:query` lookups — ever executes,
 * so a request that fails CSRF never reaches those capabilities at all.
 * That makes this suite runnable with no MySQL/docker-compose dependency,
 * unlike its sibling `http-routes.integration.test.ts` (`describe.runIf`
 * skipped in exactly this sandbox for that reason) — and, as the final test
 * below confirms, a request that *does* present a valid CSRF token reaches
 * exactly as far as that capability gap and no further, proving the earlier
 * 403s really were CSRF-specific rejections and not something else that
 * would 403 regardless of the token presented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isOk } from "../../../src/core/types.js";
import * as apiGatewayModule from "../../../src/plugins/api-gateway/index.js";
import type { HttpRouteCapability } from "../../../src/plugins/api-gateway/index.js";
import * as htmlRendererModule from "../../../src/plugins/html-renderer/index.js";
import * as wikiModule from "../../../src/plugins/wiki/index.js";

/** `session-identity.ts`'s `resolveUserId` (called at the top of every wiki route handler) requires `SESSION_SECRET` to be configured — set for the duration of this suite, same as `http-routes.integration.test.ts`. */
const SESSION_SECRET = "a-sufficiently-long-test-secret-for-wiki-page-form-integration";

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
const HTML_RENDERER_MANIFEST = manifest("html-renderer", {
  provides: ["render:template", "html:error-pages"],
});
const WIKI_MANIFEST = manifest("wiki", {
  dependsOn: { "api-gateway": "^1.0.0" },
  requires: ["rbac:check", "db:query", "render:template", "http:route"],
});

function getHttpRoute(): HttpRouteCapability {
  return apiGatewayModule.provides?.["http:route"] as HttpRouteCapability;
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

async function loadServer() {
  const definitions: PluginDefinition[] = [
    { manifest: API_GATEWAY_MANIFEST, module: apiGatewayModule },
    { manifest: HTML_RENDERER_MANIFEST, module: htmlRendererModule },
    { manifest: WIKI_MANIFEST, module: wikiModule },
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

const previousSecret = process.env["SESSION_SECRET"];

describe("wiki page-form UI — CSRF-protected submission, end-to-end (feature #96)", () => {
  beforeEach(() => {
    process.env["SESSION_SECRET"] = SESSION_SECRET;
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env["SESSION_SECRET"];
    } else {
      process.env["SESSION_SECRET"] = previousSecret;
    }
  });

  it("GET /api/v1/wiki/pages/new renders a real create-page form posting to the real CSRF-protected create route", async () => {
    const app = await loadServer();

    const res = await app.inject({ method: "GET", url: "/api/v1/wiki/pages/new" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // The `data-action`/`data-method` attribute *values* are HTML-attribute-
    // escaped by feature #47's auto-escaping (every non-alphanumeric
    // character, "/" included, becomes a `&#xHH;` hex reference — see
    // `html-renderer/src/escape.ts`'s `escapeAttr`) — exactly what a real
    // browser parses back to the literal path/method when it reads
    // `form.dataset.action`/`form.dataset.method`, so this asserts the
    // *rendered* form, not a hand-decoded guess at it.
    expect(res.body).toContain(
      'data-action="&#x2F;api&#x2F;v1&#x2F;wiki&#x2F;pages" data-method="POST"',
    );
    expect(res.body).toContain('id="form-errors"');

    await apiGatewayModule.onDisable();
  });

  it("rejects, through the real UI flow, a create-page submission presenting no CSRF token at all (step 3)", async () => {
    const app = await loadServer();

    // Load the real page a browser would load before ever submitting the form.
    const formPage = await app.inject({ method: "GET", url: "/api/v1/wiki/pages/new" });
    expect(formPage.statusCode).toBe(200);
    const csrfCookiePair = findSetCookie(formPage, "csrf_token").split(";")[0] as string;

    // Replay exactly what the form's own inline script would fetch() — same
    // method/path/body the rendered form declares — but withhold the
    // x-csrf-token header a real browser session's script would have
    // attached (the double-submit-cookie half a plain, non-JS form POST, or
    // a forged cross-site request, could never present in the first place).
    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: { cookie: csrfCookiePair, "content-type": "application/json" },
      payload: {
        namespaceId: "feature96-ns",
        slug: "new-page",
        title: "New Page",
        content: "Hello.",
      },
    });

    expect(submission.statusCode).toBe(403);
    expect(submission.json()).toEqual({
      code: "CSRF_ERROR",
      message: "CSRF token missing or invalid.",
    });

    await apiGatewayModule.onDisable();
  });

  it("rejects, through the real UI flow, a create-page submission whose token doesn't match its cookie", async () => {
    const app = await loadServer();

    const formPage = await app.inject({ method: "GET", url: "/api/v1/wiki/pages/new" });
    const csrfCookiePair = findSetCookie(formPage, "csrf_token").split(";")[0] as string;

    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: {
        cookie: csrfCookiePair,
        "content-type": "application/json",
        "x-csrf-token": "not-the-right-token",
      },
      payload: {
        namespaceId: "feature96-ns",
        slug: "new-page",
        title: "New Page",
        content: "Hello.",
      },
    });

    expect(submission.statusCode).toBe(403);
    expect(submission.json()).toMatchObject({ code: "CSRF_ERROR" });

    await apiGatewayModule.onDisable();
  });

  it("a matching CSRF token clears the CSRF gate (proving the two rejections above were CSRF-specific)", async () => {
    const app = await loadServer();

    const formPage = await app.inject({ method: "GET", url: "/api/v1/wiki/pages/new" });
    const csrfCookiePair = findSetCookie(formPage, "csrf_token").split(";")[0] as string;
    const token = csrfCookiePair.slice("csrf_token=".length);

    const submission = await app.inject({
      method: "POST",
      url: "/api/v1/wiki/pages",
      headers: {
        cookie: csrfCookiePair,
        "content-type": "application/json",
        "x-csrf-token": token,
      },
      payload: {
        namespaceId: "feature96-ns",
        slug: "new-page",
        title: "New Page",
        content: "Hello.",
      },
    });

    // No rbac/db:query provider is loaded in this suite (see module doc
    // comment), so the request can't actually succeed end-to-end here — the
    // handler now reaches its own `obtainWikiStores()` call and fails
    // there instead, with a *different* AppError (CapabilityDeniedError,
    // also 403 by coincidence — CSRF and "capability not granted" share a
    // status code but not a `code`/`message`), proving the two 403s above
    // were specifically CSRF rejections rather than this route 403-ing
    // unconditionally regardless of the token presented.
    expect(submission.json()).toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(submission.json()).not.toMatchObject({ code: "CSRF_ERROR" });

    await apiGatewayModule.onDisable();
  });
});
