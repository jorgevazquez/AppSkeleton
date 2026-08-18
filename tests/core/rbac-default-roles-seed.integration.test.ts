/**
 * Integration test for feature #37 ("Seed default roles and permissions
 * (admin, editor, viewer)"), step 3: "write a test asserting seeding twice
 * does not create duplicate roles."
 *
 * ## Why this lives in tests/core, not tests/plugins/rbac
 *
 * Same rationale as `tests/core/rbac-persistence.integration.test.ts`
 * (feature #34)'s own header comment: proving the seed actually writes real
 * rows needs `database-mysql`'s real pool/Kysely wiring alongside `rbac`'s
 * own migration files to create the `rbac_*` tables first — genuinely
 * cross-plugin, kernel-level wiring `docs/plugin-conventions.md`'s
 * "kernel-integration tests" carve-out allows, not something
 * `tests/plugins/rbac/**` could express under that section's rule.
 *
 * ## What this proves
 *
 * `src/plugins/rbac/seeds/index.ts` registers `"rbac:default-roles"` with
 * the generic seed runner (`src/core/seed.ts`, feature #25) purely by being
 * imported — exactly how `src/cli/seed.ts`'s `loadPluginSeedModules()`
 * discovers it in production. Importing it here for that same side effect,
 * then driving it through the real `runSeeds()` against real MySQL, tests
 * the actual shipped seed file end to end rather than a re-implementation
 * of it:
 *
 *   1. A first `runSeeds()` call applies it: exactly the three roles
 *      (`admin`/`editor`/`viewer`), the four permissions, and the role -
 *      permission grants `seeds/index.ts` declares all land in their real
 *      `rbac_*` tables.
 *   2. A second `runSeeds()` call — simulating a second `npm run seed`
 *      invocation, e.g. after a redeploy — applies nothing new
 *      (`result.applied` is empty, `result.skipped` includes the seed's
 *      key) and, critically, the role/permission/grant row counts are
 *      unchanged: still exactly three roles, not six. This is feature #37
 *      step 3's literal requirement, proven the same way feature #25's own
 *      `tests/plugins/database-mysql/seed.integration.test.ts` proves
 *      idempotency generically: `runSeeds()`'s own `schema_seeds`
 *      bookkeeping — not any dedup logic inside the seed function itself —
 *      is what makes re-running it a no-op.
 *   3. A third call reconfirms nothing changes further.
 *
 * Skips itself (rather than failing) when MySQL isn't reachable, matching
 * every other integration suite in this repo.
 */
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  SEEDS_TABLE,
  listRegisteredSeeds,
  runSeeds,
  type SeedableDatabase,
} from "../../src/core/seed.js";
import { createDbPool } from "../../src/plugins/database-mysql/src/pool.js";
import { createKyselyDb } from "../../src/plugins/database-mysql/src/db.js";
import * as createRoles from "../../src/plugins/rbac/src/migrations/0001_create_rbac_roles.js";
import * as createPermissions from "../../src/plugins/rbac/src/migrations/0002_create_rbac_permissions.js";
import * as createRolePermissions from "../../src/plugins/rbac/src/migrations/0003_create_rbac_role_permissions.js";
import { DEFAULT_PERMISSIONS, DEFAULT_ROLES } from "../../src/plugins/rbac/seeds/index.js";

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

const SEED_KEY = "rbac:default-roles";
const RBAC_TABLES = ["rbac_role_permissions", "rbac_permissions", "rbac_roles"] as const;

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
// evaluated at collection time — see the sibling integration suites for why
// this must not be a still-pending promise at that point.
const mysqlReachable = await probeMysqlReachable();

if (!mysqlReachable) {
  console.warn(
    "[rbac-default-roles-seed.integration.test] docker-compose MySQL is not reachable at " +
      `${DOCKER_COMPOSE_CONFIG.DB_HOST}:${DOCKER_COMPOSE_CONFIG.DB_PORT} — skipping the ` +
      "feature #37 seed integration suite. Run `./init.sh` (or `docker compose up -d mysql`) first.",
  );
}

