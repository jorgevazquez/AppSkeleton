/**
 * RBAC-guarded facade over {@link WikiPagesStore}/{@link WikiRevisionsStore}
 * (feature #93, step 1's "apply rbac:check on every mutating and
 * restricted-read operation"). `pages.ts`/`revisions.ts` stay pure
 * data-access layers with no knowledge of identity or authorization — see
 * `pages.ts`'s own module doc for why. This module is the thin
 * authorization layer that sits in front of them: every method here takes
 * the same arguments its underlying store method does, plus a leading
 * `userId` (the resolved caller identity — e.g. feature #94's future HTTP
 * routes would resolve this from a session cookie, exactly like
 * `api-gateway/src/rbac-protection.ts` already does for route-level
 * `requiredPermission` checks), and throws via `./access.ts`'s
 * {@link assertWikiAccess} before ever touching the underlying store.
 *
 * ## Resolving *which* namespace to check
 *
 * `checkWikiAccess`/`assertWikiAccess` (`./access.ts`) need a namespace id
 * to evaluate a possible per-namespace override against. Where the caller
 * already supplies one directly (`createPage`'s `input.namespaceId`,
 * `getPageBySlug`'s `namespaceId` parameter, `listPages`'s optional
 * `namespaceId` filter), this module checks access *before* ever querying
 * the store — cheaper (no wasted round-trip for a denied caller) and it
 * never reveals whether a page exists to a caller who isn't even
 * authorized to read the namespace at all.
 *
 * Where the operation instead identifies a page by its surrogate `id`
 * (`getPageById`, `updatePage`, `deletePage`, `listRevisions`) there is no
 * namespace to check *until* the page has been looked up — this module
 * looks the page up first (a read with no side effects, safe to perform
 * before authorization), then checks access using the page's own
 * `namespaceId` if it was found, or with no namespace context at all
 * (falling back to the global default permission only) if it wasn't. This
 * has a deliberate, useful side effect: an unauthorized caller gets the
 * same 401/403 whether or not the page they asked about actually exists —
 * existence is never revealed before authorization succeeds. Only once
 * `assertWikiAccess` has *not* thrown does this module delegate to the
 * underlying store, which is where a genuine {@link NotFoundError} (id was
 * never valid) is finally surfaced, to an already-authorized caller.
 *
 * ## Action-per-operation mapping (step 1)
 *
 *   - `read`  — `getPageById`, `getPageBySlug`, `listPages`,
 *     `listRevisions` (all restricted reads).
 *   - `write` — `createPage`, `updatePage` (ordinary content mutations).
 *   - `admin` — `deletePage` only, matching `rbac/seeds/index.ts`'s own
 *     description of `wiki:admin` ("administer wiki pages/namespaces
 *     (delete, move, manage page-level access)") and its default-roles
 *     seed, where `editor` deliberately does *not* hold `wiki:admin` — an
 *     editor can create and edit pages but cannot delete them.
 *
 * There is deliberately no implied action hierarchy here (holding `write`
 * does not automatically imply `read`, nor does `admin` imply `write`):
 * `rbac/src/policy.ts`'s `can()` itself has no such concept — only
 * resource-level wildcards (`"wiki:*"`) and additive multi-role grants
 * (see that module's precedence rules 3–4) — and the seeded `admin` role
 * is simply granted all three permissions explicitly (`rbac/seeds/
 * index.ts`). Inventing a hierarchy here would make this module's
 * behavior diverge from what `rbac:check` alone would say for the same
 * `(userId, action, resource)` triple — a caller who checks
 * `rbac:check("bob", "read", "wiki")` directly and one who calls
 * `getPageById("bob", ...)` through this module should always agree.
 */
import type { RbacCheckCapability } from "../../rbac/index.js";
import { assertWikiAccess } from "./access.js";
import type { WikiPagesStore } from "./pages.js";
import type { WikiRevisionsStore } from "./revisions.js";
import type { CreatePageInput, Page, Revision, UpdatePageInput } from "./types.js";

