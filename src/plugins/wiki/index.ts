/**
 * wiki plugin lifecycle module (feature #94 — "Wiki HTTP routes via
 * api-gateway (list/get/create/update/delete/search/history/diff)").
 *
 * Every prior wiki feature (#86-#93) built `src/` data-access/domain
 * modules with no HTTP surface at all — this is the feature that finally
 * mounts them onto real routes, and consequently the first time this
 * plugin has needed an `entry_point` module (see feature #93's own
 * claude-progress.txt notes anticipating exactly this).
 *
 * ## Step 1 — routes, JSON-schema validation, and "the appropriate
 * requiredPermission per route"
 *
 * Eight routes, mapping 1:1 onto this feature's own title
 * ("list/get/create/update/delete/search/history/diff"), all registered
 * through the `http:route` capability (feature #59, `./src/route-
 * capability.ts` in the api-gateway plugin) with a full request *and*
 * response JSON schema each — `registerRoute()` itself refuses to register
 * a route missing either (that module's own runtime backstop).
 *
 * `registerRoute()`'s own `requiredPermission` option is a *static*
 * `"resource:action"` string, checked against the single global resource it
 * names before a request ever reaches a handler (`api-gateway/src/rbac-
 * protection.ts`). That is the wrong tool here: feature #93 already built
 * the wiki plugin's authorization model to be *dynamic* — every operation's
 * required permission depends on which `namespaceId` a specific page
 * belongs to (`./src/access.ts`'s `wiki-<namespaceId>:<action>` override,
 * checked before the global `wiki:<action>` fallback). Setting a static
 * `requiredPermission: "wiki:read"` on, say, the `get` route would demand
 * every caller hold the *global* `wiki:read` grant even when they only hold
 * a namespace-scoped override for the one page they're asking about —
 * silently breaking feature #93 step 2's whole point. So every route below
 * omits `registerRoute()`'s `requiredPermission` option entirely and
 * instead applies "the appropriate requiredPermission" (this feature's own
 * wording) the way feature #93's own module docs anticipated: by resolving
 * the caller's identity from their session cookie — via `./src/session-
 * identity.ts`, a same-plugin re-implementation of the exact algorithm
 * `api-gateway/src/rbac-protection.ts` uses for its own static checks
 * (feature #63's signed-session-id scheme; see that module's own doc
 * comment for why this can't just import `session.ts` directly — `docs/
 * plugin-conventions.md` section 5) — and calling through `./src/
 * authorized-store.ts`'s `AuthorizedWikiStore` (list/get/create/update/
 * delete/history) or, for the one operation `authorized-store.ts` doesn't
 * cover (search — it predates this feature), applying `./src/access.ts`'s
 * `assertWikiAccess` directly —
 * the same primitive `authorized-store.ts` itself is built on, exactly as
 * that module's own doc comment anticipated ("or apply the same
 * assertWikiAccess pattern directly"). Either path throws
 * {@link AuthenticationError}/{@link AuthorizationError} (401/403) exactly
 * like a static `requiredPermission` check would — api-gateway's own
 * central error handler (feature #61) turns those into the same uniform
 * envelope either way, so a client cannot tell the two enforcement
 * mechanisms apart.
 *
 * `search` and `diff` (this feature's own scope, not dedicated features #92/
 * #90, which remain separate and not-yet-built) are backed by minimal, real
 * implementations added alongside this module — `./src/search.ts` (a
 * `LIKE`-based match over title/content) and `./src/diff.ts` (a pure
 * line-based longest-common-subsequence diff) — sufficient for these routes
 * to genuinely work end-to-end today; #92/#90 can deepen either
 * independently later without this route layer needing to change shape.
 *
 * ## Step 2 — API versioning (feature #62)
 *
 * Every route below omits `registerRoute()`'s `version` option, so each one
 * picks up `DEFAULT_API_VERSION` ("v1") automatically and is reachable at
 * `/api/v1/wiki/...`, never at a bare `/wiki/...` path — see
 * `route-capability.ts`'s `buildVersionedPath`/`docs/api-versioning.md`.
 *
 * ## Why this plugin now needs `depends_on: { "api-gateway": ... }`
 *
 * `rbac:check`/`db:query`/`render:template` are all obtained *lazily*,
 * inside a request handler — safe regardless of plugin load order, since by
 * the time any HTTP request is actually served the whole plugin-load pass
 * has already completed (the same reasoning `rbac-protection.ts`'s own
 * module docs give). `http:route` is different: `registerRoute()` must be
 * called *synchronously*, once, during this plugin's own `onEnable`, for
 * these routes to exist at all — and `capabilities.obtain()` only succeeds
 * once a provider has actually registered with the broker. Plugin load
 * order is driven purely by `depends_on` (`core/graph.ts`), not by
 * `capabilities.requires`, so without a hard `depends_on` on `api-gateway`
 * there would be no guarantee api-gateway's own `onEnable` (which
 * registers `http:route`, see `api-gateway/index.ts`) has already run by
 * the time this plugin's `onEnable` does — exactly the load-order race
 * every other real `http:route` consumer in this codebase's own test
 * fixtures already declares `depends_on` to avoid (e.g.
 * `tests/plugins/api-gateway/rbac-protection.integration.test.ts`'s
 * `rbac-fixture` manifest). Feature #85's original manifest deliberately
 * left `depends_on` empty because, at the time, nothing in this plugin
 * called a capability synchronously during a lifecycle hook — this feature
 * is the first thing that does, so the manifest changes with it (see
 * `./plugin.json` and `tests/plugins/wiki/manifest.test.ts`'s updated
 * assertion).
 */
