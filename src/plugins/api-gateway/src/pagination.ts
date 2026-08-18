/**
 * Shared pagination/filtering helpers for list endpoints (feature #69 —
 * "Pagination and filtering helpers for list endpoints").
 *
 * spec.md lists "pagination/filtering helpers" as one of the things the
 * api-gateway plugin itself "Provides" (see spec.md's api-gateway section,
 * alongside request validation, consistent error envelopes, rate limiting,
 * ...) — this module is that helper, meant to be reused by every list-shaped
 * route registered through `registerRoute()` (feature #59,
 * `./route-capability.ts`) rather than each route hand-rolling its own
 * `?page=`/`?limit=` parsing and slicing.
 *
 * Two independent halves, matching this feature's two steps:
 *
 *   1. {@link parseListQueryParams} — turns a route handler's raw
 *      `request.query` object into a validated, normalized
 *      {@link ParsedListQuery}, throwing a {@link ValidationError} (this
 *      codebase's AppError taxonomy, see `core/errors.ts`) for anything
 *      malformed or outside the configured sane bounds (a non-numeric
 *      page/limit, a limit above the configured ceiling, a page beyond the
 *      configured max, or a sort field the route didn't explicitly
 *      allow-list).
 *   2. {@link applyListQueryModifiers} — takes that already-validated
 *      {@link ParsedListQuery} and applies it to a Kysely
 *      `SelectQueryBuilder` (`.limit()`/`.offset()`/`.orderBy()`/`.where()`),
 *      so a plugin's own data-access layer (its own `db:query`-backed store,
 *      mirroring `rbac/src/store.ts`'s shape) gets back the exact same
 *      builder type it handed in, just with pagination/sort/filter clauses
 *      already applied.
 *
 * ## Why this lives in api-gateway, not core/
 *
 * spec.md explicitly scopes "pagination/filtering helpers" to the
 * api-gateway plugin's own feature list — this is HTTP-request-shaped
 * plumbing (querystring parsing, JSON-schema-friendly param names), not a
 * kernel-wide concern like `core/errors.ts`'s AppError taxonomy or
 * `core/types.ts`'s Result type. {@link applyListQueryModifiers} only
 * depends on the "kysely" npm package's own public `SelectQueryBuilder`
 * type — never on `database-mysql`'s plugin-internal `Database` type — so
 * this module stays usable by any plugin's own store, exactly like
 * `rbac/src/store.ts` declares its own local `RbacDbQueryCapability` rather
 * than importing `database-mysql`'s internals directly (see
 * `docs/plugin-conventions.md` section 5, and that module's own doc comment
 * for the precedent this mirrors).
 *
 * ## Why `sort`/filter fields require an explicit allow-list
 *
 * `parsed.sort` and `parsed.filters`' keys end up passed straight into
 * Kysely's `.orderBy(column, ...)`/`.where(column, "=", ...)` as *column
 * references*, not bound values — unlike a filter's *value*, which Kysely
 * always binds as a parameter (see `database-mysql`'s
 * `query-capability.ts` module docs on parameterization), a column name is
 * part of the compiled SQL text itself. A caller-supplied field name that
 * was never checked against a route-specific allow-list would let an API
 * caller reference (or probe for) an arbitrary column, so this module
 * refuses to guess: a `sort` query param is only ever honored when
 * `options.allowedSortFields` includes it (throwing {@link ValidationError}
 * otherwise — including when the option itself was omitted entirely), and a
 * filter param is only extracted into `parsed.filters` when its name is
 * listed in `options.allowedFilterFields` — every other query param is left
 * alone, exactly like an unrecognized/unused querystring param anywhere
 * else in this codebase's routes.
 */
import type { SelectQueryBuilder } from "kysely";
import { ValidationError } from "../../../core/errors.js";

/** Default page number when `page` is omitted from the query. */
export const DEFAULT_PAGE = 1;

/** Default page size when `limit` is omitted from the query. */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard ceiling on `limit` ("sane upper bounds", step 1) unless a caller narrows it further via `options.maxLimit`. */
export const MAX_PAGE_SIZE = 100;

/** Hard ceiling on `page` — guards against a caller requesting an absurdly deep offset (e.g. `page=99999999999`). */
export const MAX_PAGE = 100_000;

