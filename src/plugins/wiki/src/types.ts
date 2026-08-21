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

/**
 * An immutable snapshot of a page's `title`/`content` as it existed
 * immediately before some edit (feature #89 — "Revision history: every
 * edit creates a revision row"). Mirrors
 * `migrations/0003_create_wiki_revisions.ts`'s `wiki_revisions` schema 1:1
 * — see that migration's own doc comment for why `pageId` references
 * {@link Page.id}, never a page's mutable `slug`.
 */
export interface Revision {
  /** Surrogate autoincrement primary key. Also the tiebreaker `revisions.ts`'s `listRevisions` orders by, newest first. */
  readonly id: number;
  /** The {@link Page.id} this revision belongs to. */
  readonly pageId: number;
  /** The page's `title` immediately before the edit that produced this revision. */
  readonly title: string;
  /** The page's `content` immediately before the edit that produced this revision. */
  readonly content: string;
  /** When this revision was recorded — i.e. when the edit that superseded it was applied. */
  readonly createdAt: Date;
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

/**
 * A page's minimal summary as attached to its namespace's node in the page
 * tree (feature #91 — "Page tree / navigation sidebar reflecting namespace
 * hierarchy"). Deliberately omits `content`/timestamps — a navigation
 * sidebar entry only ever needs enough to link to the page
 * (`namespaceId`/`slug`, from the enclosing {@link NamespaceTreeNode}, plus
 * this page's own `slug`) and a human-readable label (`title`).
 */
export interface PageTreeEntry {
  /** The {@link Page.id} this entry summarizes. */
  readonly id: number;
  /** URL-facing slug within the enclosing namespace — see {@link Page.slug}. */
  readonly slug: string;
  /** Human-readable page title. */
  readonly title: string;
}

/**
 * A file attached to a {@link Page} (feature #97 — "Attachments/file
 * upload support for wiki pages"). Mirrors
 * `migrations/0005_create_wiki_attachments.ts`'s `wiki_attachments` schema
 * 1:1. `storageName` is the randomized on-disk filename
 * `attachment-storage.ts`'s `generateStorageName()` assigned at upload
 * time — never derived from {@link filename}, which is display metadata
 * only (see that module's own docs for why the two must stay independent).
 */
export interface Attachment {
  /** Surrogate autoincrement primary key. */
  readonly id: number;
  /** The {@link Page.id} this attachment belongs to. */
  readonly pageId: number;
  /** Original, caller-supplied filename — display metadata only, never used to address the blob on disk. */
  readonly filename: string;
  /** The attachment's validated MIME type (`attachment-storage.ts`'s `ALLOWED_ATTACHMENT_CONTENT_TYPES`). */
  readonly contentType: string;
  /** Size of the stored file, in bytes. */
  readonly sizeBytes: number;
  /** The randomized on-disk filename under `WIKI_ATTACHMENTS_DIR` — never exposed to a client. */
  readonly storageName: string;
  /** The uploading caller's resolved user id, or `null` if unknown. */
  readonly uploadedBy: string | null;
  /** When this attachment was uploaded. */
  readonly createdAt: Date;
}

/**
 * A namespace node within the nested page-tree / navigation-sidebar
 * structure `page-tree.ts`'s `buildNamespaceTree` assembles (feature #91).
 * Mirrors one `wiki_namespaces` row plus every page directly inside it;
 * `children` holds every namespace whose `parent_id` is this node's `id`,
 * nested recursively to whatever depth the namespace hierarchy actually
 * has (feature #91 step 2 exercises a 3-level hierarchy, but nothing here
 * bounds the depth).
 */
export interface NamespaceTreeNode {
  /** The `wiki_namespaces.id` this node was built from. */
  readonly id: string;
  /** Human-readable namespace name. */
  readonly name: string;
  /** Optional namespace description, `null` when unset. */
  readonly description: string | null;
  /** Pages directly inside this namespace, sorted alphabetically by `slug`. */
  readonly pages: readonly PageTreeEntry[];
  /** Child namespaces, sorted alphabetically by `name`, each recursively built the same way. */
  readonly children: readonly NamespaceTreeNode[];
}
