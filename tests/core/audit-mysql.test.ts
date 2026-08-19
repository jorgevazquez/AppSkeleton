/**
 * Unit tests for `core/audit-mysql.ts`'s `createMySqlAuditSink` (feature
 * #29, step 2), against a lightweight in-memory fake standing in for a
 * `db:query`-capability-shaped object (`AuditLogDbQuery`) — mirrors
 * `migrator.test.ts`'s "fake Kysely-shaped object, no real MySQL" pattern
 * for unit-level coverage of query construction/filtering logic. Real
 * persistence against dockerized MySQL is covered separately by
 * `tests/core/audit-persistence.integration.test.ts` (feature #29 step 3).
 */
import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import {
  createMySqlAuditSink,
  type AuditLogDatabase,
  type AuditLogDbQuery,
} from "../../src/core/audit-mysql.js";
import type { AuditEvent } from "../../src/core/audit.js";

interface FakeRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  outcome: string;
  timestamp: number;
  details: string | null;
}

/** A minimal fake standing in for the `database_mysql_audit_log`-backed `Kysely<AuditLogDatabase>` chain this module actually calls. */
function createFakeDbQuery(): { dbQuery: AuditLogDbQuery; rows: FakeRow[] } {
  const rows: FakeRow[] = [];
  let nextId = 1;

  function selectBuilder(filtered: readonly FakeRow[]): {
    where(column: keyof FakeRow, op: "=" | ">=" | "<=", value: unknown): unknown;
    orderBy(column: keyof FakeRow, direction: "asc" | "desc"): { execute(): Promise<FakeRow[]> };
  } {
    return {
      where(column, op, value) {
        const next = filtered.filter((row) => {
          if (op === "=") return row[column] === value;
          if (op === ">=") return (row[column] as number) >= (value as number);
          return (row[column] as number) <= (value as number);
        });
        return selectBuilder(next);
      },
      orderBy(column, direction) {
        const sorted = [...filtered].sort((a, b) => {
          const diff = (a[column] as number) - (b[column] as number);
          return direction === "asc" ? diff : -diff;
        });
        return { execute: () => Promise.resolve(sorted) };
      },
    };
  }

  const dbQuery: AuditLogDbQuery = {
    async query<T>(fn: (db: Kysely<AuditLogDatabase>) => Promise<T>): Promise<T> {
      const fakeDb = {
        insertInto: (_table: string) => ({
          values: (row: Omit<FakeRow, "id">) => ({
            execute: async () => {
              rows.push({ id: nextId, ...row });
              nextId += 1;
            },
          }),
        }),
        selectFrom: (_table: string) => ({
          selectAll: () => selectBuilder(rows),
        }),
      };
      return fn(fakeDb as unknown as Kysely<AuditLogDatabase>);
    },
  };

  return { dbQuery, rows };
}

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    actor: "wiki",
    action: "capability:grant",
    target: "db:query",
    outcome: "granted",
    timestamp: 1000,
    ...overrides,
  };
}