/**
 * The RBAC-guarded surface {@link createAuthorizedWikiStore} returns —
 * every method mirrors its underlying `WikiPagesStore`/`WikiRevisionsStore`
 * counterpart, plus a leading `userId` parameter. `userId` is
 * `string | undefined` (not just `string`) so a caller with no resolved
 * identity at all (e.g. an anonymous HTTP request with no session cookie)
 * can be represented directly — `assertWikiAccess` turns that into a 401
 * {@link AuthenticationError}, not a type error at the call site.
 */
export interface AuthorizedWikiStore {
  /** Requires `write` on `input.namespaceId`. See `WikiPagesStore.createPage` for the underlying behavior. */
  createPage(userId: string | undefined, input: CreatePageInput): Promise<Page>;
  /** Requires `read`, scoped to the found page's namespace (or the global default if no page matches `id`). See `WikiPagesStore.getPageById`. */
  getPageById(userId: string | undefined, id: number): Promise<Page | undefined>;
  /** Requires `read` on `namespaceId`, checked before the store is ever queried. See `WikiPagesStore.getPageBySlug`. */
  getPageBySlug(
    userId: string | undefined,
    namespaceId: string,
    slug: string,
  ): Promise<Page | undefined>;
  /** Requires `read`, scoped to `namespaceId` if supplied, else the global default only. See `WikiPagesStore.listPages`. */
  listPages(userId: string | undefined, namespaceId?: string): Promise<Page[]>;
  /** Requires `write`, scoped to the existing page's namespace (or the global default if `id` doesn't match a page). See `WikiPagesStore.updatePage`. */
  updatePage(userId: string | undefined, id: number, changes: UpdatePageInput): Promise<Page>;
  /** Requires `admin`, scoped to the existing page's namespace (or the global default if `id` doesn't match a page). See `WikiPagesStore.deletePage`. */
  deletePage(userId: string | undefined, id: number): Promise<void>;
  /** Requires `read`, scoped to the owning page's namespace (or the global default if `pageId` doesn't match a page). See `WikiRevisionsStore.listRevisions`. */
  listRevisions(userId: string | undefined, pageId: number): Promise<Revision[]>;
}

/**
 * Build the RBAC-guarded facade over already-constructed
 * `pages`/`revisions` stores (`./pages.js`'s {@link createWikiPagesStore},
 * `./revisions.js`'s {@link createWikiRevisionsStore}) and an
 * already-obtained `rbac:check` capability handle — mirrors those two
 * factories' own "accept an already-obtained dependency, build nothing
 * yourself" shape.
 */
export function createAuthorizedWikiStore(
  pages: WikiPagesStore,
  revisions: WikiRevisionsStore,
  rbacCheck: RbacCheckCapability,
): AuthorizedWikiStore {
  return {
    async createPage(userId, input) {
      assertWikiAccess(rbacCheck, userId, "write", input.namespaceId);
      return pages.createPage(input);
    },

    async getPageById(userId, id) {
      const page = await pages.getPageById(id);
      assertWikiAccess(rbacCheck, userId, "read", page?.namespaceId);
      return page;
    },

    async getPageBySlug(userId, namespaceId, slug) {
      assertWikiAccess(rbacCheck, userId, "read", namespaceId);
      return pages.getPageBySlug(namespaceId, slug);
    },

    async listPages(userId, namespaceId) {
      assertWikiAccess(rbacCheck, userId, "read", namespaceId);
      return pages.listPages(namespaceId);
    },

    async updatePage(userId, id, changes) {
      const existing = await pages.getPageById(id);
      assertWikiAccess(rbacCheck, userId, "write", existing?.namespaceId);
      return pages.updatePage(id, changes);
    },

    async deletePage(userId, id) {
      const existing = await pages.getPageById(id);
      assertWikiAccess(rbacCheck, userId, "admin", existing?.namespaceId);
      return pages.deletePage(id);
    },

    async listRevisions(userId, pageId) {
      const owningPage = await pages.getPageById(pageId);
      assertWikiAccess(rbacCheck, userId, "read", owningPage?.namespaceId);
      return revisions.listRevisions(pageId);
    },
  };
}
