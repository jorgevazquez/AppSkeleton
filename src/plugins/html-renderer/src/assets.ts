/**
 * Theme/asset pipeline for the html-renderer plugin (feature #51 —
 * "Theme/asset pipeline (static CSS/JS serving with cache headers)").
 *
 * spec.md assigns html-renderer "a theme/asset pipeline other plugins
 * register views against" — this module is that pipeline's registration
 * and serving half: a namespaced, in-memory store any plugin can publish a
 * static CSS/JS/image file into ({@link AssetRegistry.registerAsset}), plus
 * the pure HTTP-response logic ({@link buildAssetResponse}) that turns a
 * registered asset into a `Cache-Control`/`ETag`-bearing response, including
 * conditional-GET (`If-None-Match` -> `304 Not Modified`) handling.
 *
 * ## Scope of this feature
 *
 * Like feature #48's `compileWithLayout` (`./layout.ts`) and feature #49's
 * partial resolution (`./partial.ts`) before it, this module is
 * infrastructure that lives in html-renderer's `src/` without (yet) being
 * wired into the `render:template` capability's surface (`../index.ts`) or
 * mounted onto a live HTTP server — widening `render:template`, or wiring a
 * real `GET /assets/...` route through api-gateway's `http:route`
 * capability, is a later feature's job. This feature's own step 3 ("write a
 * test asserting a registered asset is served with correct headers and
 * content") is satisfied by driving {@link buildAssetResponse} through a
 * real Fastify instance in-test (see
 * `tests/plugins/html-renderer/assets.test.ts`), proving the headers/body
 * contract holds over an actual HTTP response, without this module needing
 * to own a Fastify instance itself — exactly the "dependency-free templating
 * engine" posture spec.md describes for this plugin.
 *
 * ## Namespacing
 *
 * Every asset is published under a `namespace` (e.g. a plugin id or theme
 * name) plus a `path` within that namespace (e.g. `"css/site.css"`) so two
 * plugins publishing `style.css` under their own namespace never collide —
 * the lookup key is always `${namespace}/${assetPath}` (see
 * {@link assetKey}). Both segments are validated: empty, `..`
 * traversal, and a leading/embedded NUL are all rejected as
 * {@link ValidationError}s, never silently normalized, since a namespace or
 * path is caller-controlled data that ends up forming part of a URL.
 */
import { createHash } from "node:crypto";
import { ValidationError } from "../../../core/errors.js";
import { err, ok, type Result } from "../../../core/types.js";

/** A registered asset's content, always normalized to a `Buffer` regardless of how it was registered. */
export interface RegisteredAsset {
  readonly namespace: string;
  readonly path: string;
  readonly content: Buffer;
  readonly contentType: string;
  /** A strong, quoted ETag (`"<sha256-hex>"`) derived from `content` at registration time. */
  readonly etag: string;
  /** The `Cache-Control` header value this asset is served with. */
  readonly cacheControl: string;
}

export interface RegisterAssetOptions {
  /**
   * Explicit MIME type. Defaults to a guess from `assetPath`'s extension
   * (see {@link guessContentType}) — required only for an extension this
   * module doesn't recognize.
   */
  readonly contentType?: string;
  /**
   * `Cache-Control` header value to serve this asset with. Defaults to
   * {@link DEFAULT_CACHE_CONTROL} — a conservative, revalidate-friendly
   * value (assets here are registered by path, not content-hashed into the
   * URL, so `immutable` would overpromise: the same path can legitimately
   * be re-registered with different content, e.g. a theme update). The
   * `ETag` this module always attaches means a client still avoids
   * re-downloading unchanged content via a `304`, regardless of `max-age`.
   */
  readonly cacheControl?: string;
}

/** What {@link buildAssetResponse} hands back for a request that matches a registered asset. */
export type AssetResponse =
  | {
      readonly status: 200;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Buffer;
    }
  | {
      readonly status: 304;
      readonly headers: Readonly<Record<string, string>>;
    };

/** Conservative default — see {@link RegisterAssetOptions.cacheControl}. One hour, revalidated via ETag thereafter. */
export const DEFAULT_CACHE_CONTROL = "public, max-age=3600, must-revalidate";

/** Extension (including the leading dot, lowercased) -> MIME type, for the common theme-asset kinds this feature names explicitly (CSS/JS/images). */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** A namespace/path segment: at least one character, no `/`, no `..`, no NUL — see module docs on why this can't be silently normalized. */
const SAFE_SEGMENT_PATTERN = /^[^/\0]+$/;

function guessContentType(assetPath: string): string {
  const lastDot = assetPath.lastIndexOf(".");
  if (lastDot === -1) {
    return FALLBACK_CONTENT_TYPE;
  }
  const extension = assetPath.slice(lastDot).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? FALLBACK_CONTENT_TYPE;
}