import type { AuditSink } from "../../core/audit.js";
import type { PluginCapabilityAccess } from "../../core/broker.js";
import { NotFoundError, RenderError, ValidationError } from "../../core/errors.js";
import type { PluginLifecycleContext } from "../../core/loader.js";
import { isErr } from "../../core/types.js";
import type { HttpRouteCapability } from "../api-gateway/index.js";
import type { RenderTemplateCapability } from "../html-renderer/index.js";
import type { RbacCheckCapability } from "../rbac/index.js";
import { assertWikiAccessAudited, wikiAuditTarget } from "./src/access.js";
import { loadAttachmentStorageConfig } from "./src/attachment-storage-config.js";
import { createWikiAttachmentsStore } from "./src/attachments.js";
import {
  createAuthorizedAttachmentsStore,
  type AuthorizedAttachmentsStore,
} from "./src/authorized-attachments.js";
import { createAuthorizedWikiStore, type AuthorizedWikiStore } from "./src/authorized-store.js";
import { diffLines, renderDiffToHtml } from "./src/diff.js";
import { renderMarkdownToHtml } from "./src/markdown.js";
import {
  CREATE_PAGE_FORM_ACTION,
  editPageFormAction,
  renderPageFormHtml,
} from "./src/page-form.js";
import { createWikiPagesStore, type WikiDbQueryCapability } from "./src/pages.js";
import { createWikiRenderCache, type WikiRenderCache } from "./src/render-cache.js";
import { createWikiRevisionsStore } from "./src/revisions.js";
import { searchWikiPages } from "./src/search.js";
import {
  loadSessionIdentityConfig,
  resolveUserId as resolveUserIdFromSession,
  type RequestWithCookies,
} from "./src/session-identity.js";
import type { Attachment, Page, Revision } from "./src/types.js";

/** Capability id `api-gateway` registers `registerRoute()`/`getApp()` under (feature #59). */
const HTTP_ROUTE_CAPABILITY_ID = "http:route";
/** Capability id `database-mysql` registers its `query()` handle under (feature #20). */
const DB_QUERY_CAPABILITY_ID = "db:query";
/** Capability id `rbac` registers `check()` under (feature #39). */
const RBAC_CHECK_CAPABILITY_ID = "rbac:check";
/** Capability id `html-renderer` registers `compile()`/`render()` under (feature #52). */
const RENDER_TEMPLATE_CAPABILITY_ID = "render:template";

/**
 * Backing state for this plugin's wiki-level audit trail (feature #98 —
 * "Wiki-level audit log surfaced via the kernel audit trail"). Exported,
 * mutable module state mirroring `rbac/index.ts`'s own `auditState`
 * precedent (see that export's docs): {@link onInstall} copies the
 * kernel's real sink in here the same way `loader.ts` already threads
 * `PluginLifecycleContext.auditSink` into every plugin; every route
 * handler below reads `auditState.sink` fresh (never memoized at
 * `onEnable` time) when it builds this request's own `AuthorizedWikiStore`
 * (`./src/authorized-store.ts`) or calls `assertWikiAccessAudited`
 * directly. `sink` starts `undefined` — a request served before this hook
 * has run (or a test that never goes through `loadPlugins()`) simply isn't
 * audited, exactly like `rbac/index.ts`'s own optional sink.
 */
export const auditState: { sink: AuditSink | undefined } = { sink: undefined };

/**
 * Backing state for this plugin's rendered-page cache (feature #101 —
 * "Wiki rendered-page caching with invalidation on edit"). Held in a
 * mutable container and replaced with a fresh {@link WikiRenderCache}
 * instance in {@link onInstall}, mirroring {@link auditState}'s own
 * reset-per-plugin-load precedent immediately above — so two separate
 * plugin loads (e.g. two independent test suites in the same process) never
 * share cache entries or revision counters. See `./src/render-cache.ts`'s
 * module doc for the full caching/invalidation design.
 */
export const renderCacheState: { cache: WikiRenderCache } = { cache: createWikiRenderCache() };

/**
 * Resolve the calling user's identity from their session cookie (feature
 * #63) via `./src/session-identity.ts` — a same-plugin re-implementation of
 * `api-gateway/src/rbac-protection.ts`'s own resolution (see that module's
 * doc comment for why this can't just import `session.ts` directly).
 * `undefined` means "no valid session" — `./src/access.ts`'s
 * `assertWikiAccess`/`authorized-store.ts` turn that into a 401, never a
 * silently-anonymous request.
 */
function resolveUserId(request: RequestWithCookies): string | undefined {
  return resolveUserIdFromSession(request, loadSessionIdentityConfig());
}

/** Every store/capability handle a route handler needs, obtained fresh per request — see `obtainWikiStores`'s own doc comment for why. */
interface WikiRequestStores {
  readonly authorized: AuthorizedWikiStore;
  readonly attachments: AuthorizedAttachmentsStore;
  readonly dbQuery: WikiDbQueryCapability;
  readonly rbacCheck: RbacCheckCapability;
}

