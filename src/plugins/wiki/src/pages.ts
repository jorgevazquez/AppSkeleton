/**
 * Persistent data-access layer for wiki pages (feature #87 — "Page CRUD via
 * the db:query capability").
 *
 * Step 1 ("Implement create/read/update/delete for wiki pages entirely
 * through db:query, no direct SQL client usage"): every method below issues
 * its own query through `dbQuery.query(fn)` — a Kysely query-builder
 * callback, never a raw SQL string or a direct `mysql2` call (see the
 * repo-wide `no-restricted-syntax` ESLint rule and `database-mysql/src/
 * query-capability.ts`'s own docs on why that's structurally impossible
 * through this capability's `query()` signature). This module holds no
 * connection/pool of its own, exactly like `rbac/src/store.ts` — the
 * pattern this module deliberately mirrors line-for-line where the two
 * plugins' concerns line up.
 *
 * ## Why `WikiDbQueryCapability` is a locally-declared interface
 *
 * This module must not import `database-mysql/src/query-capability.ts`
 * directly — `docs/plugin-conventions.md` section 5 forbids a plugin from
 * importing another plugin's internals, only a kernel-brokered capability
 * handle. {@link WikiDbQueryCapability} duplicates just the one method
 * shape this module actually calls (same rationale `rbac/src/store.ts`'s
 * own `RbacDbQueryCapability` doc comment gives). A real `DbQueryCapability`
 * instance satisfies this interface structurally with zero cast, since its
 * `query()` method's `Kysely<Database>` parameter uses the same generic
 * index-signature shape as this plugin's own `./db.js` `Database` type.
 *
 * ## Validated failure paths (step 2 + step 3)
 *
 * {@link WikiPagesStore.createPage} enforces two business-rule invariants
 * before ever reaching an insert, each surfaced as a {@link ValidationError}
 * so a caller never has to distinguish "this create request was invalid"
 * from a generic driver failure:
 *
 *   - **Slug format** (step 2): `input.slug` must satisfy `slug.ts`'s
 *     lowercase-kebab-case grammar — checked via {@link assertValidSlug}
 *     before any query runs at all.
 *   - **Namespace existence** (step 2): `input.namespaceId` must reference
 *     an existing `wiki_namespaces` row — checked via
 *     {@link assertNamespaceExists}, a `SELECT` against
 *     {@link NAMESPACES_TABLE}. This module never writes to
 *     `wiki_namespaces` itself (no namespace CRUD feature exists yet); it
 *     only ever reads it, to validate a page's foreign reference.
 *   - **Duplicate slug** (step 3's "duplicate-slug error path"): even
 *     though `wiki_pages_namespace_slug_uniq` (the migration's own unique
 *     index — see `migrations/0002_create_wiki_pages.ts`) would reject a
 *     collision at the database level, this module checks first via
 *     {@link WikiPagesStore.getPageBySlug} and throws a friendly
 *     {@link ValidationError} naming the conflicting slug/namespace — the
 *     same "read before insert to produce an actionable error, not a raw
 *     driver error" precedent `rbac/src/manage.ts`'s
 *     `assertRoleNameAvailable` sets for role-name uniqueness. The unique
 *     index remains the source of truth (a concurrent insert racing this
 *     check would still be rejected by MySQL, just surfaced as the
 *     `db:query` capability's own generic `DatabaseError` rather than this
 *     module's friendlier one) — this is defense in depth, not a
 *     replacement for the constraint.
 *
 * `getPageById`/`getPageBySlug` never throw on a missing page — they return
 * `undefined`, exactly like `rbac/src/store.ts`'s `getRole`/`getPermission`
 * — leaving "not found" as {@link NotFoundError} to
 * {@link WikiPagesStore.updatePage}/{@link WikiPagesStore.deletePage}, which
 * operate *on* a specific existing page and have no sensible no-op
 * behavior for a missing one (feature #87 step 3's "not-found error path").
 */
import type { Kysely } from "kysely";
import { NotFoundError, ValidationError } from "../../../core/errors.js";
import type { Database } from "./db.js";
import { parseSlug } from "./slug.js";
import type { CreatePageInput, Page, UpdatePageInput } from "./types.js";

