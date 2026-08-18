/**
 * Integration test for feature #34 ("Persistent storage for roles,
 * permissions, and assignments via database-mysql"), step 3: "create a
 * role, assign a permission, assign to a user, restart, and confirm state
 * persisted."
 *
 * ## Why this lives in tests/core, not tests/plugins/rbac
 *
 * `docs/plugin-conventions.md` section 5: a test file under
 * `tests/plugins/<plugin-id>/**` "must not import from another plugin's
 * src/ either." Proving real persistence needs the *real* `database-mysql`
 * plugin's pool/Kysely wiring and its already-shipped `db:query` capability
 * (feature #20) alongside `rbac`'s own migration files
 * (`src/plugins/rbac/src/migrations/`) — i.e. genuinely cross-plugin,
 * kernel-level wiring, not something one plugin's own test directory can
 * express under that rule. This mirrors `tests/core/kernel.integration.test.ts`'s
 * "kernel-integration tests" carve-out the same doc section allows.
 *
 * ## Why this applies migrations by calling `up()`/`down()` directly, not
 * via `database-mysql`'s `runMigrationsUp`/`runMigrationsDown`
 *
 * `migrator.ts`'s checksum-verified runner (features #19/#22) tracks every
 * applied migration in one *global* `schema_migrations` table shared by
 * every plugin's migrations, and `verifyAppliedChecksums` requires *every*
 * row currently in that table — not just the caller's own plugin's rows —
 * to have a matching entry in the `files` list the caller passed in. Vitest
 * runs test files concurrently by default, and `database-mysql`'s own
 * `integration.test.ts`/`migrator.integration.test.ts` suites already apply
 * and roll back their own throwaway migrations against this same
 * docker-compose MySQL instance's `schema_migrations` table at the same
 * time this suite would run. Driving this suite's setup/teardown through
 * the shared runner would make both suites' migration bookkeeping race
 * (a transient row from one suite failing the other's
 * `verifyAppliedChecksums` with `missing_file`) — this is a pre-existing
 * architectural property of `migrator.ts`'s single global tracking table,
 * not something feature #34 owns fixing. Calling this plugin's own
 * migration modules' `up(db)`/`down(db)` functions directly (an ordinary
 * same-plugin import — see `docs/plugin-conventions.md` section 5) proves
 * the real, committed migration files work against real MySQL without
 * touching that shared table at all; namespace enforcement itself already
 * has dedicated coverage in `migrator.test.ts` and
 * `database-mysql/integration.test.ts`'s "namespace enforcement" suite, so
 * re-proving it here isn't this test's job.
 *
 * ## "Restart"
 *
 * There's no real process restart inside a vitest run. Per the same
 * technique `database-mysql`'s own integration suite and this repo's
 * config/pool tests already rely on, "restart" is simulated by destroying
 * every in-process handle this test built (the mysql2 pool, the
 * `Kysely<Database>` instance, the `db:query` capability wrapper, and the
 * `RbacStore` closing over it) and constructing a *completely fresh* set
 * from nothing but the connection config — proving the asserted-on state
 * was never held in any JS variable, only in MySQL itself.
 *
 * Skips itself (rather than failing) when MySQL isn't reachable, exactly
 * like every other integration suite in this repo — `npm test` stays green
 * without Docker; `init.sh`/CI always have it up.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createDbPool } from "../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb, type Database } from "../../src/plugins/database-mysql/src/db.js";
import {
  createDbQueryCapability,
  type DbQueryCapability,
} from "../../src/plugins/database-mysql/src/query-capability.js";
import { can } from "../../src/plugins/rbac/src/policy.js";
import { createRbacStore } from "../../src/plugins/rbac/src/store.js";
import * as createRoles from "../../src/plugins/rbac/src/migrations/0001_create_rbac_roles.js";
import * as createPermissions from "../../src/plugins/rbac/src/migrations/0002_create_rbac_permissions.js";
import * as createRolePermissions from "../../src/plugins/rbac/src/migrations/0003_create_rbac_role_permissions.js";
import * as createUserRoles from "../../src/plugins/rbac/src/migrations/0004_create_rbac_user_roles.js";

/** Matches docker-compose.yml's `mysql` service credentials — same fixture every sibling integration suite uses. */
const DOCKER_COMPOSE_CONFIG = {
  DB_HOST: "127.0.0.1",
  DB_PORT: 3306,
  DB_USER: "appskeleton",
  DB_PASSWORD: "change-me",
  DB_NAME: "appskeleton",
  DB_CONNECTION_LIMIT: 5,
  DB_SSL: "disabled" as const,
  DB_SSL_REJECT_UNAUTHORIZED: true,
};