/**
 * Obtain `db:query`/`rbac:check` and build this request's own
 * `AuthorizedWikiStore` (feature #93) over them. Called fresh at the start
 * of every handler — never memoized at `onEnable` time — for the same
 * load-order-safety reason `rbac-protection.ts`/`error-handler.ts` obtain
 * their own lazy capabilities per-request rather than once: by request time
 * the whole plugin-load pass has completed, so this always succeeds
 * whenever `rbac`/`database-mysql` are actually loaded and granted, with no
 * dependency on *this* plugin's own `onEnable` having run before theirs
 * did. A failed `obtain()` (capability not granted, or its plugin never
 * loaded — e.g. no reachable MySQL) throws the `CapabilityDeniedError`
 * `obtain()` itself returns, unchanged: it is already a proper `AppError`
 * (403) the central error handler renders correctly, and "this deployment
 * hasn't wired up the wiki's dependencies" is a reasonable fit for that
 * status, mirroring `rbac-protection.ts`'s own handling of a failed
 * `rbac:check` obtain.
 */
function obtainWikiStores(capabilities: PluginCapabilityAccess): WikiRequestStores {
  const dbObtained = capabilities.obtain<WikiDbQueryCapability>(DB_QUERY_CAPABILITY_ID);
  if (isErr(dbObtained)) {
    throw dbObtained.error;
  }
  const rbacObtained = capabilities.obtain<RbacCheckCapability>(RBAC_CHECK_CAPABILITY_ID);
  if (isErr(rbacObtained)) {
    throw rbacObtained.error;
  }

  const dbQuery = dbObtained.value;
  const rbacCheck = rbacObtained.value;
  const pages = createWikiPagesStore(dbQuery);
  const revisions = createWikiRevisionsStore(dbQuery);
  const authorized = createAuthorizedWikiStore(pages, revisions, rbacCheck, auditState.sink);

  // Feature #97 ("Attachments/file upload support for wiki pages"): the
  // storage location/size-limit config is loaded fresh per request (never
  // memoized at onEnable time), the same rationale `resolveUserId`'s own
  // per-request `loadSessionIdentityConfig()` call already establishes —
  // cheap (a small zod parse) and lets a test change `process.env` between
  // requests without restarting the plugin.
  const attachmentConfig = loadAttachmentStorageConfig();
  const attachmentsStore = createWikiAttachmentsStore(dbQuery, {
    dir: attachmentConfig.WIKI_ATTACHMENTS_DIR,
    maxBytes: attachmentConfig.WIKI_ATTACHMENT_MAX_BYTES,
  });
  const attachments = createAuthorizedAttachmentsStore(
    pages,
    attachmentsStore,
    rbacCheck,
    auditState.sink,
  );

  return { authorized, attachments, dbQuery, rbacCheck };
}

/** Obtain `render:template` (feature #52), for the `get` route's Markdown-to-HTML rendering (feature #88) and the `diff` route's diff-to-HTML rendering (feature #90) — see `obtainWikiStores`'s docs for why this is fetched fresh per request rather than at `onEnable` time. */
function obtainRenderTemplate(capabilities: PluginCapabilityAccess): RenderTemplateCapability {
  const obtained = capabilities.obtain<RenderTemplateCapability>(RENDER_TEMPLATE_CAPABILITY_ID);
  if (isErr(obtained)) {
    throw obtained.error;
  }
  return obtained.value;
}

/**
 * One entry as {@link resolveQueryableAuditSink}'s query surface hands
 * back — a structural (not imported) type, matching `core/audit.ts`'s
 * `AuditEvent` shape field-for-field without depending on that module's
 * exported interface directly (this file only needs to read these five
 * fields back out).
 */
interface WikiAuditEntryLike {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly timestamp: number;
  readonly details?: Record<string, unknown>;
}

/** A sink shaped like `core/audit.ts`'s `InMemoryAuditSink`/`MySqlAuditSink` — has a `query()` read-side, not just `AuditSink`'s bare `record()`. */
interface QueryableWikiAuditSink {
  query(filter?: { actor?: string }): readonly WikiAuditEntryLike[];
}

function hasQueryMethod(value: unknown): value is QueryableWikiAuditSink {
  return (
    typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof (value as { query: unknown }).query === "function"
  );
}

function hasCurrentDelegateMethod(value: unknown): value is { currentDelegate(): unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "currentDelegate" in value &&
    typeof (value as { currentDelegate: unknown }).currentDelegate === "function"
  );
}

/**
 * Resolve `auditState.sink` (which, in production, is actually a
 * `SwitchableAuditSink` — see `server/index.ts`'s `bootstrapKernel` — even
 * though `PluginLifecycleContext.auditSink`'s declared type is the
 * narrower, `record()`-only `AuditSink`) down to something this route can
 * actually call `query()` on, for the `GET /wiki/audit` admin view (feature
 * #98, step 2). Duck-types rather than importing `SwitchableAuditSink`/
 * `InMemoryAuditSink`/`MySqlAuditSink` directly, mirroring
 * `server/index.ts`'s own `isAuditLogDbQuery`/`isHttpRouteCapability`
 * "duck-type the shape, don't import the concrete type" precedent.
 * Resolves to `undefined` (never throws) when no sink is wired at all, or
 * the wired sink (its current delegate, if switchable) doesn't expose a
 * `query()` method — the route below renders that as an empty list rather
 * than failing the request, since "no audit trail available this boot" is
 * not itself an error condition for an admin who's simply looking.
 */
function resolveQueryableAuditSink(
  sink: AuditSink | undefined,
): QueryableWikiAuditSink | undefined {
  if (!sink) {
    return undefined;
  }
  const candidate = hasCurrentDelegateMethod(sink) ? sink.currentDelegate() : sink;
  return hasQueryMethod(candidate) ? candidate : undefined;
}

