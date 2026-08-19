/**
 * Read-side data-access layer for `wiki_revisions` (feature #89 —
 * "Revision history: every edit creates a revision row"), step 2:
 * "Implement an endpoint/function to list revisions for a page in
 * reverse-chronological order."
 *
 * Every `wiki_revisions` row is written by exactly one place —
 * `pages.ts`'s `WikiPagesStore.updatePage`, which snapshots a page's
 * pre-update `title`/`content` here in the same transaction as the update
 * itself (step 1; see that method's own doc comment). This module is the
 * corresponding read side: it never inserts, only lists, mirroring the
 * same "one writer, structurally separate reader" split `pages.ts` itself
 * draws between `createPage`/`updatePage`/`deletePage` and
 * `getPageById`/`getPageBySlug`/`listPages`.
 *
 * Like `pages.ts`, this module talks to MySQL entirely through the
 * `db:query` capability (step 1's own "no direct SQL client usage"
 * precedent from feature #87 applies here too) and declares its own local
 * {@link WikiDbQueryCapability}-shaped dependency rather than importing
 * one — see `pages.ts`'s module doc comment for the full rationale. In
 * practice this module reuses `pages.ts`'s exported `WikiDbQueryCapability`
 * type and `REVISIONS_TABLE` constant directly, since they live in the same
 * plugin and describe the exact same table/capability shape; duplicating
 * them a second time here would just be two copies to keep in sync instead
 * of one.
 */
import type { Revision } from "./types.js";
import { REVISIONS_TABLE, type WikiDbQueryCapability } from "./pages.js";

/** Raw `wiki_revisions` row shape, before mapping to {@link Revision}. */
interface RevisionRow {
  id: number;
  page_id: number;
  title: string;
  content: string;
  created_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function revisionFromRow(row: RevisionRow): Revision {
  return {
    id: row.id,
    pageId: row.page_id,
    title: row.title,
    content: row.content,
    createdAt: toDate(row.created_at),
  };
}

/** The typed read surface {@link createWikiRevisionsStore} returns. */
export interface WikiRevisionsStore {
  /**
   * List every revision recorded for `pageId`, most-recently-superseded
   * edit first (feature #89 step 2's "reverse-chronological order").
   * Ordered by `id DESC` rather than `created_at DESC` — `id` is a
   * reliable, gap-free insertion-order tiebreaker even when two revisions
   * share a `created_at` timestamp (same rationale
   * `migrations/0003_create_wiki_revisions.ts`'s own doc comment gives for
   * the `wiki_revisions_page_id_idx` composite index this query uses).
   * Returns an empty array — never throws — for a page with no revisions
   * yet (a brand-new page that has never been edited) or an unknown
   * `pageId`.
   */
  listRevisions(pageId: number): Promise<Revision[]>;
}

/**
 * Build the wiki-revisions read-only data-access layer over an
 * already-obtained `db:query` capability handle.
 */
export function createWikiRevisionsStore(dbQuery: WikiDbQueryCapability): WikiRevisionsStore {
  return {
    async listRevisions(pageId) {
      const rows = await dbQuery.query((db) =>
        db
          .selectFrom(REVISIONS_TABLE)
          .selectAll()
          .where("page_id", "=", pageId)
          .orderBy("id", "desc")
          .execute(),
      );
      return (rows as unknown as RevisionRow[]).map(revisionFromRow);
    },
  };
}
