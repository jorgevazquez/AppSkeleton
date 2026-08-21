/**
 * Rendered-page HTML caching, keyed by page id + revision id, with
 * invalidation on edit (feature #101 — "Wiki rendered-page caching with
 * invalidation on edit").
 *
 * `index.ts`'s `GET /wiki/pages/:id` route (feature #94) renders a page's
 * Markdown `content` to HTML on every request via `./markdown.ts`'s
 * `renderMarkdownToHtml` (feature #88) — real work (parsing + template
 * compilation + rendering) repeated identically for a page that, outside of
 * an edit, never changes. This module is the missing cache in front of that:
 * once a given page id's *current* content has been rendered once, every
 * subsequent read of that same, unchanged page hands back the already-
 * rendered HTML instead of re-parsing/re-rendering the Markdown from
 * scratch — mirroring `html-renderer/src/template-cache.ts`'s own
 * "compile once, reuse the compiled result" shape (feature #53), just for a
 * wiki page's rendered output rather than a compiled template.
 *
 * ## Step 1 — keyed by page id + revision id
 *
 * A page's live `wiki_pages.content` (see `./pages.ts`/`./types.ts`) carries
 * no revision number of its own — `wiki_revisions` only ever records the
 * page's content *before* an edit (feature #89), never the live row's own
 * version. Rather than adding a schema column (or paying for an extra
 * `db:query` round trip on every single read just to derive one), this
 * module tracks its own per-page-id revision counter entirely in memory:
 * every page starts at revision `0`, and {@link WikiRenderCache.invalidate}
 * — called by `index.ts`'s `PATCH /wiki/pages/:id` handler immediately after
 * a successful `updatePage` (feature #87 step 1's own `updatePage`, which is
 * exactly the one place a page's `content` can ever change) — increments it.
 * {@link WikiRenderCache.get}/{@link WikiRenderCache.set} both take that
 * counter's current value as an explicit `revisionId` argument, so a cached
 * entry is only ever a hit when it was stored under the exact revision id a
 * caller is asking about right now.
 *
 * ## Step 2 — invalidation is immediate, not eventual
 *
 * {@link WikiRenderCache.invalidate} does two things, synchronously, before
 * it returns: it bumps the page's revision counter *and* deletes any
 * existing cache entry for that page id outright. Bumping the counter alone
 * would already be enough to make the next `get()` miss (it asks for the new
 * revision id, which nothing has been `set()` under yet) — deleting the
 * entry too is a belt-and-suspenders second guarantee that a stale render
 * can never be handed back under any revision id, old or new, and keeps this
 * cache's memory bounded to one entry per page that has actually been read
 * since its last edit (or since process start), never one per historical
 * revision. There is no time-based expiry anywhere in this module — a cached
 * render is valid for exactly as long as its page's content hasn't changed,
 * however long or short that turns out to be, exactly like
 * `template-cache.ts`'s production-mode entries have no TTL of their own
 * either.
 *
 * ## One instance per plugin load, not a module-level singleton
 *
 * Like `template-cache.ts`'s `createTemplateCache` and `assets.ts`'s
 * `createAssetRegistry`, {@link createWikiRenderCache} is a factory, not a
 * module-level singleton — `index.ts` holds its one real instance in a
 * mutable container (mirroring that same file's own `auditState` precedent)
 * and replaces it with a fresh instance in `onInstall`, so two separate
 * plugin loads (e.g. two independent test suites, or a real process restart)
 * never share cache state.
 */

/** One page id's cached render: the revision id it was rendered from, and the resulting HTML. */
interface CacheEntry {
  readonly revisionId: number;
  readonly html: string;
}

export interface WikiRenderCache {
  /**
   * The revision id `pageId`'s content is *currently* at — `0` until the
   * first {@link invalidate} call for that id, incrementing by one on every
   * subsequent call. A caller renders/caches/looks up a page's HTML under
   * this value, never one it invents itself, so it always agrees with
   * whatever {@link invalidate} most recently did for this `pageId`.
   */
  currentRevisionId(pageId: number): number;
  /**
   * Return the cached HTML for `pageId` if — and only if — it was
   * {@link set} under exactly this `revisionId`. Returns `undefined` on any
   * miss: no entry yet, or an entry that was cached under a since-superseded
   * (older) revision id.
   */
  get(pageId: number, revisionId: number): string | undefined;
  /** Cache `html` as `pageId`'s rendered content for `revisionId`, replacing whatever (if anything) was cached for `pageId` before. */
  set(pageId: number, revisionId: number, html: string): void;
  /**
   * Immediately invalidate `pageId`'s cached render (feature #101 step 2):
   * bumps its revision id and drops any existing cache entry, so no
   * subsequent {@link get} can ever hand back the pre-edit HTML again. Safe
   * to call for a `pageId` that has never been cached at all (e.g. a page
   * whose Markdown content is edited before its rendered HTML was ever
   * requested even once).
   */
  invalidate(pageId: number): void;
  /** How many distinct page ids currently have a cached render. Exposed for tests/observability, mirroring `template-cache.ts`'s own `size()`. */
  size(): number;
  /** Drop every cached entry and reset every page id's revision counter back to `0`. */
  clear(): void;
}

/**
 * Construct a fresh, empty {@link WikiRenderCache}. One instance owns its
 * own independent maps — see this module's doc comment's "one instance per
 * plugin load" section for why this is a factory rather than a singleton.
 */
export function createWikiRenderCache(): WikiRenderCache {
  const revisionIds = new Map<number, number>();
  const entries = new Map<number, CacheEntry>();

  return {
    currentRevisionId(pageId) {
      return revisionIds.get(pageId) ?? 0;
    },

    get(pageId, revisionId) {
      const entry = entries.get(pageId);
      return entry !== undefined && entry.revisionId === revisionId ? entry.html : undefined;
    },

    set(pageId, revisionId, html) {
      entries.set(pageId, { revisionId, html });
    },

    invalidate(pageId) {
      revisionIds.set(pageId, (revisionIds.get(pageId) ?? 0) + 1);
      entries.delete(pageId);
    },

    size() {
      return entries.size;
    },

    clear() {
      revisionIds.clear();
      entries.clear();
    },
  };
}