/** Parse a `:id`-shaped path parameter into a positive integer surrogate key, or throw {@link ValidationError}. Shared by every route with a page id (or, reused verbatim, a revision id) in its path/query. */
function parsePositiveIntegerId(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`Invalid ${label} "${raw}": expected a positive integer.`, {
      details: { [label]: raw },
    });
  }
  return value;
}

/** JSON-safe projection of a {@link Page} — Fastify's response-schema serializer only ever emits properties the schema itself declares, so every field a route wants back must be listed explicitly (see this module's schema constants below); dates are rendered as ISO-8601 strings rather than relying on any implicit `Date` handling. */
function toPageJson(page: Page): Record<string, unknown> {
  return {
    id: page.id,
    namespaceId: page.namespaceId,
    slug: page.slug,
    title: page.title,
    content: page.content,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

/** JSON-safe projection of a {@link Revision} — see {@link toPageJson}'s docs for why every field is listed explicitly. */
function toRevisionJson(revision: Revision): Record<string, unknown> {
  return {
    id: revision.id,
    pageId: revision.pageId,
    title: revision.title,
    content: revision.content,
    createdAt: revision.createdAt.toISOString(),
  };
}

/** JSON-safe projection of an {@link Attachment} (feature #97) — deliberately omits `storageName`, the randomized on-disk filename, which must never reach a client (see `./src/attachment-storage.ts`'s module docs). */
function toAttachmentJson(attachment: Attachment): Record<string, unknown> {
  return {
    id: attachment.id,
    pageId: attachment.pageId,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt.toISOString(),
  };
}

/** Strip characters that could break out of the quoted-string in a `Content-Disposition` response header (feature #97 step 2) — a `"` would end the quoted filename early, and a CR/LF could inject an extra header line. The attachment's declared filename is caller-supplied, so this is applied unconditionally before it ever reaches a header value. */
function sanitizeContentDispositionFilename(filename: string): string {
  return filename.replace(/["\r\n]/g, "");
}

// ---------------------------------------------------------------------------
// JSON schemas (step 1 — every route below declares both halves)
// ---------------------------------------------------------------------------

const PAGE_ID_PARAMS_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

const PAGE_RESPONSE_PROPERTIES = {
  id: { type: "integer" },
  namespaceId: { type: "string" },
  slug: { type: "string" },
  title: { type: "string" },
  content: { type: "string" },
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
};
const PAGE_RESPONSE_REQUIRED = [
  "id",
  "namespaceId",
  "slug",
  "title",
  "content",
  "createdAt",
  "updatedAt",
];

const PAGE_SCHEMA = {
  type: "object",
  properties: PAGE_RESPONSE_PROPERTIES,
  required: PAGE_RESPONSE_REQUIRED,
};

const PAGE_WITH_HTML_SCHEMA = {
  type: "object",
  properties: { ...PAGE_RESPONSE_PROPERTIES, contentHtml: { type: "string" } },
  required: [...PAGE_RESPONSE_REQUIRED, "contentHtml"],
};

const LIST_PAGES_RESPONSE_SCHEMA = {
  type: "object",
  properties: { pages: { type: "array", items: PAGE_SCHEMA } },
  required: ["pages"],
};

const REVISION_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "integer" },
    pageId: { type: "integer" },
    title: { type: "string" },
    content: { type: "string" },
    createdAt: { type: "string" },
  },
  required: ["id", "pageId", "title", "content", "createdAt"],
};

const HISTORY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    pageId: { type: "integer" },
    revisions: { type: "array", items: REVISION_SCHEMA },
  },
  required: ["pageId", "revisions"],
};

const DIFF_QUERYSTRING_SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
  },
  required: ["from", "to"],
  additionalProperties: false,
};

const DIFF_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    pageId: { type: "integer" },
    from: { type: "integer" },
    to: { type: "integer" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { type: "string" }, value: { type: "string" } },
        required: ["type", "value"],
      },
    },
    html: { type: "string" },
  },
  required: ["pageId", "from", "to", "lines", "html"],
};

const SEARCH_QUERYSTRING_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", minLength: 1 },
    namespaceId: { type: "string" },
  },
  required: ["q"],
  additionalProperties: false,
};

const SEARCH_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          namespaceId: { type: "string" },
          slug: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
        },
        required: ["id", "namespaceId", "slug", "title", "snippet"],
      },
    },
  },
  required: ["query", "results"],
};

const DELETE_RESPONSE_SCHEMA = {
  type: "object",
  properties: { id: { type: "integer" }, deleted: { type: "boolean" } },
  required: ["id", "deleted"],
};

/** Path params for the two attachment routes nested under a page (feature #97) — `id` is the page id shared with every other page-scoped route above. */
const ATTACHMENT_ID_PARAMS_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, attachmentId: { type: "string" } },
  required: ["id", "attachmentId"],
  additionalProperties: false,
};

/** Upload request body (feature #97 step 1) — the file's bytes travel as a base64-encoded JSON field rather than `multipart/form-data`, since this codebase has no multipart-parsing dependency anywhere and every other route in this plugin already declares a plain JSON body schema; see `./src/attachment-storage-config.ts`'s module docs for the resulting interaction with api-gateway's own `REQUEST_BODY_LIMIT_BYTES`. */
const UPLOAD_ATTACHMENT_BODY_SCHEMA = {
  type: "object",
  properties: {
    filename: { type: "string", minLength: 1, maxLength: 255 },
    contentType: { type: "string", minLength: 1 },
    contentBase64: { type: "string", minLength: 1 },
  },
  required: ["filename", "contentType", "contentBase64"],
  additionalProperties: false,
};