/** This suite's own rbac_ tables, in dependency order (association tables reference these by value, not a real FK — but drop child-before-parent anyway, for readability). */
const RBAC_TABLES = [
  "rbac_role_permissions",
  "rbac_user_roles",
  "rbac_permissions",
  "rbac_roles",
] as const;

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
// evaluated at collection time — see database-mysql's own integration.test.ts
// for why this must not be a still-pending promise at that point.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[rbac-persistence.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #34 persistence integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

/** Build a fresh pool + Kysely + db:query capability triplet from nothing but the connection config — used both for the initial setup and to simulate a "restart." */
function connect(): { pool: mysql.Pool; db: Kysely<Database>; queryCapability: DbQueryCapability } {
  const pool = createDbPool(DOCKER_COMPOSE_CONFIG);
  const db = createKyselyDb(pool);
  const queryCapability = createDbQueryCapability(db);
  return { pool, db, queryCapability };
}

describe.runIf(mysqlReachable)("rbac — persistent storage integration (feature #34)", () => {
  const ROLE_ID = "feature34-editor";
  const PERMISSION_ID = "feature34-doc:edit";
  const USER_ID = "feature34-alice";

  let setup: ReturnType<typeof connect>;

  beforeAll(async () => {
    setup = connect();
    // Drop leftovers from a prior interrupted run before creating fresh
    // tables — CREATE TABLE below is not itself IF-NOT-EXISTS-guarded,
    // matching the real migration files' production shape.
    for (const table of RBAC_TABLES) {
      await setup.pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await createRoles.up(setup.db);
    await createPermissions.up(setup.db);
    await createRolePermissions.up(setup.db);
    await createUserRoles.up(setup.db);
  });

  afterAll(async () => {
    // Independent connection — the second test already destroys `setup`'s
    // pool to simulate a restart, so cleanup can't assume it's still live.
    const cleanup = connect();
    try {
      for (const table of RBAC_TABLES) {
        await cleanup.pool.query("DROP TABLE IF EXISTS `" + table + "`");
      }
    } finally {
      await cleanup.db.destroy();
    }
  });

  it("creates a role, assigns a permission to it, and assigns it to a user", async () => {
    const store = createRbacStore(setup.queryCapability);

    await store.createRole({ id: ROLE_ID, name: "Feature 34 Editor" });
    await store.createPermission({
      id: PERMISSION_ID,
      resource: "feature34-doc",
      action: "edit",
    });
    await store.assignPermissionToRole(ROLE_ID, PERMISSION_ID);
    await store.assignRoleToUser(USER_ID, ROLE_ID);

    // Sanity-checked against the very same connection before simulating a
    // restart — the real proof is the next test, reading through a wholly
    // separate connection built from scratch.
    expect(await store.getRole(ROLE_ID)).toEqual({ id: ROLE_ID, name: "Feature 34 Editor" });
    expect(await store.listRolePermissions()).toEqual(
      expect.arrayContaining([{ roleId: ROLE_ID, permissionId: PERMISSION_ID }]),
    );
    expect(await store.listUserRoles()).toEqual(
      expect.arrayContaining([{ userId: USER_ID, roleId: ROLE_ID }]),
    );

    // Tear down every in-process handle — pool, Kysely instance, and the
    // db:query capability closing over it — so nothing from this test
    // could possibly still be reachable from JS memory afterward.
    await setup.db.destroy();
  });

  it("restart: a brand-new connection, pool, and store still see everything that was persisted", async () => {
    const restarted = connect();
    try {
      const store = createRbacStore(restarted.queryCapability);

      expect(await store.getRole(ROLE_ID)).toEqual({ id: ROLE_ID, name: "Feature 34 Editor" });
      expect(await store.getPermission(PERMISSION_ID)).toEqual({
        id: PERMISSION_ID,
        resource: "feature34-doc",
        action: "edit",
      });

      const policyStore = await store.loadPolicyStore();
      expect(policyStore.userRoles).toEqual(
        expect.arrayContaining([{ userId: USER_ID, roleId: ROLE_ID }]),
      );
      expect(policyStore.rolePermissions).toEqual(
        expect.arrayContaining([{ roleId: ROLE_ID, permissionId: PERMISSION_ID }]),
      );

      // The full round trip: policy.ts's real, unchanged can() correctly
      // resolves an allow from data that was written before this
      // connection ever existed, and still denies an unrelated check.
      expect(can(policyStore, USER_ID, "edit", "feature34-doc")).toBe(true);
      expect(can(policyStore, USER_ID, "delete", "feature34-doc")).toBe(false);
      expect(can(policyStore, "someone-else", "edit", "feature34-doc")).toBe(false);
    } finally {
      // afterAll's cleanup uses its own independent connection, so this
      // one's only job is to prove the round trip above — always torn down
      // here, regardless of outcome.
      await restarted.db.destroy();
    }
  });
});
