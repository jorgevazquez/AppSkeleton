/**
 * Minimal `LIKE`-based search over `wiki_pages` — feature #94's ("Wiki HTTP
 * routes via api-gateway") own scope for the `search` HTTP route: a real,
 * working implementation to register today, since a MySQL `FULLTEXT` index
 * and relevance ranking (the full scope of the dedicated, not-yet-built
 * feature #92 — "Full-text search across pages") is a separate feature.
 * This module *is* the "LIKE-based fallback path" feature #92 step 1
 * anticipates documenting for non-`FULLTEXT`-capable configurations — #92
 * can add a `FULLTEXT`-backed path alongside this one later without this
 * route needing to change.
 *
 * Like `pages.ts`/`revisions.ts`, this module talks to MySQL entirely
 * through the `db:query` capability (no direct SQL client usage) and
 * reuses `pages.ts`'s exported `PAGES_TABLE` constant and
 * `WikiDbQueryCapability` type rather than duplicating them (same
 * "same plugin, same table/capability shape" rationale `revisions.ts`'s own
 * doc comment gives).
 */
import { ValidationError } from "../../../core/errors.js";
import { PAGES_TABLE, type WikiDbQueryCapability } from "./pages.js";

/** One matched page, with a short excerpt of `content` around the first match. */
export interface WikiSearchResult {
  readonly id: number;
  readonly namespaceId: string;
  readonly slug: string;
  readonly title: string;
  /** A short excerpt of the page's content around the first match, or a truncated lead-in if the match was only in the title. */
  readonly snippet: string;
}

/** Raw `wiki_pages` row shape this module selects — a narrower projection than `pages.ts`'s own `PageRow` (no timestamps, not needed for a search result). */
interface SearchRow {
  id: number;
  namespace_id: string;
  slug: string;
  title: string;
  content: string;
}

/** How many characters of context to include on each side of the first match when building a snippet. */
const SNIPPET_RADIUS = 60;
/** Snippet length used as a plain lead-in truncation when the search term isn't found in `content` itself (e.g. it only matched the title). */
const SNIPPET_FALLBACK_LENGTH = SNIPPET_RADIUS * 2;

/** Escape MySQL `LIKE` wildcard characters (`%`, `_`) and the escape character itself (`\`) in caller-supplied search text, so a term containing them is matched literally, never as a pattern. */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Build a short excerpt of `content` centered on the first case-insensitive occurrence of `term`, ellipsis-marked on whichever side was truncated. Falls back to a plain lead-in truncation if `term` doesn't actually occur in `content` (it may have matched only the title). */
function buildSnippet(content: string, term: string): string {
  const matchIndex = content.toLowerCase().indexOf(term.toLowerCase());
  if (matchIndex === -1) {
    return content.length <= SNIPPET_FALLBACK_LENGTH
      ? content
      : `${content.slice(0, SNIPPET_FALLBACK_LENGTH)}…`;
  }

  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(content.length, matchIndex + term.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

/**
 * Search `wiki_pages.title`/`wiki_pages.content` for `term` (case-
 * insensitive substring match), optionally scoped to `namespaceId`. Throws
 * a {@link ValidationError} for an empty/whitespace-only `term` — matching
 * `pages.ts`'s "validate before ever issuing a query" precedent — rather
 * than running a `LIKE '%%'` that would match every page.
 */
export async function searchWikiPages(
  dbQuery: WikiDbQueryCapability,
  term: string,
  namespaceId?: string,
): Promise<WikiSearchResult[]> {
  if (term.trim().length === 0) {
    throw new ValidationError("Search query must not be empty.", { details: { term } });
  }

  const pattern = `%${escapeLikePattern(term)}%`;

  const rows = await dbQuery.query((db) => {
    let query = db
      .selectFrom(PAGES_TABLE)
      .select(["id", "namespace_id", "slug", "title", "content"])
      .where((eb) => eb.or([eb("title", "like", pattern), eb("content", "like", pattern)]));
    if (namespaceId !== undefined) {
      query = query.where("namespace_id", "=", namespaceId);
    }
    return query.execute();
  });

  return (rows as unknown as SearchRow[]).map((row) => ({
    id: row.id,
    namespaceId: row.namespace_id,
    slug: row.slug,
    title: row.title,
    snippet: buildSnippet(row.content, term),
  }));
}