/** Every individual `/`-separated segment of `assetPath` must itself be a safe segment (see {@link SAFE_SEGMENT_PATTERN}) and neither `.` nor `..` — this is what actually rejects traversal (`"a/../b"` splits to `["a", "..", "b"]`), not just a whole-string check. */
function isSafeAssetPath(assetPath: string): boolean {
  if (assetPath.length === 0 || assetPath.startsWith("/") || assetPath.endsWith("/")) {
    return false;
  }
  return assetPath
    .split("/")
    .every((segment) => SAFE_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..");
}

function assetKey(namespace: string, assetPath: string): string {
  return `${namespace}/${assetPath}`;
}

function computeEtag(content: Buffer): string {
  return `"${createHash("sha256").update(content).digest("hex")}"`;
}

/**
 * A namespaced, in-memory store of static assets (feature #51, step 1). One
 * registry instance is an independent store — see {@link createAssetRegistry}
 * for why this is a factory rather than a module-level singleton, matching
 * every other kernel primitive's "no ambient authority" convention
 * (broker.ts, events.ts).
 */
export interface AssetRegistry {
  /**
   * Publish (or replace) `content` under `namespace`/`assetPath`. Content is
   * accepted as a `string` (encoded as UTF-8) or a `Buffer` (used as-is, for
   * binary assets like images/fonts). Re-registering the same
   * `namespace`/`assetPath` pair overwrites the previous entry — recomputing
   * its `ETag` from the new content — rather than erroring, so a plugin can
   * legitimately update a theme asset's content across process lifetimes
   * (e.g. a hot-reloading dev server) without first unregistering it.
   *
   * Returns a {@link ValidationError} (never throws) for an empty
   * `namespace`, an empty/unsafe `assetPath` (leading/trailing `/`, a `..`
   * segment, or an embedded NUL byte in either), matching this codebase's
   * "expected, recoverable failure is a typed Result" convention
   * (template.ts, layout.ts).
   */
  registerAsset(
    namespace: string,
    assetPath: string,
    content: string | Buffer,
    options?: RegisterAssetOptions,
  ): Result<RegisteredAsset, ValidationError>;
  /** Look up a previously-registered asset, or `undefined` if nothing is registered under this exact `namespace`/`assetPath` pair. */
  getAsset(namespace: string, assetPath: string): RegisteredAsset | undefined;
  /** Every asset currently registered under `namespace`, for a caller that wants to enumerate a theme's published files (e.g. to generate `<link>`/`<script>` tags). */
  listAssets(namespace: string): readonly RegisteredAsset[];
}

/** Construct a fresh, empty {@link AssetRegistry}. */
export function createAssetRegistry(): AssetRegistry {
  const assets = new Map<string, RegisteredAsset>();

  return {
    registerAsset(namespace, assetPath, content, options) {
      if (namespace.length === 0 || !SAFE_SEGMENT_PATTERN.test(namespace)) {
        return err(
          new ValidationError(
            `registerAsset: "${namespace}" is not a valid namespace — expected a non-empty ` +
              `string with no "/" and no ".." segment.`,
            { details: { namespace } },
          ),
        );
      }
      if (!isSafeAssetPath(assetPath)) {
        return err(
          new ValidationError(
            `registerAsset: "${assetPath}" is not a valid asset path — expected a non-empty, ` +
              `relative path with no leading/trailing "/" and no ".." segment.`,
            { details: { namespace, assetPath } },
          ),
        );
      }

      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      const asset: RegisteredAsset = {
        namespace,
        path: assetPath,
        content: buffer,
        contentType: options?.contentType ?? guessContentType(assetPath),
        etag: computeEtag(buffer),
        cacheControl: options?.cacheControl ?? DEFAULT_CACHE_CONTROL,
      };
      assets.set(assetKey(namespace, assetPath), asset);
      return ok(asset);
    },

    getAsset(namespace, assetPath) {
      return assets.get(assetKey(namespace, assetPath));
    },

    listAssets(namespace) {
      return Array.from(assets.values()).filter((asset) => asset.namespace === namespace);
    },
  };
}

/** Split a comma-separated `If-None-Match` header into its individual (still-quoted) ETag tokens. */
function parseIfNoneMatch(headerValue: string): readonly string[] {
  return headerValue
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Does `ifNoneMatch` (a raw `If-None-Match` request header value) already
 * name `etag`? Per RFC 9110 §13.1.2, a bare `*` matches any current
 * representation, and otherwise any one of the (possibly multiple,
 * comma-separated) listed ETags matching is enough — a weak-comparison
 * prefix (`W/`) is stripped before comparing, since this module only ever
 * issues strong ETags but a client may still echo one back weakly.
 */
function ifNoneMatchHits(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === "*") {
    return true;
  }
  return parseIfNoneMatch(ifNoneMatch).some((candidate) => candidate.replace(/^W\//, "") === etag);
}

/**
 * Turn a {@link RegisteredAsset} into an HTTP response (feature #51, step
 * 2): `200` with the full body plus `Content-Type`/`Content-Length`/
 * `Cache-Control`/`ETag` headers, or `304 Not Modified` (body-less, only
 * `Cache-Control`/`ETag`) when `requestHeaders.ifNoneMatch` already names
 * this asset's current `ETag` — the standard conditional-GET revalidation
 * flow, so a client holding a fresh copy never re-downloads it.
 */
export function buildAssetResponse(
  asset: RegisteredAsset,
  requestHeaders: { readonly ifNoneMatch?: string } = {},
): AssetResponse {
  const sharedHeaders: Record<string, string> = {
    "cache-control": asset.cacheControl,
    etag: asset.etag,
  };

  if (
    requestHeaders.ifNoneMatch !== undefined &&
    ifNoneMatchHits(requestHeaders.ifNoneMatch, asset.etag)
  ) {
    return { status: 304, headers: sharedHeaders };
  }

  return {
    status: 200,
    headers: {
      ...sharedHeaders,
      "content-type": asset.contentType,
      "content-length": String(asset.content.byteLength),
    },
    body: asset.content,
  };
}
