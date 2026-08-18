/**
 * Unit tests for feature #69's shared pagination/filtering helpers
 * (`src/plugins/api-gateway/src/pagination.ts`).
 *
 * Two halves, matching the module's own two exported functions:
 *
 *   - `parseListQueryParams` (step 1): parsing/validation/sane-upper-bounds
 *     behavior, exercised directly against plain query objects — no HTTP,
 *     no database. `pagination-route.integration.test.ts` covers the same
 *     helper wired into a real fixture route over real HTTP (step 3).
 *   - `applyListQueryModifiers` (step 2): asserts the compiled SQL a
 *     `ParsedListQuery` produces, using the same "build a real
 *     `Kysely<Database>` instance over an unconnected mysql2 pool and only
 *     ever `.compile()`, never `.execute()`" pattern
 *     `database-mysql/db.test.ts` already established (compiling is pure
 *     string+params building; it never opens a TCP connection) — kept
 *     entirely in terms of the "kysely"/"mysql2" npm packages themselves,
 *     never importing `database-mysql`'s plugin-internal `db.ts`/`pool.ts`,
 *     per this module's own doc comment on why it stays a
 *     plugin-boundary-respecting, generically-typed helper.
 */
import { Kysely, MysqlDialect } from "kysely";
import mysql from "mysql2/promise";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import {
  applyListQueryModifiers,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  parseListQueryParams,
  type ParsedListQuery,
} from "../../../src/plugins/api-gateway/src/pagination.js";

describe("parseListQueryParams (feature #69, step 1)", () => {
  it("defaults page/limit/order when the query is empty", () => {
    const parsed = parseListQueryParams({});
    expect(parsed).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
      order: "asc",
      filters: {},
    });
  });

  it("parses custom page/limit and derives the correct offset", () => {
    const parsed = parseListQueryParams({ page: "3", limit: "10" });
    expect(parsed.page).toBe(3);
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(20); // (3 - 1) * 10
  });

  it.each([
    ["page", "0"],
    ["page", "-1"],
    ["page", "abc"],
    ["page", "1.5"],
    ["limit", "0"],
    ["limit", "-5"],
    ["limit", "xyz"],
  ])("rejects a non-positive-integer %s value (%s)", (field, value) => {
    expect(() => parseListQueryParams({ [field]: value })).toThrow(ValidationError);
  });

  it("rejects a limit above the default max page size", () => {
    expect(() => parseListQueryParams({ limit: String(MAX_PAGE_SIZE + 1) })).toThrow(
      ValidationError,
    );
  });

  it("accepts a limit right at the default max page size", () => {
    const parsed = parseListQueryParams({ limit: String(MAX_PAGE_SIZE) });
    expect(parsed.limit).toBe(MAX_PAGE_SIZE);
  });

  it("honors a caller-narrowed maxLimit even below the default ceiling", () => {
    expect(() => parseListQueryParams({ limit: "5" }, { maxLimit: 4 })).toThrow(ValidationError);
    expect(parseListQueryParams({ limit: "4" }, { maxLimit: 4 }).limit).toBe(4);
  });

  it("rejects a page above the default max page", () => {
    expect(() => parseListQueryParams({ page: String(MAX_PAGE + 1) })).toThrow(ValidationError);
  });

  it("honors a caller-narrowed maxPage even below the default ceiling", () => {
    expect(() => parseListQueryParams({ page: "11" }, { maxPage: 10 })).toThrow(ValidationError);
    expect(parseListQueryParams({ page: "10" }, { maxPage: 10 }).page).toBe(10);
  });

  it("uses a caller-supplied defaultLimit when limit is omitted", () => {
    expect(parseListQueryParams({}, { defaultLimit: 5 }).limit).toBe(5);
  });

  it("rejects an unrecognized sort field even when allowedSortFields is set", () => {
    expect(() =>
      parseListQueryParams({ sort: "password" }, { allowedSortFields: ["name", "createdAt"] }),
    ).toThrow(ValidationError);
  });

  it("rejects any sort field at all when allowedSortFields is omitted entirely", () => {
    expect(() => parseListQueryParams({ sort: "name" })).toThrow(ValidationError);
  });

  it("accepts an allow-listed sort field", () => {
    const parsed = parseListQueryParams({ sort: "name" }, { allowedSortFields: ["name"] });
    expect(parsed.sort).toBe("name");
  });

  it("omits `sort` from the result entirely when the query didn't supply one", () => {
    const parsed = parseListQueryParams({}, { allowedSortFields: ["name"] });
    expect(parsed.sort).toBeUndefined();
  });

  it("normalizes `order` case-insensitively", () => {
    expect(parseListQueryParams({ order: "DESC" }).order).toBe("desc");
    expect(parseListQueryParams({ order: "Asc" }).order).toBe("asc");
  });

  it("rejects an invalid order value", () => {
    expect(() => parseListQueryParams({ order: "sideways" })).toThrow(ValidationError);
  });

  it("extracts only allow-listed filter fields, ignoring everything else", () => {
    const parsed = parseListQueryParams(
      { status: "active", role: "admin", unrelated: "whatever" },
      { allowedFilterFields: ["status"] },
    );
    expect(parsed.filters).toEqual({ status: "active" });
  });

  it("returns an empty filters object when no filter fields matched (or none were allow-listed)", () => {
    expect(parseListQueryParams({ status: "active" }).filters).toEqual({});
  });
});

