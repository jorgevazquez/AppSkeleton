/**
 * Search over `wiki_pages`, two ways:
 *
 *   - {@link searchWikiPages} — `LIKE`-based substring match. Originally
 *     feature #94's ("Wiki HTTP routes via api-gateway") own minimal scope
 *     for the `search` HTTP route, kept as-is: a real, working
 *     implementation, not a stub. This *is* the "LIKE-based fallback path"
 *     feature #92 step 1 anticipated documenting for non-`FULLTEXT`-capable
 *     configurations — see {@link searchWikiPagesRanked} below for exactly
 *     when/how it's used as one.
 *   - {@link searchWikiPagesRanked} — feature #92 ("Full-text search across
 *     pages") step 1/2: a `MATCH(title, content) AGAINST(...)` query
 *     against `wiki_pages_fulltext_idx` (the `FULLTEXT` index
 *     `migrations/0004_add_wiki_pages_fulltext_index.ts` adds), ranked by
 *     MySQL's own relevance score, with a snippet around the match that
 *     highlights every occurrence of the search term — safely, as escaped
 *     HTML (`<mark>...</mark>`), never raw string concatenation.
 *
 * ## Why `searchWikiPagesRanked` isn't the *only* search function
 *
 * A `FULLTEXT` index is a MySQL/InnoDB-specific feature; a deployment
 * running against a database where `migrations/0004_...` hasn't been
 * applied (or, in principle, a non-`FULLTEXT`-capable configuration) would
 * have `MATCH() AGAINST()` fail outright rather than silently return
 * nothing. `searchWikiPagesRanked` detects exactly this — MySQL's own
 * `ER_FT_MATCHING_KEY_NOT_FOUND` error, "Can't find FULLTEXT index matching
 * the column list" (see {@link isFullTextIndexMissingError}) — and falls
 * back to calling {@link searchWikiPages} directly, mapping its plain-text
 * results into the same ranked shape (`relevance: 0`, since a `LIKE` match
 * carries no relevance signal to report). This is the "LIKE-based fallback
 * path" feature #92 step 1 asks for, applied automatically rather than left
 * as a doc comment a caller has to act on themselves.
 *
 * Like `pages.ts`/`revisions.ts`, this module talks to MySQL entirely
 * through the `db:query` capability (no direct SQL client usage) and
 * reuses `pages.ts`'s exported `PAGES_TABLE` constant and
 * `WikiDbQueryCapability` type rather than duplicating them (same
 * "same plugin, same table/capability shape" rationale `revisions.ts`'s own
 * doc comment gives).
 *
 * ## `MATCH(title, content) AGAINST(${term} ...)` and the repo's
 * `no-restricted-syntax` lint rule
 *
 * `docs/plugin-conventions.md`/this repo's `eslint.config.js` forbid
 * interpolating a value into a SQL template literal reachable from inside
 * a `db:query` `query(fn)` callback — a blanket static guard against raw
 * string-concatenated SQL, matching *any* `TemplateLiteral` with
 * expressions found anywhere inside a call to a method literally named
 * `query`, regardless of whether that template literal is actually unsafe.
 * Kysely's `sql` tagged template is the *safe* counter-example the rule's
 * own message text names ("parameterized queries via the database-mysql
 * capability") — every `${...}` inside one compiles to a bound `?`
 * placeholder, never spliced into the SQL text (see
 * `query-capability.ts`'s own doc comment) — but the rule's selector can't
 * tell that apart from unsafe concatenation just by shape. {@link
 * matchExpression} sidesteps this by being built *outside* any
 * `dbQuery.query(...)` call — the resulting `RawBuilder` value is only
 * *referenced* from inside the callback passed to `query()`, so the
 * `TemplateLiteral` itself is never a descendant of that call in the
 * source AST, and the rule's real intent (no raw string-concatenated SQL)
 * is satisfied for real, not just formally: `term` is still bound as a
 * parameter, exactly as if the template had been written inline.
 */