const ATTACHMENT_RESPONSE_PROPERTIES = {
  id: { type: "integer" },
  pageId: { type: "integer" },
  filename: { type: "string" },
  contentType: { type: "string" },
  sizeBytes: { type: "integer" },
  createdAt: { type: "string" },
};
const ATTACHMENT_RESPONSE_REQUIRED = [
  "id",
  "pageId",
  "filename",
  "contentType",
  "sizeBytes",
  "createdAt",
];

const ATTACHMENT_SCHEMA = {
  type: "object",
  properties: ATTACHMENT_RESPONSE_PROPERTIES,
  required: ATTACHMENT_RESPONSE_REQUIRED,
};

const LIST_ATTACHMENTS_RESPONSE_SCHEMA = {
  type: "object",
  properties: { attachments: { type: "array", items: ATTACHMENT_SCHEMA } },
  required: ["attachments"],
};

/** Response schema for the binary download route below (feature #97 step 2). Deliberately loose (just a description) — the handler returns a raw `Buffer`, which Fastify sends untouched regardless of any declared schema (see that route's own doc comment), so this exists only to satisfy `registerRoute()`'s "must declare a response schema" runtime backstop. */
const BINARY_ATTACHMENT_RESPONSE_SCHEMA = {
  description:
    "Raw attachment binary data, served with the attachment's own content-type and a Content-Disposition header.",
};

/** Response schema for the two HTML form routes below (feature #96) — a plain string, matching api-gateway's own `GET /api/v1/docs` HTML route precedent (`../api-gateway/index.ts`'s `registerOpenApiDocumentationRoutes`). */
const HTML_PAGE_RESPONSE_SCHEMA = {
  type: "string",
  description: "A server-rendered HTML page.",
};

/** An explicit "no query input accepted" schema, reused by both HTML form routes below — same shape as `../api-gateway/index.ts`'s `NO_INPUT_QUERYSTRING_SCHEMA`. */
const NO_INPUT_QUERYSTRING_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** Querystring schema for the `GET /wiki/audit` admin route below (feature #98, step 2). */
const AUDIT_QUERYSTRING_SCHEMA = {
  type: "object",
  properties: {
    actor: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
  additionalProperties: false,
};

const AUDIT_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    actor: { type: "string" },
    action: { type: "string" },
    target: { type: "string" },
    outcome: { type: "string" },
    timestamp: { type: "integer" },
    details: { type: "object", additionalProperties: true },
  },
  required: ["actor", "action", "target", "outcome", "timestamp"],
};

const AUDIT_RESPONSE_SCHEMA = {
  type: "object",
  properties: { entries: { type: "array", items: AUDIT_ENTRY_SCHEMA } },
  required: ["entries"],
};

// ---------------------------------------------------------------------------
// Route registration (step 1 + step 2)
// ---------------------------------------------------------------------------

/**
 * Register every wiki HTTP route on `registrar` (feature #59's
 * `registerRoute()`), closing over `capabilities` for each handler's own
 * lazy `obtainWikiStores()`/`obtainRenderTemplate()` calls — see this
 * module's own doc comment for the full step 1/step 2 rationale. Called
 * once from {@link onEnable}, after `http:route` has been obtained.
 */