/** Sort directions {@link parseListQueryParams} accepts for the `order` param, case-insensitively. */
export const SORT_ORDERS = ["asc", "desc"] as const;

export type SortOrder = (typeof SORT_ORDERS)[number];

/** Options narrowing/enabling {@link parseListQueryParams}'s validation for a specific route. */
export interface ParseListQueryOptions {
  /** Overrides {@link DEFAULT_PAGE_SIZE}. */
  readonly defaultLimit?: number;
  /** Overrides {@link MAX_PAGE_SIZE} — the effective ceiling `limit` is validated against. */
  readonly maxLimit?: number;
  /** Overrides {@link MAX_PAGE} — the effective ceiling `page` is validated against. */
  readonly maxPage?: number;
  /**
   * Column/field names a `sort` query param is allowed to reference. A
   * `sort` param present in the query but not in this list — or this
   * option omitted entirely while `sort` is present — throws
   * {@link ValidationError}. See this module's doc comment.
   */
  readonly allowedSortFields?: readonly string[];
  /**
   * Field names {@link ParsedListQuery.filters} may contain. Any query
   * param whose name matches one of these is extracted into `filters`;
   * every other query param (the pagination/sort params aside) is left
   * untouched. See this module's doc comment.
   */
  readonly allowedFilterFields?: readonly string[];
}

/** The validated, normalized result of {@link parseListQueryParams}. */
export interface ParsedListQuery {
  /** 1-based page number — a positive integer, already validated to be <= the effective max. */
  readonly page: number;
  /** Page size — a positive integer, already validated to be <= the effective max. */
  readonly limit: number;
  /** Row offset derived from `page`/`limit` (`(page - 1) * limit`) — ready to hand straight to `.offset()`. */
  readonly offset: number;
  /** The validated sort field. Present only when the query supplied one and it passed the allow-list check. */
  readonly sort?: string;
  /** Sort direction. Always present (defaults to `"asc"`); only meaningful when `sort` is also present. */
  readonly order: SortOrder;
  /** Recognized filter field/value pairs — see `options.allowedFilterFields`. Always present, possibly empty. */
  readonly filters: Readonly<Record<string, string>>;
}

/**
 * The raw query-string shape {@link parseListQueryParams} reads from —
 * every value is `unknown` since it comes straight off `request.query`,
 * whatever shape the route's querystring schema/parser produced (a plain
 * string for a single value, an array for a repeated key, or `undefined`
 * for an absent one).
 */
export type RawListQuery = Readonly<Record<string, unknown>>;

/** Narrow an arbitrary query-string value down to a single string, or `undefined` if absent/not string-shaped. */
function firstValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/** Parse `raw` as a positive (>= 1) integer, throwing a {@link ValidationError} labeled with `field` on any failure. */
function parsePositiveInteger(raw: string, field: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new ValidationError(
      `Invalid list query parameter "${field}": expected a positive integer, got "${raw}".`,
      { details: { field, value: raw } },
    );
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(
      `Invalid list query parameter "${field}": expected a positive integer, got "${raw}".`,
      { details: { field, value: raw } },
    );
  }
  return value;
}

/**
 * Parse and validate `page`/`limit`/`sort`/`order` (plus any allow-listed
 * filter fields) off a route's raw `request.query` object (step 1). Throws
 * {@link ValidationError} for a malformed value or one outside the
 * configured sane bounds — never silently clamps, so a caller always knows
 * exactly why a request was rejected (mirrors `route-capability.ts`'s own
 * "throw ValidationError, don't guess" precedent).
 *
 * A page number beyond the *data's* own last page (as opposed to beyond
 * `options.maxPage`) is not an error here — it is a perfectly well-formed
 * request that simply has no rows to return; {@link applyListQueryModifiers}
 * still applies the resulting `.limit()`/`.offset()`, and the query
 * naturally comes back empty. See `pagination.test.ts` /
 * `pagination-route.integration.test.ts` for both cases exercised.
 */