describe("createMySqlAuditSink", () => {
  it("record() then flush() then query() round-trips a recorded event", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);

    sink.record(makeEvent());
    await sink.flush();

    expect(await sink.query()).toEqual([makeEvent()]);
  });

  it("record() is fire-and-forget: it returns before the write completes", async () => {
    const { dbQuery, rows } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);

    sink.record(makeEvent());
    // Synchronously, right after record() returns, the fake's underlying
    // `execute()` (a microtask) has not necessarily run yet — flush() is
    // what proves ordering, not record()'s own return.
    await sink.flush();
    expect(rows).toHaveLength(1);
  });

  it("all() returns every recorded event, insertion-ordered", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);

    sink.record(makeEvent({ actor: "a", timestamp: 1 }));
    sink.record(makeEvent({ actor: "b", timestamp: 2 }));
    await sink.flush();

    expect(await sink.all()).toEqual([
      makeEvent({ actor: "a", timestamp: 1 }),
      makeEvent({ actor: "b", timestamp: 2 }),
    ]);
  });

  it("preserves details as a round-tripped structured object", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);

    sink.record(makeEvent({ details: { reason: "not_declared" } }));
    await sink.flush();

    expect((await sink.query())[0]?.details).toEqual({ reason: "not_declared" });
  });

  it("an event with no details round-trips with no details field at all", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);

    sink.record(makeEvent());
    await sink.flush();

    expect((await sink.query())[0]).not.toHaveProperty("details");
  });

  it("query() filters by actor", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);
    sink.record(makeEvent({ actor: "wiki" }));
    sink.record(makeEvent({ actor: "rbac" }));
    await sink.flush();

    const results = await sink.query({ actor: "rbac" });
    expect(results).toHaveLength(1);
    expect(results[0]?.actor).toBe("rbac");
  });

  it("query() filters by action, target, and outcome", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);
    sink.record(
      makeEvent({ action: "capability:obtain", target: "http:route", outcome: "denied" }),
    );
    sink.record(makeEvent({ action: "capability:grant", target: "db:query", outcome: "granted" }));
    await sink.flush();

    expect(await sink.query({ action: "capability:obtain" })).toHaveLength(1);
    expect(await sink.query({ target: "http:route" })).toHaveLength(1);
    expect(await sink.query({ outcome: "denied" })).toHaveLength(1);
  });

  it("query() filters by since/until (inclusive) over timestamp", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);
    sink.record(makeEvent({ timestamp: 100 }));
    sink.record(makeEvent({ timestamp: 200 }));
    sink.record(makeEvent({ timestamp: 300 }));
    await sink.flush();

    expect(await sink.query({ since: 200 })).toHaveLength(2);
    expect(await sink.query({ until: 200 })).toHaveLength(2);
    expect(await sink.query({ since: 150, until: 250 })).toHaveLength(1);
  });

  it("query() combines multiple filters with AND semantics", async () => {
    const { dbQuery } = createFakeDbQuery();
    const sink = createMySqlAuditSink(dbQuery);
    sink.record(makeEvent({ actor: "wiki", outcome: "granted" }));
    sink.record(makeEvent({ actor: "wiki", outcome: "denied" }));
    sink.record(makeEvent({ actor: "rbac", outcome: "granted" }));
    await sink.flush();

    const results = await sink.query({ actor: "wiki", outcome: "granted" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ actor: "wiki", outcome: "granted" });
  });

  it("record() never throws, even when the underlying write rejects", async () => {
    const dbQuery: AuditLogDbQuery = {
      query: () => Promise.reject(new Error("connection reset")),
    };
    const sink = createMySqlAuditSink(dbQuery);

    expect(() => sink.record(makeEvent())).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it("calls options.onError (rather than throwing/rejecting) when a write fails", async () => {
    const failure = new Error("connection reset");
    const dbQuery: AuditLogDbQuery = {
      query: () => Promise.reject(failure),
    };
    const onError = vi.fn();
    const sink = createMySqlAuditSink(dbQuery, { onError });

    const event = makeEvent();
    sink.record(event);
    await sink.flush();

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, event);
  });

  it("flush() waits for every record() call issued so far, including ones still in flight", async () => {
    const rows: AuditEvent[] = [];
    let resolveFirstWrite: (() => void) | undefined;
    let calls = 0;
    const dbQuery: AuditLogDbQuery = {
      query: async (fn) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
          });
        }
        // Only the insert path is exercised by record(); a bare object
        // satisfying `.insertInto().values().execute()` is enough here.
        return fn({
          insertInto: () => ({
            values: (row: Record<string, unknown>) => ({
              execute: async () => {
                rows.push(row as unknown as AuditEvent);
              },
            }),
          }),
        } as unknown as Parameters<typeof fn>[0]);
      },
    };
    const sink = createMySqlAuditSink(dbQuery);

    sink.record(makeEvent({ actor: "first" }));
    sink.record(makeEvent({ actor: "second" }));

    let flushed = false;
    const flushPromise = sink.flush().then(() => {
      flushed = true;
    });

    // flush() must not resolve while the first write is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveFirstWrite?.();
    await flushPromise;

    expect(flushed).toBe(true);
    expect(rows).toHaveLength(2);
  });
});
