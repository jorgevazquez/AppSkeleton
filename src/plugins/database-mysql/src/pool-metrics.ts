/**
 * Connection pool metrics collection for the database-mysql plugin (feature
 * #30 — "Expose connection pool metrics (active/idle/queued) via kernel
 * introspection").
 *
 * mysql2 does not expose active/idle/queued connection counts through any
 * public, documented API (see `mysql2/typings/mysql/lib/Pool.d.ts`) — the
 * only place those numbers live is the callback-based `Pool` instance every
 * `mysql2/promise` `Pool` wraps at its own `.pool` field (a documented,
 * public field — `promise.d.ts`'s `interface Pool { ...; pool: CorePool }` —
 * already relied on the same way by pool.test.ts's `poolConnectionConfig()`/
 * `poolConnectionLimit()` helpers for introspection-only assertions), as
 * three `RingQueue` instances (see `mysql2/lib/ring_queue.js`) it maintains
 * internally as connections are acquired/released/queued (see
 * `mysql2/lib/base/pool.js`'s `getConnection()`/`releaseConnection()`):
 *
 *   - `_allConnections`  — every connection the pool has opened and not yet
 *     destroyed, whether currently checked out or sitting idle.
 *   - `_freeConnections` — the subset of `_allConnections` currently checked
 *     back in and available for immediate reuse ("idle").
 *   - `_connectionQueue` — callers whose `getConnection()` call is waiting
 *     because every connection is checked out and the pool is already at
 *     `connectionLimit` ("queued").
 *
 * `active` is derived as `_allConnections.length - _freeConnections.length`
 * rather than tracked as a fourth counter of our own, so it can never drift
 * out of sync with the two numbers mysql2 itself already maintains — the
 * moment `getConnection()` hands a connection out, mysql2's own
 * `_getConnection()` has already popped it off `_freeConnections` (or, for a
 * freshly-created connection, never added it there in the first place).
 *
 * These three fields are underscore-prefixed (private by convention, not by
 * the type system) and not part of mysql2's versioned public API. {@link
 * collectPoolMetrics} therefore reads them defensively: anything missing or
 * not the expected shape reads as `0` rather than throwing, so a future
 * mysql2 upgrade that renames/restructures this internal state degrades this
 * feature to an all-zero snapshot instead of crashing kernel introspection.
 */
import type { Pool } from "mysql2/promise";

/** A connection pool's point-in-time active/idle/queued counts — see this module's docs. */
export interface PoolMetricsSnapshot {
  /** Connections currently checked out of the pool and in use. */
  readonly active: number;
  /** Connections currently checked back in, idle, and available for immediate reuse. */
  readonly idle: number;
  /** Pending `getConnection()` callers waiting because the pool is already at `connectionLimit`. */
  readonly queued: number;
}

/** The one thing this module reads off a `RingQueue` (see `mysql2/lib/ring_queue.js`) — its length. */
interface RingQueueLike {
  readonly length: number;
}

/** The private internal fields of mysql2's callback-based `Pool` (`mysql2/lib/base/pool.js`'s `BasePool`) this module reads — see this module's docs for why they're accessed defensively. */
interface CorePoolInternals {
  readonly _allConnections?: RingQueueLike;
  readonly _freeConnections?: RingQueueLike;
  readonly _connectionQueue?: RingQueueLike;
}

/** `queue.length` if `queue` is present and genuinely numeric, else `0` — never throws, never returns a negative count. */
function safeLength(queue: RingQueueLike | undefined): number {
  return typeof queue?.length === "number" && Number.isFinite(queue.length)
    ? Math.max(0, queue.length)
    : 0;
}

/**
 * Read the current active/idle/queued snapshot straight off `pool`'s live
 * internal state — a synchronous, zero-I/O read of already-accumulated
 * mysql2 bookkeeping (no query is ever run, no connection is ever acquired),
 * so it always reflects exactly what mysql2 itself currently believes about
 * the pool at the moment this is called. Never throws — see this module's
 * docs on defensive access; a `pool` lacking the expected internal shape
 * (e.g. a hand-built test double) simply reads as an all-zero snapshot.
 */
export function collectPoolMetrics(pool: Pool): PoolMetricsSnapshot {
  const internals = pool.pool as unknown as CorePoolInternals | undefined;
  const total = safeLength(internals?._allConnections);
  const idle = safeLength(internals?._freeConnections);
  const queued = safeLength(internals?._connectionQueue);
  return { active: Math.max(0, total - idle), idle, queued };
}