describe.runIf(mysqlReachable)("rbac — default roles/permissions seed (feature #37)", () => {
  let pool: mysql.Pool;
  let db: Kysely<SeedableDatabase>;

  beforeAll(async () => {
    pool = createDbPool(DOCKER_COMPOSE_CONFIG);
    db = createKyselyDb(pool);

    for (const table of RBAC_TABLES) {
      await pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await pool.query("DELETE FROM `" + SEEDS_TABLE + "` WHERE `name` = ?", [SEED_KEY]);

    // Real migration files (feature #34), applied directly — same technique
    // rbac-persistence.integration.test.ts uses, avoiding any race with
    // sibling suites' own use of the shared schema_migrations tracking
    // table.
    await createRoles.up(db);
    await createPermissions.up(db);
    await createRolePermissions.up(db);
  });

  afterAll(async () => {
    for (const table of RBAC_TABLES) {
      await pool.query("DROP TABLE IF EXISTS `" + table + "`");
    }
    await pool.query("DELETE FROM `" + SEEDS_TABLE + "` WHERE `name` = ?", [SEED_KEY]);
    await db.destroy();
  });

  async function roleRows() {
    return db.selectFrom("rbac_roles").selectAll().orderBy("id", "asc").execute();
  }

  async function permissionRows() {
    return db.selectFrom("rbac_permissions").selectAll().orderBy("id", "asc").execute();
  }

  async function rolePermissionRows() {
    return db.selectFrom("rbac_role_permissions").selectAll().execute();
  }

  it("registers the seed under the expected key", () => {
    expect(listRegisteredSeeds().map((s) => s.key)).toContain(SEED_KEY);
  });

  it("applies the seed: creates exactly admin/editor/viewer with the starter permission set", async () => {
    const result = await runSeeds(db);

    expect(result.applied).toEqual([SEED_KEY]);
    expect(result.skipped).toEqual([]);

    const roles = await roleRows();
    expect(roles.map((r) => r["id"])).toEqual(["admin", "editor", "viewer"]);
    expect(roles).toHaveLength(DEFAULT_ROLES.length);

    const permissions = await permissionRows();
    expect(permissions.map((p) => p["id"]).sort()).toEqual(
      [...DEFAULT_PERMISSIONS.map((p) => p.id)].sort(),
    );

    const grants = await rolePermissionRows();
    const adminGrants = grants.filter((g) => g["role_id"] === "admin");
    const editorGrants = grants.filter((g) => g["role_id"] === "editor");
    const viewerGrants = grants.filter((g) => g["role_id"] === "viewer");
    expect(adminGrants).toHaveLength(4);
    expect(editorGrants).toHaveLength(2);
    expect(viewerGrants).toHaveLength(1);
    expect(grants).toHaveLength(
      DEFAULT_ROLES.reduce((total, role) => total + role.permissionIds.length, 0),
    );
  });

  it("seeding twice does not create duplicate roles (feature #37 step 3)", async () => {
    const result = await runSeeds(db);

    // Nothing new applied — schema_seeds already has this key recorded.
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([SEED_KEY]);

    // Still exactly three roles — not six — despite the seed's own INSERTs
    // having no existence check of their own (see seeds/index.ts's
    // "Idempotency" doc section).
    const roles = await roleRows();
    expect(roles).toHaveLength(3);
    expect(roles.map((r) => r["id"])).toEqual(["admin", "editor", "viewer"]);

    const permissions = await permissionRows();
    expect(permissions).toHaveLength(DEFAULT_PERMISSIONS.length);

    const grants = await rolePermissionRows();
    expect(grants).toHaveLength(
      DEFAULT_ROLES.reduce((total, role) => total + role.permissionIds.length, 0),
    );
  });

  it("running a third time is still a no-op", async () => {
    const result = await runSeeds(db);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([SEED_KEY]);

    const roles = await roleRows();
    expect(roles).toHaveLength(3);
  });
});
