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
import type { PluginCapabilityAccess } from "../../core/broker.js";
import { NotFoundError, RenderError, ValidationError } from "../../core/errors.js";
import type { PluginLifecycleContext } from "../../core/loader.js";
import { isErr } from "../../core/types.js";
import type { HttpRouteCapability } from "../api-gateway/index.js";
import type { RenderTemplateCapability } from "../html-renderer/index.js";
import type { RbacCheckCapability } from "../rbac/index.js";
import { assertWikiAccess } from "./src/access.js";
import { createAuthorizedWikiStore, type AuthorizedWikiStore } from "./src/authorized-store.js";
import { diffLines, renderDiffToHtml } from "./src/diff.js";
import { renderMarkdownToHtml } from "./src/markdown.js";
import {
  CREATE_PAGE_FORM_ACTION,
  editPageFormAction,
  renderPageFormHtml,
} from "./src/page-form.js";
import { createWikiPagesStore, type WikiDbQueryCapability } from "./src/pages.js";
import { createWikiRevisionsStore } from "./src/revisions.js";
import { searchWikiPages } from "./src/search.js";
import {
  loadSessionIdentityConfig,
  resolveUserId as resolveUserIdFromSession,
  type RequestWithCookies,
} from "./src/session-identity.js";
import type { Page, Revision } from "./src/types.js";

/** Capability id `api-gateway` registers `registerRoute()`/`getApp()` under (feature #59). */
const HTTP_ROUTE_CAPABILITY_ID = "http:route";
/** Capability id `database-mysql` registers its `query()` handle under (feature #20). */
const DB_QUERY_CAPABILITY_ID = "db:query";
/** Capability id `rbac` registers `check()` under (feature #39). */
const RBAC_CHECK_CAPABILITY_ID = "rbac:check";
/** Capability id `html-renderer` registers `compile()`/`render()` under (feature #52). */
const RENDER_TEMPLATE_CAPABILITY_ID = "render:template";

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
  const authorized = createAuthorizedWikiStore(pages, revisions, rbacCheck);
  return { authorized, dbQuery, rbacCheck };
}

/** Obtain `render:template` (feature #52), for the `get` route's Markdown-to-HTML rendering (feature #88) and the `diff` route's diff-to-HTML rendering (feature #90) — see `obtainWikiStores`'s docs for why this is fetched fresh per request rather than at `onEnable` time. */
function obtainRenderTemplate(capabilities: PluginCapabilityAccess): RenderTemplateCapability {
  const obtained = capabilities.obtain<RenderTemplateCapability>(RENDER_TEMPLATE_CAPABILITY_ID);
  if (isErr(obtained)) {
    throw obtained.error;
  }
  return obtained.value;
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

      const renderTemplate = obtainRenderTemplate(capabilities);
      const rendered = renderMarkdownToHtml(page.content, renderTemplate.render);
      if (isErr(rendered)) {
        throw new RenderError(
          `Failed to render page ${id}'s Markdown content to HTML: ${rendered.error.message}`,
          { details: { id }, cause: rendered.error },
        );
      }

      return { ...toPageJson(page), contentHtml: rendered.value };
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
      assertWikiAccess(rbacCheck, userId, "read", query.namespaceId);

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
