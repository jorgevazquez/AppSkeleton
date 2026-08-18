/**
 * Tests for `./src/assets.ts` (feature #51 — "Theme/asset pipeline (static
 * CSS/JS serving with cache headers)"):
 *
 *   1. `AssetRegistry.registerAsset` — the namespaced static-asset
 *      registration API (step 1).
 *   2. `buildAssetResponse` — correct `Cache-Control`/`ETag` headers, plus
 *      conditional-GET (`If-None-Match` -> `304`) handling (step 2).
 *   3. A registered asset actually served with correct headers and content
 *      over a real HTTP request (step 3) — driven through a standalone
 *      Fastify instance mounting a tiny route backed by this module,
 *      mirroring `tests/plugins/api-gateway/error-handler.test.ts`'s
 *      "standalone Fastify instance, not the full plugin loader" pattern
 *      (this feature, like that one, is infrastructure inside html-renderer
 *      not yet wired into a capability or a live server — see assets.ts's
 *      module docs).
 */
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import { isErr, unwrap } from "../../../src/core/types.js";
import {
  buildAssetResponse,
  createAssetRegistry,
  DEFAULT_CACHE_CONTROL,
  type RegisteredAsset,
} from "../../../src/plugins/html-renderer/src/assets.js";

function sha256(content: string): string {
  return `"${createHash("sha256").update(content, "utf8").digest("hex")}"`;
}

