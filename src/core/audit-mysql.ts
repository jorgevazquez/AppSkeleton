/**
 * A MySQL-backed {@link AuditSink} (feature #29 — "Persist the kernel
 * audit trail into MySQL once the database plugin is available", step 2).
 *
 * {@link createMySqlAuditSink} builds a durable counterpart to `audit.ts`'s
 * `createInMemoryAuditSink()`: every {@link AuditEvent} is written to the
 * `database_mysql_audit_log` table (see
 * `plugins/database-mysql/src/migrations/0001_create_database_mysql_audit_log.ts`)
 * instead of (or, in this feature's actual bootstrap wiring, *after
 * replacing*) an in-process array.
 *
 * ## Why this lives in `core/`, not inside the `database-mysql` plugin
 *
 * This module only depends on {@link AuditSink}/{@link AuditEvent}/
 * {@link AuditQuery} (this package's own `audit.ts`) and a minimal,
 * locally-declared {@link AuditLogDbQuery} shape — structurally identical
 * to `database-mysql/src/query-capability.ts`'s real `DbQueryCapability`,
 * but not imported from it. That keeps `core/` — the kernel layer every
 * plugin (and this module) is allowed to depend on — from taking on a
 * *type* dependency on a specific plugin's internals, mirroring how
 * `server/index.ts` already reaches a plugin's capability structurally
 * (`isHttpRouteCapability`) rather than assuming its exact type. The
 * kernel bootstrap (`server/index.ts`) is what actually supplies a real
 * `DbQueryCapability` here (obtained the same way it already reaches
 * `api-gateway`'s `http:route` capability: reading `module.provides`
 * directly off the loaded `database-mysql` plugin — see that module's
 * "once database-mysql has loaded" wiring) — this module itself never
 * imports anything under `plugins/`.
 *
 * ## `record()` is fire-and-forget, by contract
 *
 * `AuditSink.record()` is synchronous (`(event: AuditEvent) => void`) and
 * "must never throw for a well-formed AuditEvent" (see `audit.ts`) — but
 * writing to MySQL is inherently asynchronous and can fail (a transient
 * connection drop, a pool exhaustion error, ...). `record()` therefore
 * kicks off the insert and returns immediately, without awaiting it;
 * any failure is caught and handed to `options.onError` (default: silently
 * dropped) rather than becoming an unhandled promise rejection or a thrown
 * error at the `record()` call site. This mirrors every other
 * fire-and-forget instrumentation hook in this codebase (e.g.
 * `query-metrics.ts`'s `createSlowQueryLogger`'s "never let an
 * instrumentation failure ... take down the real query it was observing"
 * — the same principle applies here in reverse: a real request/operation
 * must never fail *because* auditing it to MySQL failed).
 *
 * Every `record()` call's write is chained onto a private `pending`
 * promise so {@link MySqlAuditSink.flush} can await every write issued so
 * far (including ones still in flight) resolving or failing — used by
 * tests (and any caller, e.g. graceful shutdown) that need "every event
 * recorded up to this point is now durable" without polling.
 */
import type { Kysely } from "kysely";
import type { AuditEvent, AuditQuery, AuditSink } from "./audit.js";

/** This sink's backing table — must match the migration that creates it (see this module's docs). */
export const AUDIT_LOG_TABLE = "database_mysql_audit_log";

/**
 * The minimal, generic Kysely schema shape this module needs — mirrors
 * `database-mysql/src/db.ts`'s own `Database` interface structurally
 * (an index signature: table names are `string`, columns `unknown`)
 * without importing that plugin's module (see this file's "Why this lives
 * in core/" docs).
 */
export interface AuditLogDatabase {
  [table: string]: Record<string, unknown>;
}

/**
 * The minimal shape of a `db:query`-capability-like object this sink
 * needs: run a callback against a shared `Kysely` instance and return its
 * result. Structurally identical to
 * `database-mysql/src/query-capability.ts`'s real `DbQueryCapability`
 * (whose `query()` method this satisfies), but declared locally so this
 * module has no type dependency on that plugin.
 */
export interface AuditLogDbQuery {
  query<T>(fn: (db: Kysely<AuditLogDatabase>) => Promise<T>): Promise<T>;
}