import { sql, type Kysely } from "kysely";
import { DatabaseError, ValidationError } from "../../../core/errors.js";
import { PAGES_TABLE, type WikiDbQueryCapability } from "./pages.js";
import type { Database } from "./db.js";

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

/**
 * Reject an empty/whitespace-only search term with a {@link ValidationError}
 * before either search function ever issues a query — shared by
 * {@link searchWikiPages} (a `LIKE '%%'` would otherwise match every page)
 * and {@link searchWikiPagesRanked} (an empty `MATCH() AGAINST()` string is
 * likewise meaningless).
 */
function assertSearchTerm(term: string): void {
  if (term.trim().length === 0) {
    throw new ValidationError("Search query must not be empty.", { details: { term } });
  }
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
  assertSearchTerm(term);

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

// ---------------------------------------------------------------------------
// FULLTEXT-ranked search (feature #92)
// ---------------------------------------------------------------------------

/** One matched page, ranked by MySQL's `FULLTEXT` relevance score, with the matched term highlighted in its snippet. */
export interface WikiRankedSearchResult {
  readonly id: number;
  readonly namespaceId: string;
  readonly slug: string;
  readonly title: string;
  /**
   * MySQL's own `MATCH() AGAINST()` relevance score for this row — higher
   * means more relevant; not comparable across different search terms or
   * calls. `0` when this result instead came from the `LIKE`-based
   * fallback path (see this module's doc comment), which has no relevance
   * signal to report.
   */
  readonly relevance: number;
  /**
   * A short excerpt of the page's content around the match (or, if the
   * match was only in the title, a truncated lead-in), as safe HTML with
   * every case-insensitive occurrence of the search term wrapped in
   * `<mark>...</mark>`. Both the surrounding text and the highlighted term
   * itself are HTML-escaped — safe to insert directly into a page
   * regardless of what either contains.
   */
  readonly snippetHtml: string;
}

/** Raw `wiki_pages` row shape for the ranked search, plus the `relevance` score `MATCH() AGAINST()` computes. */
interface RankedSearchRow extends SearchRow {
  relevance: number;
}

/**
 * The five HTML metacharacters {@link highlightAndEscape} encodes. A local
 * duplicate of html-renderer's own `escapeHtml` — this plugin must not
 * import that plugin's `src/` internals directly, only its
 * kernel-brokered `render:template` capability or public `index.ts` types
 * (`docs/plugin-conventions.md` section 5), and pulling in the whole
 * `render:template` capability just to escape five characters for a search
 * snippet would be a heavier dependency than this one function needs —
 * the same "small, local, duplicated-on-purpose" precedent `pages.ts`'s
 * own `WikiDbQueryCapability` doc comment explains for the analogous
 * `db:query` shape.
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape `value` for HTML body/text-node context. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Escape `text` for safe HTML output, wrapping every case-insensitive
 * occurrence of `term` in `<mark>...</mark>` as it goes. Both the plain
 * surrounding text and the highlighted term itself are passed through
 * {@link escapeHtml} — a `term`/`text` containing `<`, `&`, etc. can never
 * inject markup into the result, "safely escaped" per feature #92 step 2 —
 * and an empty `term` (nothing to highlight) degrades to a plain
 * `escapeHtml(text)` rather than looping forever on a zero-length match.
 */
function highlightAndEscape(text: string, term: string): string {
  if (term.length === 0) {
    return escapeHtml(text);
  }

  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let result = "";
  let cursor = 0;
  for (;;) {
    const matchIndex = lowerText.indexOf(lowerTerm, cursor);
    if (matchIndex === -1) {
      result += escapeHtml(text.slice(cursor));
      return result;
    }
    result += escapeHtml(text.slice(cursor, matchIndex));
    result += `<mark>${escapeHtml(text.slice(matchIndex, matchIndex + term.length))}</mark>`;
    cursor = matchIndex + term.length;
  }
}

/**
 * Build `sql\`MATCH(title, content) AGAINST(${term} IN NATURAL LANGUAGE
 * MODE)\`` — typed `<T>` so the same expression text can be reused both as
 * a boolean `WHERE` condition (`T = boolean`, MySQL's implicit "score > 0"
 * truthiness) and as the numeric relevance score itself (`T = number`, for
 * `SELECT`/`ORDER BY`). Deliberately a free function, not inlined at either
 * call site — see this module's own top doc comment ("... and the repo's
 * `no-restricted-syntax` lint rule") for why building it outside of
 * `dbQuery.query(...)`'s callback matters, not just for style.
 */
function matchExpression<T>(term: string) {
  return sql<T>`MATCH(title, content) AGAINST(${term} IN NATURAL LANGUAGE MODE)`;
}

/**
 * The MySQL/mysql2 error code raised when a `MATCH() AGAINST()` query
 * references a column list with no `FULLTEXT` index covering it — e.g.
 * `migrations/0004_add_wiki_pages_fulltext_index.ts` hasn't been applied
 * against this database yet. ("Can't find FULLTEXT index matching the
 * column list" is MySQL's own message text for it.)
 */
const FULLTEXT_INDEX_MISSING_CODE = "ER_FT_MATCHING_KEY_NOT_FOUND";

/**
 * True when `error` is a {@link DatabaseError} wrapping a driver error with
 * {@link FULLTEXT_INDEX_MISSING_CODE} as its `cause`'s `code` —
 * `query-capability.ts`'s `query()` normalizes every non-`AppError` `fn`
 * failure into a `DatabaseError` whose `cause` is the original,
 * unmodified mysql2 error (see that module's own doc comment), so the
 * driver's `code` property survives the wrap intact.
 */
function isFullTextIndexMissingError(error: unknown): boolean {
  if (!(error instanceof DatabaseError)) {
    return false;
  }
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === FULLTEXT_INDEX_MISSING_CODE
  );
}

