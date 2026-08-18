import { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { createDbPool } from "../../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../../src/plugins/database-mysql/src/db.js";

const BASE_CONFIG = {
  DB_HOST: "127.0.0.1",
  DB_PORT: 3306,
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: 5,
  DB_SSL: "disabled" as const,
  DB_SSL_REJECT_UNAUTHORIZED: true,
};

describe("createKyselyDb — pure construction over an existing mysql2 pool", () => {
  let pool: Pool | undefined;
  let db: Kysely<Database> | undefined;

  afterEach(async () => {
    // Destroying the Kysely instance ends the shared underlying mysql2 pool
    // (see db.ts's module docs) — do not also call pool.end(), which would
    // double-end the same pool.
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

  it("returns a real Kysely instance without connecting eagerly", () => {
    pool = createDbPool(BASE_CONFIG);
    db = createKyselyDb(pool);
    expect(db).toBeInstanceOf(Kysely);
  });

  it("exposes the standard Kysely query-builder surface (selectFrom/insertInto/updateTable/deleteFrom)", () => {
    pool = createDbPool(BASE_CONFIG);
    db = createKyselyDb(pool);
    expect(typeof db.selectFrom).toBe("function");
    expect(typeof db.insertInto).toBe("function");
    expect(typeof db.updateTable).toBe("function");
    expect(typeof db.deleteFrom).toBe("function");
  });

  it("building (but not executing) a query never opens a TCP connection", () => {
    pool = createDbPool(BASE_CONFIG);
    db = createKyselyDb(pool);
    // Compiling a query is pure/synchronous string+params building; it must
    // not throw or hang even though nothing in this test ever connects to a
    // real MySQL server.
    const compiled = db.selectFrom("scratch").selectAll().compile();
    expect(compiled.sql).toContain("select * from `scratch`");
  });

  it("accepts an optional `log` hook (feature #26) without altering the returned instance's shape", () => {
    pool = createDbPool(BASE_CONFIG);
    const log = () => undefined;
    db = createKyselyDb(pool, { log });
    expect(db).toBeInstanceOf(Kysely);
    // Wiring `log` must not itself open a connection either — same
    // construction-is-lazy guarantee as the no-options case above.
    const compiled = db.selectFrom("scratch").selectAll().compile();
    expect(compiled.sql).toContain("select * from `scratch`");
  });
});