function registerWikiRoutes(
  registrar: HttpRouteCapability,
  capabilities: PluginCapabilityAccess,
): void {
  // GET /wiki/pages — list, optionally scoped to one namespace (step 1:
  // "list"). Requires "read", scoped to `namespaceId` if supplied.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages",
    schema: {
      querystring: {
        type: "object",
        properties: { namespaceId: { type: "string" } },
        additionalProperties: false,
      },
      response: { 200: LIST_PAGES_RESPONSE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const query = request.query as { namespaceId?: string };
      const { authorized } = obtainWikiStores(capabilities);
      const pages = await authorized.listPages(userId, query.namespaceId);
      return { pages: pages.map(toPageJson) };
    },
  });

  // GET /wiki/pages/:id — get, including the page's Markdown content
  // rendered to safe HTML via render:template (feature #88) (step 1:
  // "get"). Requires "read", scoped to the page's own namespace.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages/:id",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      querystring: { type: "object", additionalProperties: false },
      response: { 200: PAGE_WITH_HTML_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const id = parsePositiveIntegerId(params.id, "page id");

      const { authorized } = obtainWikiStores(capabilities);
      const page = await authorized.getPageById(userId, id);
      if (!page) {
        throw new NotFoundError(`Page with id ${id} does not exist.`, { details: { id } });
      }

      // Feature #101 step 1: serve this page's already-rendered HTML, keyed
      // by page id + revision id, instead of re-rendering unchanged
      // Markdown on every read — see `./src/render-cache.ts`'s module doc.
      const revisionId = renderCacheState.cache.currentRevisionId(id);
      const cachedHtml = renderCacheState.cache.get(id, revisionId);
      let contentHtml: string;
      if (cachedHtml !== undefined) {
        contentHtml = cachedHtml;
      } else {
        const renderTemplate = obtainRenderTemplate(capabilities);
        const rendered = renderMarkdownToHtml(page.content, renderTemplate.render);
        if (isErr(rendered)) {
          throw new RenderError(
            `Failed to render page ${id}'s Markdown content to HTML: ${rendered.error.message}`,
            { details: { id }, cause: rendered.error },
          );
        }
        contentHtml = rendered.value;
        renderCacheState.cache.set(id, revisionId, contentHtml);
      }

      return { ...toPageJson(page), contentHtml };
    },
  });

  // POST /wiki/pages — create (step 1: "create"). Requires "write" on the
  // target namespace.
  registrar.registerRoute({
    method: "POST",
    path: "/wiki/pages",
    schema: {
      body: {
        type: "object",
        properties: {
          namespaceId: { type: "string" },
          slug: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["namespaceId", "slug", "title", "content"],
        additionalProperties: false,
      },
      response: { 201: PAGE_SCHEMA },
    },
    handler: async (request, reply) => {
      const userId = resolveUserId(request);
      const body = request.body as {
        namespaceId: string;
        slug: string;
        title: string;
        content: string;
      };
      const { authorized } = obtainWikiStores(capabilities);
      const page = await authorized.createPage(userId, body);
      reply.status(201);
      return toPageJson(page);
    },
  });

  // PATCH /wiki/pages/:id — update (step 1: "update"). Requires "write",
  // scoped to the existing page's namespace.
  registrar.registerRoute({
    method: "PATCH",
    path: "/wiki/pages/:id",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      body: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        additionalProperties: false,
      },
      response: { 200: PAGE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const id = parsePositiveIntegerId(params.id, "page id");
      const body = request.body as { title?: string; content?: string };

      const { authorized } = obtainWikiStores(capabilities);
      const page = await authorized.updatePage(userId, id, body);
      // Feature #101 step 2: invalidate immediately on any edit — the very
      // next GET for this page id can never be served the pre-edit render.
      renderCacheState.cache.invalidate(id);
      return toPageJson(page);
    },
  });

  // DELETE /wiki/pages/:id — delete (step 1: "delete"). Requires "admin",
  // scoped to the existing page's namespace.
  registrar.registerRoute({
    method: "DELETE",
    path: "/wiki/pages/:id",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      response: { 200: DELETE_RESPONSE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const id = parsePositiveIntegerId(params.id, "page id");

      const { authorized } = obtainWikiStores(capabilities);
      await authorized.deletePage(userId, id);
      // A deleted page can never be re-rendered, so drop any cached entry
      // for it (feature #101) rather than leaking it for the rest of the
      // process's lifetime.
      renderCacheState.cache.invalidate(id);
      return { id, deleted: true };
    },
  });

  // GET /wiki/search — search (step 1: "search"). Requires "read", scoped
  // to `namespaceId` if supplied — the one operation `authorized-store.ts`
  // (feature #93) doesn't cover, since it predates this feature; applies
  // `assertWikiAccess` directly, the same primitive that module is built on
  // (see this module's own doc comment).
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/search",
    schema: {
      querystring: SEARCH_QUERYSTRING_SCHEMA,
      response: { 200: SEARCH_RESPONSE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const query = request.query as { q: string; namespaceId?: string };

      const { dbQuery, rbacCheck } = obtainWikiStores(capabilities);
      assertWikiAccessAudited(
        auditState.sink,
        rbacCheck,
        userId,
        "read",
        wikiAuditTarget(undefined, query.namespaceId),
        query.namespaceId,
      );

      const results = await searchWikiPages(dbQuery, query.q, query.namespaceId);
      return { query: query.q, results };
    },
  });

  // GET /wiki/pages/:id/revisions — history (step 1: "history"). Requires
  // "read", scoped to the page's own namespace.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages/:id/revisions",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      querystring: { type: "object", additionalProperties: false },
      response: { 200: HISTORY_RESPONSE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const pageId = parsePositiveIntegerId(params.id, "page id");

      const { authorized } = obtainWikiStores(capabilities);
      const revisions = await authorized.listRevisions(userId, pageId);
      return { pageId, revisions: revisions.map(toRevisionJson) };
    },
  });

  // GET /wiki/pages/:id/diff — diff between any two revisions of the same
  // page (step 1: "diff"), rendered to safe HTML via render:template
  // (feature #90, step 2 — see `./src/diff.ts`'s `renderDiffToHtml`).
  // Requires "read", scoped to the page's own namespace — reuses the
  // already-authorized `listRevisions` (above) rather than adding a new
  // authorized-store method, since every revision of a page is already
  // exactly the data a "read" check must have already authorized to return
  // via `history`.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages/:id/diff",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      querystring: DIFF_QUERYSTRING_SCHEMA,
      response: { 200: DIFF_RESPONSE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const pageId = parsePositiveIntegerId(params.id, "page id");
      const query = request.query as { from: string; to: string };
      const fromId = parsePositiveIntegerId(query.from, "revision id");
      const toId = parsePositiveIntegerId(query.to, "revision id");

      const { authorized } = obtainWikiStores(capabilities);
      const revisions = await authorized.listRevisions(userId, pageId);
      const from = revisions.find((revision) => revision.id === fromId);
      const to = revisions.find((revision) => revision.id === toId);
      if (!from || !to) {
        const missing = !from ? fromId : toId;
        throw new NotFoundError(`Revision ${missing} does not exist for page ${pageId}.`, {
          details: { pageId, from: fromId, to: toId },
        });
      }

      const lines = diffLines(from.content, to.content);

      const renderTemplate = obtainRenderTemplate(capabilities);
      const rendered = renderDiffToHtml(lines, renderTemplate.render);
      if (isErr(rendered)) {
        throw new RenderError(
          `Failed to render the diff between revisions ${fromId} and ${toId} of page ${pageId} to HTML: ${rendered.error.message}`,
          { details: { pageId, from: fromId, to: toId }, cause: rendered.error },
        );
      }

      return { pageId, from: fromId, to: toId, lines, html: rendered.value };
    },
  });

  // POST /wiki/pages/:id/attachments — upload an attachment (feature #97,
  // step 1: "size-limited, content-type-validated file upload tied to a
  // page, stored outside the webroot with randomized storage names").
  // Requires "write" on the page's own namespace — uploading an attachment
  // is a content mutation, the same class of operation as create/update
  // (see `./src/authorized-attachments.ts`'s module doc for the full
  // action-mapping rationale). Content-type/size validation happens inside
  // `AuthorizedAttachmentsStore.uploadAttachment` (via `./src/
  // attachments.ts`/`./src/attachment-storage.ts`), surfacing as an
  // ordinary `ValidationError` (400) — never a bespoke error path here.
  registrar.registerRoute({
    method: "POST",
    path: "/wiki/pages/:id/attachments",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      body: UPLOAD_ATTACHMENT_BODY_SCHEMA,
      response: { 201: ATTACHMENT_SCHEMA },
    },
    handler: async (request, reply) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const pageId = parsePositiveIntegerId(params.id, "page id");
      const body = request.body as {
        filename: string;
        contentType: string;
        contentBase64: string;
      };

      const { attachments } = obtainWikiStores(capabilities);
      const attachment = await attachments.uploadAttachment(userId, pageId, {
        filename: body.filename,
        contentType: body.contentType,
        data: Buffer.from(body.contentBase64, "base64"),
      });
      reply.status(201);
      return toAttachmentJson(attachment);
    },
  });

  // GET /wiki/pages/:id/attachments — list attachment metadata for a page
  // (feature #97). Requires "read", scoped to the page's own namespace.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages/:id/attachments",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      querystring: NO_INPUT_QUERYSTRING_SCHEMA,
      response: { 200: LIST_ATTACHMENTS_RESPONSE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const pageId = parsePositiveIntegerId(params.id, "page id");

      const { attachments } = obtainWikiStores(capabilities);
      const list = await attachments.listAttachments(userId, pageId);
      return { attachments: list.map(toAttachmentJson) };
    },
  });

  // GET /wiki/pages/:id/attachments/:attachmentId — serve an attachment's
  // raw bytes (feature #97, step 2: "Serve attachments through an
  // authorization-checked route ... respecting the page's permissions,
  // never directly from a static directory"). Requires "read", scoped to
  // the page's own namespace — the exact same check `getPageById`/`get`
  // above enforce, so an attachment is never more or less visible than the
  // page it's attached to. This is the *only* route that can ever produce
  // an attachment's bytes: there is no static-file-serving route anywhere
  // in this codebase (see `./src/attachment-storage.ts`'s module docs) —
  // the blob's on-disk location is never exposed to a client.
  //
  // The handler returns a raw `Buffer`. Fastify's own `reply.js` sends any
  // payload whose `.buffer` is an `ArrayBuffer` (true for every `Buffer`)
  // immediately, before it would ever reach this route's declared response
  // schema's JSON serializer — the same "payload type bypasses schema
  // serialization" mechanism `../api-gateway/index.ts`'s own
  // `/api/v1/docs` HTML route relies on for a `string` payload (see that
  // route's doc comment). `reply.type(attachment.contentType)` is what
  // makes the response reach the client with the attachment's own,
  // validated content-type rather than Fastify's default.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages/:id/attachments/:attachmentId",
    schema: {
      params: ATTACHMENT_ID_PARAMS_SCHEMA,
      querystring: NO_INPUT_QUERYSTRING_SCHEMA,
      response: { 200: BINARY_ATTACHMENT_RESPONSE_SCHEMA },
    },
    handler: async (request, reply) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string; attachmentId: string };
      const pageId = parsePositiveIntegerId(params.id, "page id");
      const attachmentId = parsePositiveIntegerId(params.attachmentId, "attachment id");

      const { attachments } = obtainWikiStores(capabilities);
      const { attachment, data } = await attachments.getAttachmentWithData(
        userId,
        pageId,
        attachmentId,
      );

      reply.type(attachment.contentType);
      reply.header(
        "content-disposition",
        `attachment; filename="${sanitizeContentDispositionFilename(attachment.filename)}"`,
      );
      return data;
    },
  });

  // GET /wiki/pages/new — the create-page form (feature #96, step 1). No
  // page exists yet to authorize against, so this route itself gates on
  // nothing beyond having a session cookie parsed (or not) the same way
  // every other route does — the *submission* this form posts to is the
  // already-authorized POST /wiki/pages route above, which is what
  // actually enforces "write" access for whichever namespace the user
  // types in. A user who can't write anywhere simply gets an
  // AuthorizationError back from that route, inline, exactly like any
  // other validation failure (step 2).
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages/new",
    schema: {
      querystring: NO_INPUT_QUERYSTRING_SCHEMA,
      response: { 200: HTML_PAGE_RESPONSE_SCHEMA },
    },
    handler: async (_request, reply) => {
      const renderTemplate = obtainRenderTemplate(capabilities);
      const rendered = renderPageFormHtml(
        {
          isEdit: false,
          namespaceId: "",
          slug: "",
          title: "",
          content: "",
          actionPath: CREATE_PAGE_FORM_ACTION,
          actionMethod: "POST",
        },
        renderTemplate.render,
      );
      if (isErr(rendered)) {
        throw new RenderError(`Failed to render the create-page form: ${rendered.error.message}`, {
          cause: rendered.error,
        });
      }
      reply.type("text/html; charset=utf-8");
      return rendered.value;
    },
  });

  // GET /wiki/pages/:id/edit — the edit-page form (feature #96, step 1),
  // prefilled with the page's current title/content. Requires "read",
  // scoped to the page's own namespace — the same authorized lookup the
  // plain `get` route above already performs, so an unauthorized caller
  // gets the same 401/403 here as they would hitting the JSON API
  // directly, never a peek at content they can't otherwise read.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/pages/:id/edit",
    schema: {
      params: PAGE_ID_PARAMS_SCHEMA,
      querystring: NO_INPUT_QUERYSTRING_SCHEMA,
      response: { 200: HTML_PAGE_RESPONSE_SCHEMA },
    },
    handler: async (request, reply) => {
      const userId = resolveUserId(request);
      const params = request.params as { id: string };
      const id = parsePositiveIntegerId(params.id, "page id");

      const { authorized } = obtainWikiStores(capabilities);
      const page = await authorized.getPageById(userId, id);
      if (!page) {
        throw new NotFoundError(`Page with id ${id} does not exist.`, { details: { id } });
      }

      const renderTemplate = obtainRenderTemplate(capabilities);
      const rendered = renderPageFormHtml(
        {
          isEdit: true,
          pageId: page.id,
          namespaceId: page.namespaceId,
          slug: page.slug,
          title: page.title,
          content: page.content,
          actionPath: editPageFormAction(page.id),
          actionMethod: "PATCH",
        },
        renderTemplate.render,
      );
      if (isErr(rendered)) {
        throw new RenderError(
          `Failed to render the edit-page form for page ${id}: ${rendered.error.message}`,
          { details: { id }, cause: rendered.error },
        );
      }
      reply.type("text/html; charset=utf-8");
      return rendered.value;
    },
  });

  // GET /wiki/audit — a simple admin view over the wiki-level slice of the
  // kernel audit trail (feature #98, step 2: "provide a simple admin
  // view/query listing recent wiki audit entries"). Requires "admin" on
  // the global wiki resource (no namespace scoping — this lists activity
  // across every namespace at once, so only a caller trusted with the
  // wiki's own admin-level permission, not merely a namespace-scoped
  // override, may use it). This check itself is audited too, via
  // `assertWikiAccessAudited`, exactly like every other guarded operation.
  registrar.registerRoute({
    method: "GET",
    path: "/wiki/audit",
    schema: {
      querystring: AUDIT_QUERYSTRING_SCHEMA,
      response: { 200: AUDIT_RESPONSE_SCHEMA },
    },
    handler: async (request) => {
      const userId = resolveUserId(request);
      const { rbacCheck } = obtainWikiStores(capabilities);
      assertWikiAccessAudited(auditState.sink, rbacCheck, userId, "admin", wikiAuditTarget());

      const query = request.query as { actor?: string; limit?: number };
      const sink = resolveQueryableAuditSink(auditState.sink);
      const wikiEntries = (
        sink?.query(query.actor !== undefined ? { actor: query.actor } : {}) ?? []
      ).filter((entry) => entry.action.startsWith("wiki:"));
      // Most-recent-first, capped at `limit` (default 50) — this is a
      // "recent entries" admin view (step 2's own wording), not a full
      // paginated export.
      const limit = query.limit ?? 50;
      const recent = wikiEntries.slice(-limit).reverse();

      return {
        entries: recent.map((entry) => ({
          actor: entry.actor,
          action: entry.action,
          target: entry.target,
          outcome: entry.outcome,
          timestamp: entry.timestamp,
          ...(entry.details !== undefined ? { details: entry.details } : {}),
        })),
      };
    },
  });
}