describe("AssetRegistry.registerAsset — namespaced static asset registration (step 1)", () => {
  it("registers a CSS asset, storing its content and guessing its content type from the extension", () => {
    const registry = createAssetRegistry();
    const registered = unwrap(
      registry.registerAsset("wiki-theme", "css/site.css", "body { color: teal; }"),
    );

    expect(registered.namespace).toBe("wiki-theme");
    expect(registered.path).toBe("css/site.css");
    expect(registered.content.toString("utf8")).toBe("body { color: teal; }");
    expect(registered.contentType).toBe("text/css; charset=utf-8");
    expect(registered.cacheControl).toBe(DEFAULT_CACHE_CONTROL);
  });

  it("guesses JS and common image content types from the extension too", () => {
    const registry = createAssetRegistry();
    expect(unwrap(registry.registerAsset("t", "app.js", "console.log(1);")).contentType).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(unwrap(registry.registerAsset("t", "logo.svg", "<svg></svg>")).contentType).toBe(
      "image/svg+xml",
    );
    expect(
      unwrap(registry.registerAsset("t", "logo.png", Buffer.from([1, 2, 3]))).contentType,
    ).toBe("image/png");
  });

  it("falls back to application/octet-stream for an unrecognized extension, and honors an explicit contentType override", () => {
    const registry = createAssetRegistry();
    expect(unwrap(registry.registerAsset("t", "data.bin", "x")).contentType).toBe(
      "application/octet-stream",
    );
    expect(
      unwrap(registry.registerAsset("t", "data.bin", "x", { contentType: "text/plain" }))
        .contentType,
    ).toBe("text/plain");
  });

  it("namespaces the same asset path independently — two plugins publishing style.css never collide", () => {
    const registry = createAssetRegistry();
    unwrap(registry.registerAsset("plugin-a", "style.css", "a { color: red; }"));
    unwrap(registry.registerAsset("plugin-b", "style.css", "b { color: blue; }"));

    expect(registry.getAsset("plugin-a", "style.css")?.content.toString("utf8")).toBe(
      "a { color: red; }",
    );
    expect(registry.getAsset("plugin-b", "style.css")?.content.toString("utf8")).toBe(
      "b { color: blue; }",
    );
  });

  it("re-registering the same namespace/path overwrites the previous entry and recomputes its ETag", () => {
    const registry = createAssetRegistry();
    const first = unwrap(registry.registerAsset("t", "app.js", "v1"));
    const second = unwrap(registry.registerAsset("t", "app.js", "v2"));

    expect(registry.getAsset("t", "app.js")?.content.toString("utf8")).toBe("v2");
    expect(first.etag).not.toBe(second.etag);
    expect(second.etag).toBe(sha256("v2"));
  });

  it("getAsset returns undefined for an unregistered namespace/path pair", () => {
    const registry = createAssetRegistry();
    expect(registry.getAsset("nope", "missing.css")).toBeUndefined();
  });

  it("listAssets returns every asset registered under a namespace, and nothing from another namespace", () => {
    const registry = createAssetRegistry();
    unwrap(registry.registerAsset("theme", "a.css", "a"));
    unwrap(registry.registerAsset("theme", "b.js", "b"));
    unwrap(registry.registerAsset("other", "c.css", "c"));

    const listed = registry.listAssets("theme");
    expect(listed.map((asset) => asset.path).sort()).toEqual(["a.css", "b.js"]);
  });

  it.each([
    ["empty namespace", "", "app.js"],
    ["namespace containing a slash", "a/b", "app.js"],
    ["empty path", "t", ""],
    ["path with a leading slash", "t", "/app.js"],
    ["path with a trailing slash", "t", "app.js/"],
    ["path containing a .. segment", "t", "css/../../etc/passwd"],
  ])("rejects registration with a ValidationError for %s", (_label, namespace, assetPath) => {
    const registry = createAssetRegistry();
    const result = registry.registerAsset(namespace, assetPath, "x");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it("accepts an explicit Cache-Control override at registration time", () => {
    const registry = createAssetRegistry();
    const registered = unwrap(
      registry.registerAsset("t", "app.js", "x", { cacheControl: "no-cache" }),
    );
    expect(registered.cacheControl).toBe("no-cache");
  });
});

describe("buildAssetResponse — Cache-Control/ETag headers and conditional GET (step 2)", () => {
  function registerOne(): RegisteredAsset {
    const registry = createAssetRegistry();
    return unwrap(registry.registerAsset("theme", "site.css", "body { margin: 0; }"));
  }

  it("returns 200 with Content-Type, Content-Length, Cache-Control, and ETag headers, plus the exact content as the body", () => {
    const asset = registerOne();
    const response = buildAssetResponse(asset);

    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(response.headers["content-length"]).toBe(
      String(Buffer.byteLength("body { margin: 0; }")),
    );
    expect(response.headers["cache-control"]).toBe(DEFAULT_CACHE_CONTROL);
    expect(response.headers.etag).toBe(sha256("body { margin: 0; }"));
    expect(response.body.toString("utf8")).toBe("body { margin: 0; }");
  });

  it("returns 304 with no body when If-None-Match already names the asset's current ETag", () => {
    const asset = registerOne();
    const response = buildAssetResponse(asset, { ifNoneMatch: asset.etag });

    expect(response.status).toBe(304);
    expect(response.headers.etag).toBe(asset.etag);
    expect(response.headers["cache-control"]).toBe(DEFAULT_CACHE_CONTROL);
    expect((response as { body?: Buffer }).body).toBeUndefined();
  });

  it("returns 304 when If-None-Match lists multiple ETags including a match", () => {
    const asset = registerOne();
    const response = buildAssetResponse(asset, {
      ifNoneMatch: `"stale-one", ${asset.etag}, "stale-two"`,
    });
    expect(response.status).toBe(304);
  });

  it("returns 304 when If-None-Match is a bare wildcard", () => {
    const asset = registerOne();
    expect(buildAssetResponse(asset, { ifNoneMatch: "*" }).status).toBe(304);
  });

  it("returns 200 (a full re-download) when If-None-Match names a stale ETag", () => {
    const asset = registerOne();
    const response = buildAssetResponse(asset, { ifNoneMatch: '"stale-etag"' });
    expect(response.status).toBe(200);
  });

  it("treats content changes as a fresh ETag: an If-None-Match from before a re-registration no longer matches", () => {
    const registry = createAssetRegistry();
    const before = unwrap(registry.registerAsset("t", "app.js", "v1"));
    const after = unwrap(registry.registerAsset("t", "app.js", "v2"));

    expect(buildAssetResponse(after, { ifNoneMatch: before.etag }).status).toBe(200);
    expect(buildAssetResponse(after, { ifNoneMatch: after.etag }).status).toBe(304);
  });
});

describe("a registered asset served over a real HTTP request (step 3)", () => {
  it("GET returns 200 with the registered content and correct Content-Type/Cache-Control/ETag headers", async () => {
    const registry = createAssetRegistry();
    unwrap(registry.registerAsset("wiki-theme", "css/site.css", "body { color: teal; }"));

    const app = Fastify();
    app.get("/assets/:namespace/*", async (request, reply) => {
      const { namespace } = request.params as { namespace: string };
      const assetPath = (request.params as { "*": string })["*"];
      const asset = registry.getAsset(namespace, assetPath);
      if (asset === undefined) {
        return reply.code(404).send();
      }
      const ifNoneMatchHeader = request.headers["if-none-match"];
      const ifNoneMatch = Array.isArray(ifNoneMatchHeader)
        ? ifNoneMatchHeader[0]
        : ifNoneMatchHeader;
      const response = buildAssetResponse(asset, ifNoneMatch !== undefined ? { ifNoneMatch } : {});
      reply.code(response.status);
      for (const [name, value] of Object.entries(response.headers)) {
        reply.header(name, value);
      }
      return response.status === 304 ? reply.send() : reply.send(response.body);
    });

    try {
      const res = await app.inject({ method: "GET", url: "/assets/wiki-theme/css/site.css" });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect(res.headers["cache-control"]).toBe(DEFAULT_CACHE_CONTROL);
      expect(res.headers.etag).toBe(sha256("body { color: teal; }"));
      expect(res.body).toBe("body { color: teal; }");

      // Conditional GET: replaying the ETag we just got back yields a
      // body-less 304, proving the pipeline's caching contract holds over
      // a real HTTP round trip, not just in buildAssetResponse() directly.
      const revalidation = await app.inject({
        method: "GET",
        url: "/assets/wiki-theme/css/site.css",
        headers: { "if-none-match": res.headers.etag as string },
      });
      expect(revalidation.statusCode).toBe(304);
      expect(revalidation.body).toBe("");

      const missing = await app.inject({ method: "GET", url: "/assets/wiki-theme/nope.css" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