/** A single row of {@link AUDIT_LOG_TABLE}, as MySQL returns it. */
interface AuditLogRow {
  readonly id: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  /** mysql2/Kysely may hand back a `BIGINT` column as either a `number` or a decimal string, depending on driver config — both are normalized in {@link rowToEvent}. */
  readonly timestamp: number | string;
  readonly details: string | null;
}

function rowToEvent(row: AuditLogRow): AuditEvent {
  const timestamp = typeof row.timestamp === "string" ? Number(row.timestamp) : row.timestamp;
  return {
    actor: row.actor,
    action: row.action,
    target: row.target,
    outcome: row.outcome,
    timestamp,
    ...(row.details !== null
      ? { details: JSON.parse(row.details) as Record<string, unknown> }
      : {}),
  };
}

/** A durable {@link AuditSink}, with an async, MySQL-backed counterpart to `InMemoryAuditSink`'s read-side `query()`/`all()`. */
export interface MySqlAuditSink extends AuditSink {
  /** All recorded entries matching every provided filter, ordered by insertion order (`id ASC`). */
  query(filter?: AuditQuery): Promise<readonly AuditEvent[]>;
  /** Every recorded entry, in insertion order. Equivalent to `query()`. */
  all(): Promise<readonly AuditEvent[]>;
  /** Resolve once every `record()` call issued so far has finished writing (or failing) — see this module's docs. */
  flush(): Promise<void>;
}

export interface CreateMySqlAuditSinkOptions {
  /** Called (never thrown) when a `record()` call's write fails — e.g. to log it. Defaults to a no-op. */
  onError?: (error: unknown, event: AuditEvent) => void;
}

/**
 * Build a {@link MySqlAuditSink} over `dbQuery` (a `db:query`-capability-
 * shaped object — see {@link AuditLogDbQuery}). Assumes
 * {@link AUDIT_LOG_TABLE} already exists (created by this plugin's own
 * migration before this sink is ever constructed — see the module doc's
 * "once database-mysql has loaded" wiring in `server/index.ts`).
 */
export function createMySqlAuditSink(
  dbQuery: AuditLogDbQuery,
  options: CreateMySqlAuditSinkOptions = {},
): MySqlAuditSink {
  let pending: Promise<void> = Promise.resolve();

  function record(event: AuditEvent): void {
    const write = dbQuery
      .query((db) =>
        db
          .insertInto(AUDIT_LOG_TABLE)
          .values({
            actor: event.actor,
            action: event.action,
            target: event.target,
            outcome: event.outcome,
            timestamp: event.timestamp,
            details: event.details !== undefined ? JSON.stringify(event.details) : null,
          })
          .execute(),
      )
      .then(() => undefined)
      .catch((cause: unknown) => {
        options.onError?.(cause, event);
      });
    // Chained (not run in parallel and separately tracked) so flush() only
    // ever needs to await one promise, regardless of how many record()
    // calls happened — and so writes settle in the same order record() was
    // called, matching InMemoryAuditSink's own insertion-ordered contract
    // as closely as an async sink can.
    pending = pending.then(() => write);
  }

  async function query(filter: AuditQuery = {}): Promise<readonly AuditEvent[]> {
    const rows = await dbQuery.query(async (db) => {
      let builder = db.selectFrom(AUDIT_LOG_TABLE).selectAll();
      if (filter.actor !== undefined) {
        builder = builder.where("actor", "=", filter.actor);
      }
      if (filter.action !== undefined) {
        builder = builder.where("action", "=", filter.action);
      }
      if (filter.target !== undefined) {
        builder = builder.where("target", "=", filter.target);
      }
      if (filter.outcome !== undefined) {
        builder = builder.where("outcome", "=", filter.outcome);
      }
      if (filter.since !== undefined) {
        builder = builder.where("timestamp", ">=", filter.since);
      }
      if (filter.until !== undefined) {
        builder = builder.where("timestamp", "<=", filter.until);
      }
      return builder.orderBy("id", "asc").execute();
    });
    return (rows as unknown as AuditLogRow[]).map(rowToEvent);
  }

  async function all(): Promise<readonly AuditEvent[]> {
    return query();
  }

  async function flush(): Promise<void> {
    await pending;
  }

  return Object.freeze({ record, query, all, flush });
}