/**
 * Copies the kernel's real audit sink (`loader.ts`'s
 * `PluginLifecycleContext.auditSink`, feature #38) into {@link auditState}
 * so every subsequent request's `AuthorizedWikiStore`/`assertWikiAccessAudited`
 * call is audited (feature #98) — mirrors `rbac/index.ts`'s own
 * `onInstall` precedent exactly. Runs before {@link onEnable} (`loader.ts`'s
 * declare-before-hooks ordering), so `auditState.sink` is already set by
 * the time any route this plugin registers could possibly be reached.
 */
export function onInstall(context: PluginLifecycleContext): void {
  auditState.sink = context.auditSink;
  renderCacheState.cache = createWikiRenderCache();
}

/**
 * Obtain `http:route` and register every wiki route on it (step 1 + step
 * 2). Requires `depends_on: { "api-gateway": ... }` (see this module's own
 * doc comment) so `http:route` is guaranteed already registered with the
 * broker by the time this runs.
 */
export async function onEnable(context: PluginLifecycleContext): Promise<void> {
  const obtained = context.capabilities.obtain<HttpRouteCapability>(HTTP_ROUTE_CAPABILITY_ID);
  if (isErr(obtained)) {
    throw obtained.error;
  }
  registerWikiRoutes(obtained.value, context.capabilities);
}
