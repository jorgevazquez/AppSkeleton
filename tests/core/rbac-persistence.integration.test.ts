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
 *
 * ## Addendum: feature #41's full-stack suite lives here too
 *
 * Feature #41 ("RBAC unit and integration test suite (policy engine,
 * caching, persistence, audit)") step 1 asks for one suite that exercises
 * "seeded roles, can() checks, cache invalidation, and audit trail
 * together" against dockerized MySQL. The nested `describe` block at the
 * bottom of this file — after the two feature #34 tests above — is that
 * suite. It is deliberately appended here rather than living in its own
 * file: every other RBAC integration suite that owns full DROP/CREATE
 * lifecycle over these exact `rbac_*` table names (this file, and
 * `rbac-default-roles-seed.integration.test.ts`) already accepts the
 * "pre-existing architectural property" this file's own docs above call
 * out — concurrently-scheduled vitest test *files* racing on the same
 * literal tables. A third independent file doing its own CREATE/DROP here
 * would add a new, unnecessary chance of that race actually firing (it did,
 * during this feature's own development — see git history); reusing this
 * file's already-serialized hooks and connecting only via fresh,
 * feature41-prefixed rows (never a table CREATE/DROP of its own, and never
 * one of the literal default-seed role/permission ids
 * `rbac-default-roles-seed.integration.test.ts` asserts an *exact*,
 * unscoped row count over) avoids introducing that risk at all.
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
import { createInMemoryAuditSink, type InMemoryAuditSink } from "../../src/core/audit.js";
import { createCapabilityBroker } from "../../src/core/broker.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../src/core/loader.js";
import type { PluginManifest } from "../../src/core/manifest.js";
import { isOk } from "../../src/core/types.js";
import * as rbacModule from "../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../src/plugins/rbac/index.js";
import type { RbacManagementApi } from "../../src/plugins/rbac/src/manage.js";
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

  /**
   * Feature #41 — "RBAC unit and integration test suite (policy engine,
   * caching, persistence, audit)", step 1: one suite exercising seeded
   * roles, `can()` checks, cache invalidation, and the audit trail
   * together — see this file's module doc "Addendum" section above for why
   * this lives nested here instead of its own file.
   *
   * Every fixture id below is `feature41-`-prefixed — distinct from this
   * file's own `feature34-*` ids above and from
   * `rbac-default-roles-seed.integration.test.ts`'s literal
   * `admin`/`editor`/`viewer`/`rbac:manage`/`wiki:*` ids — so this suite's
   * real MySQL rows can never collide with either sibling suite's data or
   * exact-row-count assertions, no matter how vitest schedules the three
   * files relative to one another.
   *
   * The one exception is the `"rbac:manage"` grant driving this suite's
   * `rbac:manage` mutation below: mirroring
   * `manage-capability.test.ts`'s own precedent, that grant is pushed
   * directly into `rbacModule.policyStore` (in-memory only, never written
   * to the real `rbac_permissions` table) — `index.ts`'s `assertCanManage`
   * reads `check()`'s in-memory policy state, not the database, so no real
   * row with that literal, shared id is ever needed here.
   */
  describe("rbac — full-stack integration (feature #41)", () => {
    const ADMIN = "feature41-admin";
    const EDITOR = "feature41-editor";
    const OUTSIDER = "feature41-outsider";
    const ADMIN_ROLE = "feature41-admin-role";
    const EDITOR_ROLE = "feature41-editor-role";
    const WRITE_PERMISSION = "feature41-wiki:write";
    const READ_PERMISSION = "feature41-wiki:read";

    function manifest(
      id: string,
      provides: string[],
      options: { dependsOn?: Record<string, string>; requires?: string[] } = {},
    ): PluginManifest {
      return {
        id,
        version: "1.0.0",
        depends_on: options.dependsOn ?? {},
        capabilities: { provides, requires: options.requires ?? [] },
        entry_point: "index.ts",
      };
    }

    /**
     * A minimal `http:route` provider — feature #44 made `rbac`'s own
     * `onEnable` obtain `http:route` synchronously (to register its admin
     * routes), so `loadRbac()` below now needs *some* provider for it,
     * exactly like every other `http:route`-consuming plugin's own test
     * fixtures already require. This fixture only records calls — it never
     * spins up a real Fastify instance — since this suite's own tests only
     * care about persistence/policy/audit wiring, not about the routes
     * feature #44 registers.
     */
    const httpRouteFixtureManifest = manifest("http-route-fixture", ["http:route"]);
    function httpRouteFixtureModule(): PluginModule {
      return { provides: { "http:route": { registerRoute: () => {} } } };
    }

    /** Load the real rbac plugin through the real broker/loader, wired to a fresh audit sink. */
    async function loadRbac(): Promise<{
      check: RbacCheckCapability["check"];
      manage: RbacManagementApi;
      auditSink: InMemoryAuditSink;
    }> {
      const auditSink = createInMemoryAuditSink();
      const definitions: PluginDefinition[] = [
        { manifest: httpRouteFixtureManifest, module: httpRouteFixtureModule() },
        {
          manifest: manifest("rbac", ["rbac:check", "rbac:manage"], {
            dependsOn: { "http-route-fixture": "^1.0.0" },
            requires: ["http:route"],
          }),
          module: rbacModule,
        },
      ];
      const broker = createCapabilityBroker();

      const loadResult = await loadPlugins(definitions, broker, { auditSink });
      expect(isOk(loadResult)).toBe(true);
      if (!isOk(loadResult)) {
        throw new Error("expected rbac to load successfully");
      }
      expect(loadResult.value.failed).toEqual([]);

      const check = (rbacModule.provides?.["rbac:check"] as RbacCheckCapability).check;
      const manage = rbacModule.provides?.["rbac:manage"] as RbacManagementApi;
      return { check, manage, auditSink };
    }

    afterAll(() => {
      rbacModule.resetPolicyStoreForTests();
    });

    it("seeded roles persisted in real MySQL, fed through loadPolicyStore(), drive correct check() decisions — cached, and every decision audited", async () => {
      rbacModule.resetPolicyStoreForTests();

      // "Seeded roles": real inserts through the real, db:query-backed
      // RbacStore, against real dockerized MySQL — a fresh connection, own
      // to this test, independent of `setup`/`restarted` above (both
      // already destroyed by the earlier feature #34 tests).
      const fixture = connect();
      try {
        const store = createRbacStore(fixture.queryCapability);
        await store.createRole({ id: ADMIN_ROLE, name: "Feature 41 Admin" });
        await store.createRole({ id: EDITOR_ROLE, name: "Feature 41 Editor" });
        await store.createPermission({
          id: WRITE_PERMISSION,
          resource: "feature41-wiki",
          action: "write",
        });
        await store.createPermission({
          id: READ_PERMISSION,
          resource: "feature41-wiki",
          action: "read",
        });
        await store.assignPermissionToRole(EDITOR_ROLE, WRITE_PERMISSION);
        await store.assignPermissionToRole(EDITOR_ROLE, READ_PERMISSION);
        await store.assignRoleToUser(ADMIN, ADMIN_ROLE);
        await store.assignRoleToUser(EDITOR, EDITOR_ROLE);
        // OUTSIDER deliberately gets no role at all — deny-by-default coverage.

        // "Persistence": read the same data back through a *different*
        // freshly-built store/connection, proving it round-tripped through
        // real MySQL rather than being served from anything still held in
        // JS memory from the writes above.
        const reread = connect();
        let persisted;
        try {
          persisted = await createRbacStore(reread.queryCapability).loadPolicyStore();
        } finally {
          await reread.db.destroy();
        }
        expect(persisted.rolePermissions).toEqual(
          expect.arrayContaining([
            { roleId: EDITOR_ROLE, permissionId: WRITE_PERMISSION },
            { roleId: EDITOR_ROLE, permissionId: READ_PERMISSION },
          ]),
        );
        expect(persisted.userRoles).toEqual(
          expect.arrayContaining([
            { userId: ADMIN, roleId: ADMIN_ROLE },
            { userId: EDITOR, roleId: EDITOR_ROLE },
          ]),
        );

        // Hydrate the plugin's in-memory policyStore from the DB-backed
        // snapshot — the "feed the result into policyStore" path
        // index.ts's own module doc anticipates for a future feature — plus
        // ADMIN's purely in-memory "rbac:manage" grant (see this describe
        // block's own doc comment for why that one grant is never a real
        // row).
        rbacModule.policyStore.userRoles.push(...persisted.userRoles);
        rbacModule.policyStore.rolePermissions.push(...persisted.rolePermissions);
        rbacModule.roleCatalog.set(ADMIN_ROLE, { id: ADMIN_ROLE, name: "Feature 41 Admin" });
        rbacModule.policyStore.rolePermissions.push({
          roleId: ADMIN_ROLE,
          permissionId: "rbac:manage",
        });

        // "can() checks", through the real, cached, audited check()
        // capability — never `can()` directly.
        const { check, auditSink } = await loadRbac();

        expect(check(EDITOR, "write", "feature41-wiki")).toBe(true);
        expect(check(EDITOR, "read", "feature41-wiki")).toBe(true);
        expect(check(ADMIN, "manage", "rbac")).toBe(true);
        expect(check(ADMIN, "write", "feature41-wiki")).toBe(false);
        expect(check(OUTSIDER, "read", "feature41-wiki")).toBe(false);

        // "Audit trail": every decision above, queryable by actor/outcome.
        expect(auditSink.query({ actor: EDITOR, outcome: "allowed" })).toHaveLength(2);
        expect(auditSink.query({ actor: ADMIN, outcome: "allowed" })).toHaveLength(1);
        expect(auditSink.query({ actor: ADMIN, outcome: "denied" })).toHaveLength(1);
        expect(auditSink.query({ actor: OUTSIDER, outcome: "denied" })).toHaveLength(1);

        // Repeating the exact same check is a cache hit (feature #35) but
        // still fully audited (feature #38) — caching is purely a
        // can()-computation optimization, invisible to the audit trail.
        const cacheKey = JSON.stringify([EDITOR, "write", "feature41-wiki"]);
        const cached = rbacModule.checkCacheState.entries.get(cacheKey);
        expect(cached).toEqual({ allowed: true, expiresAt: expect.any(Number) });

        expect(check(EDITOR, "write", "feature41-wiki")).toBe(true);
        expect(
          auditSink.query({
            actor: EDITOR,
            action: "write",
            target: "feature41-wiki",
            outcome: "allowed",
          }),
        ).toHaveLength(2);
      } finally {
        await fixture.db.destroy();
      }
    });

    it("cache invalidation: a real rbac:manage mutation immediately changes the next check() decision, not after the TTL", async () => {
      rbacModule.resetPolicyStoreForTests();

      // Fresh, independent set of feature41-prefixed rows — this test does
      // not depend on the previous one having run.
      const roleId = "feature41-editor-role-2";
      const permissionId = "feature41-wiki:comment";
      const adminRoleId = "feature41-admin-role-2";
      const editor = "feature41-editor-2";
      const admin = "feature41-admin-2";

      const fixture = connect();
      try {
        const store = createRbacStore(fixture.queryCapability);
        await store.createRole({ id: roleId, name: "Feature 41 Editor 2" });
        await store.createPermission({
          id: permissionId,
          resource: "feature41-wiki",
          action: "comment",
        });
        await store.assignPermissionToRole(roleId, permissionId);
        await store.assignRoleToUser(editor, roleId);

        const persisted = await store.loadPolicyStore();
        rbacModule.policyStore.userRoles.push(...persisted.userRoles);
        rbacModule.policyStore.rolePermissions.push(...persisted.rolePermissions);
        rbacModule.roleCatalog.set(adminRoleId, { id: adminRoleId, name: "Feature 41 Admin 2" });
        rbacModule.policyStore.userRoles.push({ userId: admin, roleId: adminRoleId });
        rbacModule.policyStore.rolePermissions.push({
          roleId: adminRoleId,
          permissionId: "rbac:manage",
        });

        const { check, manage, auditSink } = await loadRbac();

        // First call: cache miss, populates checkCacheState; also proves
        // the seeded-and-persisted grant actually allows.
        expect(check(editor, "comment", "feature41-wiki")).toBe(true);

        // Real rbac:manage mutation (feature #36), authorized by this
        // suite's own in-memory-only "rbac:manage" grant — not a direct
        // invalidateCheckCache() call.
        await manage.revokePermissionFromRole(admin, roleId, permissionId);

        // The very next check for the exact same triple that was cached
        // `true` above already reflects the revoke.
        expect(check(editor, "comment", "feature41-wiki")).toBe(false);
        expect(
          auditSink.query({
            actor: editor,
            action: "comment",
            target: "feature41-wiki",
            outcome: "denied",
          }),
        ).toHaveLength(1);

        // The real MySQL row this suite wrote is untouched by the in-memory
        // management mutation — rbac:manage's current backing store has not
        // been wired to store.ts's DB-backed layer (see index.ts's own
        // docs). A brand-new connection still sees the original grant.
        const fresh = connect();
        try {
          const rolePermissions = await createRbacStore(
            fresh.queryCapability,
          ).listRolePermissions();
          expect(rolePermissions).toEqual(expect.arrayContaining([{ roleId, permissionId }]));
        } finally {
          await fresh.db.destroy();
        }
      } finally {
        await fixture.db.destroy();
      }
    });
  });
});
