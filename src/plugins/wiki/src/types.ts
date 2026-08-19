/**
 * Core wiki-page data model (feature #87 — "Page CRUD via the db:query
 * capability"). Mirrors `migrations/0002_create_wiki_pages.ts`'s
 * `wiki_pages` schema 1:1 — see that migration's own doc comment for why
 * `id` is a surrogate autoincrement key (future features, e.g. #89's
 * revision history, reference a page by this stable integer, never by its
 * mutable `slug`) and why `(namespaceId, slug)` — not `slug` alone — is the
 * page's URL-facing identity.
 */

/** A wiki page, as persisted in `wiki_pages`. */
export interface Page {
  /** Surrogate autoincrement primary key. Stable even if the page is renamed/moved. */
  readonly id: number;
  /** The `wiki_namespaces.id` this page lives under. */
  readonly namespaceId: string;
  /** URL-facing slug, unique within {@link namespaceId} (feature #87 step 2). */
  readonly slug: string;
  /** Human-readable page title. */
  readonly title: string;
  /** The page's current body (Markdown source — feature #88 renders it, this layer stores it verbatim). */
  readonly content: string;
  /** When the page was first created. */
  readonly createdAt: Date;
  /** When the page's `title`/`content` was last changed. */
  readonly updatedAt: Date;
}

/** Input to {@link WikiPagesStore.createPage} in `pages.ts`. */
export interface CreatePageInput {
  /** Must reference an existing `wiki_namespaces.id` row — validated before insert (feature #87 step 2). */
  readonly namespaceId: string;
  /** Must satisfy `slug.ts`'s grammar and be unique within `namespaceId` — both validated before insert. */
  readonly slug: string;
  readonly title: string;
  readonly content: string;
}

/**
 * Fields that may be changed on an existing page via
 * {@link WikiPagesStore.updatePage} in `pages.ts`. An omitted field is left
 * unchanged. `namespaceId`/`slug` are deliberately not editable here — moving
 * a page to a different namespace/slug is a distinct operation this feature
 * does not need, left to a future feature if ever required, so this store
 * never has to re-validate slug uniqueness/namespace existence on update.
 */
export interface UpdatePageInput {
  readonly title?: string;
  readonly content?: string;
}