describe("applyListQueryModifiers (feature #69, step 2)", () => {
  // Same "compile a query without ever connecting" approach
  // database-mysql/db.test.ts uses (mysql2's createPool() never opens a TCP
  // connection eagerly, and Kysely's own .compile() is pure string/params
  // building) — kept self-contained to the "kysely"/"mysql2" npm packages
  // so this test never imports database-mysql's plugin-internal modules.
  interface FixtureDatabase {
    widgets: { id: number; name: string; status: string };
  }

  let pool: mysql.Pool | undefined;
  let db: Kysely<FixtureDatabase> | undefined;

  function freshDb(): Kysely<FixtureDatabase> {
    pool = mysql.createPool({
      host: "127.0.0.1",
      port: 3306,
      user: "appskeleton",
      password: "change-me",
      database: "appskeleton",
    });
    db = new Kysely<FixtureDatabase>({ dialect: new MysqlDialect({ pool: pool.pool }) });
    return db;
  }

  afterEach(async () => {
    if (db) {
      await db.destroy();
      db = undefined;
      pool = undefined;
      return;
    }
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  function baseParsed(overrides: Partial<ParsedListQuery> = {}): ParsedListQuery {
    return { page: 1, limit: 20, offset: 0, order: "asc", filters: {}, ...overrides };
  }

  it("applies limit and offset", () => {
    const qb = freshDb().selectFrom("widgets").selectAll();
    const compiled = applyListQueryModifiers(qb, baseParsed({ limit: 10, offset: 20 })).compile();
    expect(compiled.sql).toContain("limit ?");
    expect(compiled.sql).toContain("offset ?");
    expect(compiled.parameters).toEqual(expect.arrayContaining([10, 20]));
  });

  it("applies orderBy only when sort is present", () => {
    const qb = freshDb().selectFrom("widgets").selectAll();
    const withSort = applyListQueryModifiers(
      qb,
      baseParsed({ sort: "name", order: "desc" }),
    ).compile();
    expect(withSort.sql).toContain("order by `name` desc");

    const withoutSort = applyListQueryModifiers(
      freshDb().selectFrom("widgets").selectAll(),
      baseParsed(),
    ).compile();
    expect(withoutSort.sql).not.toContain("order by");
  });

  it("applies one where clause per filter entry, binding values as parameters", () => {
    const qb = freshDb().selectFrom("widgets").selectAll();
    const compiled = applyListQueryModifiers(
      qb,
      baseParsed({ filters: { status: "active" } }),
    ).compile();
    expect(compiled.sql).toContain("where `status` = ?");
    expect(compiled.parameters).toContain("active");
  });

  it("combines limit/offset/orderBy/where together", () => {
    const qb = freshDb().selectFrom("widgets").selectAll();
    const compiled = applyListQueryModifiers(
      qb,
      baseParsed({
        limit: 5,
        offset: 15,
        sort: "name",
        order: "asc",
        filters: { status: "active" },
      }),
    ).compile();
    expect(compiled.sql).toBe(
      "select * from `widgets` where `status` = ? order by `name` asc limit ? offset ?",
    );
    expect(compiled.parameters).toEqual(["active", 5, 15]);
  });

  it("returns the exact same query-builder shape it was handed, so a caller can keep chaining", () => {
    const qb = freshDb().selectFrom("widgets").select(["id", "name"]);
    const next = applyListQueryModifiers(qb, baseParsed());
    // Still a full SelectQueryBuilder — .where()/.compile()/etc. all still callable.
    const compiled = next.where("status", "=", "active").compile();
    expect(compiled.sql).toContain("select `id`, `name` from `widgets`");
  });
});