/** Table names — the `wiki_` namespace this plugin's migrations create (feature #22's per-plugin convention). */
export const PAGES_TABLE = "wiki_pages";
export const NAMESPACES_TABLE = "wiki_namespaces";
/** See `revisions.ts` — re-exported/consumed from here too since {@link WikiPagesStore.updatePage} is the only writer. */
export const REVISIONS_TABLE = "wiki_revisions";

/**
 * Structural shape of the `db:query` capability this module needs — see
 * this file's module doc for why this is a local duplicate, not an import
 * of database-mysql's own `DbQueryCapability` type.
 */
export interface WikiDbQueryCapability {
  query<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T>;
}

/** Raw `wiki_pages` row shape, before mapping to {@link Page}. */
interface PageRow {
  id: number;
  namespace_id: string;
  slug: string;
  title: string;
  content: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Raw `wiki_namespaces` row shape — only `id` is ever read here. */
interface NamespaceIdRow {
  id: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function pageFromRow(row: PageRow): Page {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    slug: row.slug,
    title: row.title,
    content: row.content,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * Validate `slug` against `slug.ts`'s grammar (feature #87 step 2) and
 * return it unchanged. Throws the same {@link ValidationError}
 * `parseSlug` itself produces — unchanged, `error.details.input` still
 * carrying the offending value — on any grammar violation.
 */
function assertValidSlug(slug: unknown): string {
  const parsed = parseSlug(slug);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/** The typed CRUD surface {@link createWikiPagesStore} returns. */
export interface WikiPagesStore {
  /**
   * Create a new page. Validates `input.slug`'s grammar and
   * `input.namespaceId`'s existence first (feature #87 step 2), then
   * rejects a duplicate `(namespaceId, slug)` pair with a
   * {@link ValidationError} (feature #87 step 3) before ever inserting.
   * Returns the persisted page, including its assigned `id` and
   * server-assigned `createdAt`/`updatedAt` timestamps.
   */
  createPage(input: CreatePageInput): Promise<Page>;
  /** Look up a page by its surrogate id. Returns `undefined` if no such page exists — never throws. */
  getPageById(id: number): Promise<Page | undefined>;
  /** Look up a page by its URL-facing `(namespaceId, slug)` pair. Returns `undefined` if no such page exists — never throws. */
  getPageBySlug(namespaceId: string, slug: string): Promise<Page | undefined>;
  /** List every page, optionally filtered to one namespace. */
  listPages(namespaceId?: string): Promise<Page[]>;
  /**
   * Update an existing page's `title`/`content`. Throws a
   * {@link NotFoundError} (feature #87 step 3) if `id` does not reference an
   * existing page. Omitted fields are left unchanged; returns the updated
   * page.
   *
   * Feature #89 step 1 ("On every page update, snapshot the previous
   * content into wiki_revisions before applying the change"): when
   * `changes` actually changes something, the page's pre-update
   * `title`/`content` is inserted as a new `wiki_revisions` row in the same
   * database transaction as the update itself, so a revision row and its
   * corresponding page mutation are never observed independently — either
   * both land or (on any failure) neither does. A call with an empty
   * `changes` (every field omitted) writes no revision, since nothing was
   * actually superseded. See `revisions.ts`'s `listRevisions` for reading
   * these back in reverse-chronological order.
   */
  updatePage(id: number, changes: UpdatePageInput): Promise<Page>;
  /** Delete an existing page. Throws a {@link NotFoundError} (feature #87 step 3) if `id` does not reference an existing page. */
  deletePage(id: number): Promise<void>;
}

/**
 * Build the wiki-pages data-access layer over an already-obtained
 * `db:query` capability handle.
 */
export function createWikiPagesStore(dbQuery: WikiDbQueryCapability): WikiPagesStore {
  async function getPageById(id: number): Promise<Page | undefined> {
    const row = await dbQuery.query((db) =>
      db.selectFrom(PAGES_TABLE).selectAll().where("id", "=", id).executeTakeFirst(),
    );
    return row === undefined ? undefined : pageFromRow(row as unknown as PageRow);
  }

  async function getPageBySlug(namespaceId: string, slug: string): Promise<Page | undefined> {
    const row = await dbQuery.query((db) =>
      db
        .selectFrom(PAGES_TABLE)
        .selectAll()
        .where("namespace_id", "=", namespaceId)
        .where("slug", "=", slug)
        .executeTakeFirst(),
    );
    return row === undefined ? undefined : pageFromRow(row as unknown as PageRow);
  }

  async function listPages(namespaceId?: string): Promise<Page[]> {
    const rows = await dbQuery.query((db) => {
      let query = db.selectFrom(PAGES_TABLE).selectAll();
      if (namespaceId !== undefined) {
        query = query.where("namespace_id", "=", namespaceId);
      }
      return query.execute();
    });
    return (rows as unknown as PageRow[]).map(pageFromRow);
  }

  async function namespaceExists(namespaceId: string): Promise<boolean> {
    const row = await dbQuery.query((db) =>
      db.selectFrom(NAMESPACES_TABLE).select("id").where("id", "=", namespaceId).executeTakeFirst(),
    );
    return (row as unknown as NamespaceIdRow | undefined) !== undefined;
  }

  async function assertNamespaceExists(namespaceId: string): Promise<void> {
    if (!(await namespaceExists(namespaceId))) {
      throw new ValidationError(
        `Namespace "${namespaceId}" does not exist; a page cannot be created in it.`,
        { details: { namespaceId } },
      );
    }
  }

  async function requirePage(id: number): Promise<Page> {
    const page = await getPageById(id);
    if (!page) {
      throw new NotFoundError(`Page with id ${id} does not exist.`, { details: { id } });
    }
    return page;
  }

  return {
    async createPage(input) {
      const slug = assertValidSlug(input.slug);
      await assertNamespaceExists(input.namespaceId);

      const existing = await getPageBySlug(input.namespaceId, slug);
      if (existing) {
        throw new ValidationError(
          `A page with slug "${slug}" already exists in namespace "${input.namespaceId}".`,
          { details: { namespaceId: input.namespaceId, slug } },
        );
      }

      const insertResult = await dbQuery.query((db) =>
        db
          .insertInto(PAGES_TABLE)
          .values({
            namespace_id: input.namespaceId,
            slug,
            title: input.title,
            content: input.content,
          })
          .executeTakeFirstOrThrow(),
      );

      const id = Number(insertResult.insertId);
      const created = await getPageById(id);
      if (!created) {
        // Unreachable in practice — the row was just inserted successfully
        // above — but keeps this function's return type honest rather than
        // asserting past a theoretically-possible `undefined`.
        throw new NotFoundError(`Page with id ${id} could not be read back after creation.`, {
          details: { id },
        });
      }
      return created;
    },

    getPageById,
    getPageBySlug,
    listPages,

    async updatePage(id, changes) {
      const before = await requirePage(id);

      const updates: Record<string, unknown> = {};
      if (changes.title !== undefined) {
        updates["title"] = changes.title;
      }
      if (changes.content !== undefined) {
        updates["content"] = changes.content;
      }

      if (Object.keys(updates).length > 0) {
        // Feature #89 step 1: snapshot `before`'s title/content into
        // wiki_revisions and apply the update in the same transaction, so
        // the two writes are atomic — a failure partway through leaves
        // neither the revision row nor the update visible (Kysely rolls
        // the whole `fn` back on rejection; see
        // `transaction-capability.ts`'s doc comment for the same
        // commit/rollback contract this plugin's own `db:query`-obtained
        // `Kysely<Database>` handle gives for free via `.transaction()`).
        await dbQuery.query((db) =>
          db.transaction().execute(async (trx) => {
            await trx
              .insertInto(REVISIONS_TABLE)
              .values({
                page_id: id,
                title: before.title,
                content: before.content,
              })
              .execute();

            await trx.updateTable(PAGES_TABLE).set(updates).where("id", "=", id).execute();
          }),
        );
      }

      return requirePage(id);
    },

    async deletePage(id) {
      await requirePage(id);
      await dbQuery.query((db) => db.deleteFrom(PAGES_TABLE).where("id", "=", id).execute());
    },
  };
}
