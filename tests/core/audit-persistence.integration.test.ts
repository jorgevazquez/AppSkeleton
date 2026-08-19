/**
 * Integration test for feature #29 ("Persist the kernel audit trail into
 * MySQL once the database plugin is available"), step 3: "audit events
 * recorded during a session are queryable from the database after
 * restart."
 *
 * ## Why this lives in tests/core, not tests/plugins/database-mysql
 *
 * Proving this needs the *real* kernel bootstrap
 * (`server/index.ts`'s `bootstrapKernel()`) wiring the real
 * `database-mysql` plugin's real `db:query` capability into the real,
 * swappable `kernel.auditSink` — genuinely cross-cutting, kernel-level
 * behavior, not something one plugin's own test directory can express
 * under `docs/plugin-conventions.md` section 5's rule (mirrors
 * `tests/core/kernel.integration.test.ts`'s and
 * `tests/core/rbac-persistence.integration.test.ts`'s own "kernel-
 * integration tests" carve-out).
 *
 * ## "Session" and "restart"
 *
 * A "session" is simulated as: boot a real kernel (`bootstrapKernel()`
 * against the real `src/plugins` tree with real `DB_*` credentials),
 * confirm the swap to a MySQL-backed audit sink actually happened, then
 * record one audit event through `kernel.auditSink` — exactly the handle
 * every plugin's `PluginLifecycleContext.auditSink` and the capability
 * broker itself already hold (see `core/audit.ts`'s `SwitchableAuditSink`
 * docs).
 *
 * There's no real process restart inside a vitest run — per the same
 * technique `tests/core/rbac-persistence.integration.test.ts` already
 * uses, "restart" means disabling `database-mysql` (which runs its real
 * `onDisable`, destroying the `Kysely` instance and, with it, the
 * underlying mysql2 pool — see `plugins/database-mysql/index.ts`'s docs)
 * and then reading the row back through a brand-new, completely
 * independent `mysql2` connection built from nothing but the connection
 * config — proving the event was never held in any JS variable, only in
 * MySQL itself.
 *
 * ## Shared-`schema_migrations`-table race (pre-existing, documented)
 *
 * This suite is the first to load the real `database-mysql` plugin
 * through its real lifecycle module (`index.ts`), which applies this
 * plugin's own real, committed migrations (including
 * `0001_create_database_mysql_audit_log.ts`) via `migrator.ts`'s
 * checksum-verified runner against the single, global
 * `schema_migrations` table every plugin's migrations share. Per feature
 * #34's `claude-progress.txt` notes (a race already documented there and
 * in `tests/plugins/database-mysql/integration.test.ts`'s own sibling
 * suites), a *different* test file concurrently applying-and-not-yet-
 * rolling-back its own throwaway fixture migration under the same
 * `pluginId: "database-mysql"` could transiently make this suite's own
 * `runMigrationsUp` call see a row with no matching file and throw. This
 * is a pre-existing architectural property of the shared tracking table,
 * not something this feature owns fixing — flagged here for whoever
 * eventually addresses it (see feature #34's notes for the suggested
 * fix: a per-plugin-namespaced tracking table).
 *
 * Skips itself (rather than failing) when MySQL isn't reachable, exactly
 * like every other integration suite in this repo — `npm test` stays
 * green without Docker; `init.sh`/CI always have it up.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/core/audit.js";
import { bootstrapKernel } from "../../src/server/index.js";
import { isOk } from "../../src/core/types.js";

/** Matches docker-compose.yml's `mysql` service credentials — same fixture every sibling integration suite uses. */
const DOCKER_COMPOSE_CONFIG = {
  DB_HOST: "127.0.0.1",
  DB_PORT: 3306,
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
};

/** Real `src/plugins` root — proves the wiring works against the actual shipped tree, same as `tests/server/index.test.ts`'s own `REAL_PLUGINS_ROOT`. */
const REAL_PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/plugins",
);

/** Env this suite boots the kernel with — every `DB_*` var `database-mysql`'s own `config.ts` requires, nothing more. */
function realDbEnv(): NodeJS.ProcessEnv {
  return {
    DB_HOST: DOCKER_COMPOSE_CONFIG.DB_HOST,
    DB_PORT: String(DOCKER_COMPOSE_CONFIG.DB_PORT),
    DB_USER: DOCKER_COMPOSE_CONFIG.DB_USER,
    DB_PASSWORD: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
    DB_NAME: DOCKER_COMPOSE_CONFIG.DB_NAME,
  };
}