export function parseListQueryParams(
  query: RawListQuery,
  options: ParseListQueryOptions = {},
): ParsedListQuery {
  const maxLimit = options.maxLimit ?? MAX_PAGE_SIZE;
  const maxPage = options.maxPage ?? MAX_PAGE;

  const rawPage = firstValue(query.page);
  const page = rawPage === undefined ? DEFAULT_PAGE : parsePositiveInteger(rawPage, "page");
  if (page > maxPage) {
    throw new ValidationError(
      `Invalid list query parameter "page": ${page} exceeds the maximum of ${maxPage}.`,
      { details: { field: "page", value: page, max: maxPage } },
    );
  }

  const rawLimit = firstValue(query.limit);
  const limit =
    rawLimit === undefined
      ? (options.defaultLimit ?? DEFAULT_PAGE_SIZE)
      : parsePositiveInteger(rawLimit, "limit");
  if (limit > maxLimit) {
    throw new ValidationError(
      `Invalid list query parameter "limit": ${limit} exceeds the maximum of ${maxLimit}.`,
      { details: { field: "limit", value: limit, max: maxLimit } },
    );
  }

  const rawSort = firstValue(query.sort);
  let sort: string | undefined;
  if (rawSort !== undefined) {
    if (!(options.allowedSortFields ?? []).includes(rawSort)) {
      throw new ValidationError(
        `Invalid list query parameter "sort": "${rawSort}" is not a sortable field for this endpoint.`,
        { details: { field: "sort", value: rawSort, allowed: options.allowedSortFields ?? [] } },
      );
    }
    sort = rawSort;
  }

  const rawOrder = firstValue(query.order);
  let order: SortOrder = "asc";
  if (rawOrder !== undefined) {
    const normalized = rawOrder.toLowerCase();
    if (!(SORT_ORDERS as readonly string[]).includes(normalized)) {
      throw new ValidationError(
        `Invalid list query parameter "order": expected one of ${SORT_ORDERS.join(", ")}, got "${rawOrder}".`,
        { details: { field: "order", value: rawOrder } },
      );
    }
    order = normalized as SortOrder;
  }

  const filters: Record<string, string> = {};
  for (const field of options.allowedFilterFields ?? []) {
    const rawValue = firstValue(query[field]);
    if (rawValue !== undefined) {
      filters[field] = rawValue;
    }
  }

  return {
    page,
    limit,
    offset: (page - 1) * limit,
    ...(sort !== undefined ? { sort } : {}),
    order,
    filters,
  };
}

/**
 * Apply an already-validated {@link ParsedListQuery} to a Kysely
 * `SelectQueryBuilder` (step 2): `.limit()`/`.offset()` always, `.orderBy()`
 * when `parsed.sort` is present, and one `.where(field, "=", value)` per
 * entry in `parsed.filters`. Returns the same `SelectQueryBuilder<DB, TB,
 * O>` shape it was handed — Kysely's own `.limit()`/`.offset()`/
 * `.orderBy()`/`.where()` all preserve `DB`/`TB`/`O`, so this is a drop-in
 * addition to a plugin's own query-building chain, not a replacement for
 * it (a caller still calls `.selectFrom()`/`.select()`/`.execute()` itself
 * — see `pagination.test.ts` for a worked example against a plain
 * `Kysely<Database>` instance, mirroring `database-mysql/db.test.ts`'s
 * "compile a query without connecting" pattern).
 *
 * `parsed.sort`/`parsed.filters`' keys are passed as column references with
 * a type-erasing cast — see this module's doc comment on why that is safe
 * *only* because {@link parseListQueryParams} already checked every one of
 * them against a route-specific allow-list before this function ever sees
 * them; this function performs no allow-list check of its own and must
 * never be called with an unvalidated `ParsedListQuery`.
 */
export function applyListQueryModifiers<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  parsed: ParsedListQuery,
): SelectQueryBuilder<DB, TB, O> {
  let next = qb.limit(parsed.limit).offset(parsed.offset);

  if (parsed.sort !== undefined) {
    // `sort` is a caller-supplied, allow-list-checked column *reference* —
    // see this function's doc comment — so it can't stay generically typed here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    next = next.orderBy(parsed.sort as any, parsed.order);
  }

  for (const [field, value] of Object.entries(parsed.filters)) {
    // Same allow-list guarantee as `sort` above.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    next = next.where(field as any, "=", value);
  }

  return next;
}
