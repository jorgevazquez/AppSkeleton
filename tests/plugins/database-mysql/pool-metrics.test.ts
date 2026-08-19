import { describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { collectPoolMetrics } from "../../../src/plugins/database-mysql/src/pool-metrics.js";

/**
 * A fake mysql2 `Pool` exposing just enough of its real internal shape
 * (`pool._allConnections`/`_freeConnections`/`_connectionQueue`, each a
 * `RingQueue`-like object with a `.length`) for `collectPoolMetrics()` to
 * read — see pool-metrics.ts's docs for why those three fields are what it
 * actually reads, and pool.test.ts's own `(pool as any).pool.config`
 * precedent for reaching into this same internal `.pool` field in tests.
 */
function fakePool(counts: { all?: number; free?: number; queued?: number }): Pool {
  const { all = 0, free = 0, queued = 0 } = counts;
  return {
    pool: {
      _allConnections: { length: all },
      _freeConnections: { length: free },
      _connectionQueue: { length: queued },
    },
  } as unknown as Pool;
}

describe("collectPoolMetrics (feature #30 — connection pool metrics)", () => {
  it("reports all-zero for a freshly-constructed, never-used pool", () => {
    const pool = fakePool({ all: 0, free: 0, queued: 0 });
    expect(collectPoolMetrics(pool)).toEqual({ active: 0, idle: 0, queued: 0 });
  });

  it("derives active as allConnections minus freeConnections when every open connection is idle", () => {
    const pool = fakePool({ all: 5, free: 5, queued: 0 });
    expect(collectPoolMetrics(pool)).toEqual({ active: 0, idle: 5, queued: 0 });
  });

  it("reflects a pool under concurrent load: every connection checked out, callers queued behind connectionLimit", () => {
    // Simulates the moment N concurrent queries exceed a pool's
    // connectionLimit: every open connection is checked out (0 free), and
    // the overflow callers are parked in the wait queue.
    const pool = fakePool({ all: 3, free: 0, queued: 4 });
    expect(collectPoolMetrics(pool)).toEqual({ active: 3, idle: 0, queued: 4 });
  });

  it("reflects a mixed pool: some connections busy, some idle, none queued", () => {
    const pool = fakePool({ all: 5, free: 2, queued: 0 });
    expect(collectPoolMetrics(pool)).toEqual({ active: 3, idle: 2, queued: 0 });
  });

  it("updates correctly across a simulated concurrent-query lifecycle: idle -> busy+queued -> drained back to idle", () => {
    // Same connectionLimit (3) sampled at three points in time, exactly the
    // shape a real burst of concurrent queries produces: quiescent before
    // load, saturated with overflow queued mid-burst, and back to quiescent
    // once every query has completed and every connection was released.
    const beforeLoad = fakePool({ all: 3, free: 3, queued: 0 });
    expect(collectPoolMetrics(beforeLoad)).toEqual({ active: 0, idle: 3, queued: 0 });

    const duringLoad = fakePool({ all: 3, free: 0, queued: 5 });
    expect(collectPoolMetrics(duringLoad)).toEqual({ active: 3, idle: 0, queued: 5 });

    const afterLoad = fakePool({ all: 3, free: 3, queued: 0 });
    expect(collectPoolMetrics(afterLoad)).toEqual({ active: 0, idle: 3, queued: 0 });
  });

  it("never returns a negative active count even if freeConnections somehow exceeds allConnections", () => {
    const pool = fakePool({ all: 1, free: 3, queued: 0 });
    expect(collectPoolMetrics(pool)).toEqual({ active: 0, idle: 3, queued: 0 });
  });

  it("reads 0 for any field whose internal queue is missing entirely, rather than throwing", () => {
    const pool = { pool: {} } as unknown as Pool;
    expect(collectPoolMetrics(pool)).toEqual({ active: 0, idle: 0, queued: 0 });
  });

  it("reads 0 rather than throwing when `.pool` itself is missing (a bare test double)", () => {
    const pool = {} as unknown as Pool;
    expect(collectPoolMetrics(pool)).toEqual({ active: 0, idle: 0, queued: 0 });
  });

  it("reads 0 for a field whose length is present but not a finite number, rather than throwing", () => {
    const pool = {
      pool: {
        _allConnections: { length: Number.NaN },
        _freeConnections: { length: "not-a-number" },
        _connectionQueue: undefined,
      },
    } as unknown as Pool;
    expect(collectPoolMetrics(pool)).toEqual({ active: 0, idle: 0, queued: 0 });
  });
});