async function probeMysqlReachable(): Promise<boolean> {
  try {
    const probe = await mysql.createConnection({
      host: DOCKER_COMPOSE_CONFIG.DB_HOST,
      port: DOCKER_COMPOSE_CONFIG.DB_PORT,
      user: DOCKER_COMPOSE_CONFIG.DB_USER,
      password: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
      database: DOCKER_COMPOSE_CONFIG.DB_NAME,
      connectTimeout: 2000,
    });
    await probe.ping();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

// Resolved via top-level await BEFORE describe.runIf()'s condition is
// evaluated at collection time — see database-mysql's own
// integration.test.ts for why this must not be a still-pending promise at
// that point.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[audit-persistence.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #29 audit-persistence integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

/** A `MySqlAuditSink`-shaped object — duck-typed rather than imported as a concrete type, mirroring `server/index.ts`'s own `isAuditLogDbQuery` precedent. */
interface FlushableQueryableAuditSink {
  flush(): Promise<void>;
  query(filter?: { actor?: string }): Promise<readonly AuditEvent[]>;
}

function isFlushableQueryableAuditSink(value: unknown): value is FlushableQueryableAuditSink {
  return (
    typeof value === "object" &&
    value !== null &&
    "flush" in value &&
    typeof (value as { flush: unknown }).flush === "function" &&
    "query" in value &&
    typeof (value as { query: unknown }).query === "function"
  );
}

/** This suite's own actor id — every cleanup query below scopes to exactly this, never a blanket DELETE/DROP against a table other suites could also be writing to. */
const SESSION_ACTOR = "feature29-audit-session";

async function deleteThisSuitesRows(): Promise<void> {
  const connection = await mysql.createConnection({
    host: DOCKER_COMPOSE_CONFIG.DB_HOST,
    port: DOCKER_COMPOSE_CONFIG.DB_PORT,
    user: DOCKER_COMPOSE_CONFIG.DB_USER,
    password: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
    database: DOCKER_COMPOSE_CONFIG.DB_NAME,
  });
  try {
    // The table may not exist yet on a completely fresh database — the
    // first successful boot below is what creates it (via this plugin's
    // own migration). A missing table is not an error worth failing
    // cleanup over.
    await connection.query("DELETE FROM `database_mysql_audit_log` WHERE actor = ?", [
      SESSION_ACTOR,
    ]);
  } catch {
    // ER_NO_SUCH_TABLE (or similar) — nothing to clean up yet.
  } finally {
    await connection.end();
  }
}

describe.runIf(mysqlReachable)(
  "kernel audit trail — MySQL persistence integration (feature #29)",
  () => {
    beforeAll(deleteThisSuitesRows);
    afterAll(deleteThisSuitesRows);

    it(
      "an audit event recorded through kernel.auditSink during a session is persisted to MySQL and " +
        "queryable from a brand-new connection after the plugin is torn down ('restart')",
      async () => {
        const kernel = await bootstrapKernel({
          pluginsRoot: REAL_PLUGINS_ROOT,
          env: realDbEnv(),
        });

        const event: AuditEvent = {
          actor: SESSION_ACTOR,
          action: "feature29:session-event",
          target: "feature29-resource",
          outcome: "recorded",
          timestamp: 1_700_000_000_000,
          details: { note: "recorded during a live session" },
        };

        try {
          // Proves step 2's actual precondition: database-mysql really did
          // load, and the swap from the in-memory bootstrap default to a
          // persistent, MySQL-backed sink really happened.
          expect(kernel.plugins.loaded.map((plugin) => plugin.id)).toContain("database-mysql");
          const delegate = kernel.auditSink.currentDelegate();
          expect(isFlushableQueryableAuditSink(delegate)).toBe(true);
          if (!isFlushableQueryableAuditSink(delegate)) {
            throw new Error("expected the audit sink to have swapped to a MySQL-backed delegate");
          }

          // "A session": some later activity records an audit event
          // through the exact handle every plugin/broker already holds.
          kernel.auditSink.record(event);
          await delegate.flush();

          // Sanity-checked against the very same connection before
          // simulating a restart — the real proof is the query below,
          // through a wholly independent connection.
          expect(await delegate.query({ actor: SESSION_ACTOR })).toEqual([event]);
        } finally {
          // Tear down every in-process handle this boot built for
          // database-mysql — its real onDisable hook destroys the
          // Kysely instance (and, with it, the underlying mysql2 pool) —
          // simulating a process restart before the next step reads it
          // back from nothing but a fresh connection.
          const disableResult = await kernel.disablePlugin("database-mysql");
          expect(isOk(disableResult)).toBe(true);
        }

        // "Restart": a brand-new connection, independent of anything the
        // kernel above ever held in memory.
        const restarted = await mysql.createConnection({
          host: DOCKER_COMPOSE_CONFIG.DB_HOST,
          port: DOCKER_COMPOSE_CONFIG.DB_PORT,
          user: DOCKER_COMPOSE_CONFIG.DB_USER,
          password: DOCKER_COMPOSE_CONFIG.DB_PASSWORD,
          database: DOCKER_COMPOSE_CONFIG.DB_NAME,
        });
        try {
          const [rows] = await restarted.query<mysql.RowDataPacket[]>(
            "SELECT actor, action, target, outcome, timestamp, details FROM `database_mysql_audit_log` " +
              "WHERE actor = ? ORDER BY id ASC",
            [SESSION_ACTOR],
          );
          expect(rows).toHaveLength(1);
          const row = rows[0] as {
            actor: string;
            action: string;
            target: string;
            outcome: string;
            timestamp: number | string;
            details: string | null;
          };
          expect(row.actor).toBe(SESSION_ACTOR);
          expect(row.action).toBe("feature29:session-event");
          expect(row.target).toBe("feature29-resource");
          expect(row.outcome).toBe("recorded");
          expect(Number(row.timestamp)).toBe(1_700_000_000_000);
          expect(JSON.parse(row.details ?? "null")).toEqual({
            note: "recorded during a live session",
          });
        } finally {
          await restarted.end();
        }
      },
    );
  },
);

describe("kernel audit trail — falls back to in-memory when database-mysql is unavailable (feature #29)", () => {
  it("never swaps the audit sink when database-mysql fails to load (e.g. no DB_* config at all)", async () => {
    const kernel = await bootstrapKernel({ pluginsRoot: REAL_PLUGINS_ROOT, env: {} });

    expect(kernel.plugins.loaded.map((plugin) => plugin.id)).not.toContain("database-mysql");
    expect(isFlushableQueryableAuditSink(kernel.auditSink.currentDelegate())).toBe(false);

    const event: AuditEvent = {
      actor: "feature29-fallback-actor",
      action: "feature29:fallback-event",
      target: "feature29-resource",
      outcome: "recorded",
      timestamp: 1,
    };
    // Never throws — the in-memory delegate is still fully functional.
    expect(() => kernel.auditSink.record(event)).not.toThrow();
  });
});
