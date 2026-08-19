/**
 * Creates `database_mysql_audit_log` (feature #29, step 1 — "Add an
 * audit_log migration under the database-mysql namespace convention").
 *
 * This table is the persistent backing store for `core/audit-mysql.ts`'s
 * {@link import("../audit-sink.js").createMySqlAuditSink} — the durable
 * counterpart to `core/audit.ts`'s in-memory `AuditSink` (feature #11).
 * Column shape mirrors `AuditEvent` (audit.ts) one-for-one:
 *
 *   - `id`        — surrogate autoincrement PK. Not part of `AuditEvent`
 *                    itself; exists purely so a read can request a stable
 *                    insertion order (`ORDER BY id ASC`), matching
 *                    `InMemoryAuditSink`'s own "insertion-ordered event
 *                    log" contract, without relying on `timestamp` (which
 *                    two events recorded in the same millisecond could
 *                    tie on).
 *   - `actor`/`action`/`target`/`outcome` — `AuditEvent`'s four required,
 *                    free-form-string fields, stored verbatim.
 *   - `timestamp`  — `AuditEvent.timestamp` (epoch milliseconds), stored as
 *                    a `BIGINT` rather than a `TIMESTAMP`/`DATETIME`
 *                    column: the producer stamps this value itself (see
 *                    audit.ts's docs — "the producer stamps this, not the
 *                    sink"), so it must round-trip as the exact integer a
 *                    producer supplied (including a fixed value a test
 *                    might inject), not be reinterpreted through MySQL's
 *                    own timezone/precision rules.
 *   - `details`    — `AuditEvent.details` (optional structured context),
 *                    stored as a JSON-encoded `TEXT` column, `NULL` when
 *                    the event carried no `details` at all (distinct from
 *                    an empty object).
 *
 * Indexed on `actor`, `action`, `target`, `outcome`, and `timestamp`
 * individually — `AuditQuery`'s filter fields (audit.ts) are always ANDed
 * together and queried independently of one another (no fixed access
 * pattern to optimize a composite index for), so single-column indexes
 * keep every one of those lookups sargable without over-fitting a
 * particular filter combination.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db.js";

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable("database_mysql_audit_log")
    .addColumn("id", "integer", (col) => col.autoIncrement().primaryKey())
    .addColumn("actor", "varchar(255)", (col) => col.notNull())
    .addColumn("action", "varchar(255)", (col) => col.notNull())
    .addColumn("target", "varchar(255)", (col) => col.notNull())
    .addColumn("outcome", "varchar(255)", (col) => col.notNull())
    .addColumn("timestamp", "bigint", (col) => col.notNull())
    .addColumn("details", "text")
    .execute();

  await db.schema
    .createIndex("database_mysql_audit_log_actor_idx")
    .on("database_mysql_audit_log")
    .column("actor")
    .execute();
  await db.schema
    .createIndex("database_mysql_audit_log_action_idx")
    .on("database_mysql_audit_log")
    .column("action")
    .execute();
  await db.schema
    .createIndex("database_mysql_audit_log_target_idx")
    .on("database_mysql_audit_log")
    .column("target")
    .execute();
  await db.schema
    .createIndex("database_mysql_audit_log_outcome_idx")
    .on("database_mysql_audit_log")
    .column("outcome")
    .execute();
  await db.schema
    .createIndex("database_mysql_audit_log_timestamp_idx")
    .on("database_mysql_audit_log")
    .column("timestamp")
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable("database_mysql_audit_log").execute();
}