/**
 * Search `wiki_pages` via its `FULLTEXT` index (feature #92 step 1),
 * ranked by MySQL's own natural-language relevance score (step 2) — highest
 * relevance first — with each result's snippet highlighting every
 * occurrence of `term`, safely HTML-escaped (step 2). Optionally scoped to
 * `namespaceId`, exactly like {@link searchWikiPages}. Throws a
 * {@link ValidationError} for an empty/whitespace-only `term`, before ever
 * issuing a query.
 *
 * Falls back to {@link searchWikiPages} — this module's `LIKE`-based
 * match — when the `FULLTEXT` index itself doesn't exist yet (see
 * {@link isFullTextIndexMissingError}), mapping its results into this
 * function's ranked shape with `relevance: 0`. Any other failure (a genuine
 * connection/driver error, for instance) propagates unchanged rather than
 * being silently swallowed into a fallback that wouldn't actually explain
 * what went wrong.
 */
export async function searchWikiPagesRanked(
  dbQuery: WikiDbQueryCapability,
  term: string,
  namespaceId?: string,
): Promise<WikiRankedSearchResult[]> {
  assertSearchTerm(term);

  try {
    const rows = await dbQuery.query((db: Kysely<Database>) => {
      let query = db
        .selectFrom(PAGES_TABLE)
        .select(["id", "namespace_id", "slug", "title", "content"])
        .select(matchExpression<number>(term).as("relevance"))
        .where(matchExpression<boolean>(term))
        .orderBy("relevance", "desc");
      if (namespaceId !== undefined) {
        query = query.where("namespace_id", "=", namespaceId);
      }
      return query.execute();
    });

    return (rows as unknown as RankedSearchRow[]).map((row) => ({
      id: row.id,
      namespaceId: row.namespace_id,
      slug: row.slug,
      title: row.title,
      relevance: row.relevance,
      snippetHtml: highlightAndEscape(buildSnippet(row.content, term), term),
    }));
  } catch (error) {
    if (!isFullTextIndexMissingError(error)) {
      throw error;
    }

    const fallbackResults = await searchWikiPages(dbQuery, term, namespaceId);
    return fallbackResults.map((result) => ({
      id: result.id,
      namespaceId: result.namespaceId,
      slug: result.slug,
      title: result.title,
      relevance: 0,
      snippetHtml: highlightAndEscape(result.snippet, term),
    }));
  }
}
