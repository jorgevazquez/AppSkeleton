/**
 * Tests for feature #40 — "Bootstrap-admin safety mechanism to prevent
 * permanent lockout".
 *
 * Two layers, mirroring `manage.test.ts` / `manage-capability.test.ts`'s own
 * split:
 *
 *   1. Unit tests against `ensureBootstrapAdmin` directly
 *      (`src/plugins/rbac/src/bootstrap-admin.ts`), with a hand-rolled
 *      in-memory {@link BootstrapAdminStore} fake and a spy {@link
 *      BootstrapAdminReporter} — no broker, no loader, no real console
 *      output, no real randomness.
 *   2. Wiring tests against the real `rbac` plugin
 *      (`src/plugins/rbac/index.ts`), driven through the real
 *      broker/loader exactly like `audit.test.ts`/
 *      `rbac-persistence.integration.test.ts`'s `loadRbac()` helper —
 *      proving `onEnable` actually self-heals a locked-out system: the
 *      provisioned bootstrap account can immediately use the real,
 *      unmodified `check()`/`rbac:manage` to manage roles.
 *
 * Feature #40 step 3 ("write a test simulating first-run vs.
 * already-provisioned states") is covered at both layers: "first run" is
 * every test starting from an empty store/`resetPolicyStoreForTests()`;
 * "already provisioned" is a store/policyStore pre-seeded with an existing
 * `"admin"` assignment before the mechanism runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import { createCapabilityBroker } from "../../../src/core/broker.js";
import { loadPlugins, type PluginDefinition } from "../../../src/core/loader.js";
import type { PluginManifest } from "../../../src/core/manifest.js";
import { isOk } from "../../../src/core/types.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";
import {
  BOOTSTRAP_ADMIN_MANAGE_PERMISSION_ID,
  BOOTSTRAP_ADMIN_ROLE_ID,
  createConsoleBootstrapAdminReporter,
  ensureBootstrapAdmin,
  type BootstrapAdminReporter,
  type BootstrapAdminStore,
} from "../../../src/plugins/rbac/src/bootstrap-admin.js";
import type { RbacManagementApi } from "../../../src/plugins/rbac/src/manage.js";
import type { Role, UserRole } from "../../../src/plugins/rbac/src/types.js";

/** A plain in-memory `BootstrapAdminStore` fake — real Map/array state, not a mock framework double. */
function createFakeStore(
  seed: { userRoles?: UserRole[]; roles?: Map<string, Role> } = {},
): BootstrapAdminStore & {
  roles: Map<string, Role>;
  userRoles: UserRole[];
  rolePermissions: Array<{ roleId: string; permissionId: string }>;
} {
  const roles = seed.roles ?? new Map<string, Role>();
  const userRoles = seed.userRoles ?? [];
  const rolePermissions: Array<{ roleId: string; permissionId: string }> = [];

  return {
    roles,
    userRoles,
    rolePermissions,
    listUserRoles: () => userRoles,
    getRole: (id) => roles.get(id),
    createRole: (role) => {
      roles.set(role.id, role);
    },
    assignPermissionToRole: (roleId, permissionId) => {
      const alreadyGranted = rolePermissions.some(
        (grant) => grant.roleId === roleId && grant.permissionId === permissionId,
      );
      if (alreadyGranted) {
        throw new ValidationError(`Permission "${permissionId}" already assigned to "${roleId}".`, {
          details: { roleId, permissionId },
        });
      }
      rolePermissions.push({ roleId, permissionId });
    },
    assignRoleToUser: (userId, roleId) => {
      userRoles.push({ userId, roleId });
    },
  };
}

/** A spy `BootstrapAdminReporter` recording every reported credential, in order — never touches real `console.warn`. */
function createSpyReporter(): BootstrapAdminReporter & {
  reported: Array<{ userId: string; token: string }>;
} {
  const reported: Array<{ userId: string; token: string }> = [];
  return {
    reported,
    reportProvisioned: (credential) => {
      reported.push(credential);
    },
  };
}

describe("ensureBootstrapAdmin (feature #40) — unit", () => {
  it("first run: zero users hold the admin role, so a bootstrap admin is provisioned and reported exactly once", async () => {
    const store = createFakeStore();
    const reporter = createSpyReporter();

    const credential = await ensureBootstrapAdmin(store, reporter, {
      generateUserId: () => "bootstrap-admin-fixed",
      generateToken: () => "fixed-token",
    });

    expect(credential).toEqual({ userId: "bootstrap-admin-fixed", token: "fixed-token" });
    expect(store.userRoles).toEqual([
      { userId: "bootstrap-admin-fixed", roleId: BOOTSTRAP_ADMIN_ROLE_ID },
    ]);
    expect(store.roles.get(BOOTSTRAP_ADMIN_ROLE_ID)).toBeDefined();
    expect(store.rolePermissions).toEqual([
      { roleId: BOOTSTRAP_ADMIN_ROLE_ID, permissionId: BOOTSTRAP_ADMIN_MANAGE_PERMISSION_ID },
    ]);
    expect(reporter.reported).toEqual([{ userId: "bootstrap-admin-fixed", token: "fixed-token" }]);
  });

  it("first run: the admin role already exists (e.g. seeded) with its rbac:manage grant already present — provisioning still succeeds, without a duplicate-grant error", async () => {
    const roles = new Map<string, Role>([
      [BOOTSTRAP_ADMIN_ROLE_ID, { id: BOOTSTRAP_ADMIN_ROLE_ID, name: "Administrator" }],
    ]);
    const store = createFakeStore({ roles });
    store.rolePermissions.push({
      roleId: BOOTSTRAP_ADMIN_ROLE_ID,
      permissionId: BOOTSTRAP_ADMIN_MANAGE_PERMISSION_ID,
    });
    const reporter = createSpyReporter();

    const credential = await ensureBootstrapAdmin(store, reporter);

    expect(credential).toBeDefined();
    expect(store.userRoles).toEqual([
      { userId: credential?.userId, roleId: BOOTSTRAP_ADMIN_ROLE_ID },
    ]);
    // Still exactly one grant — no duplicate was pushed alongside the pre-existing one.
    expect(store.rolePermissions).toHaveLength(1);
    expect(reporter.reported).toHaveLength(1);
  });

  it("already provisioned: a real admin already exists — no-op, nothing reported, no account created", async () => {
    const store = createFakeStore({
      userRoles: [{ userId: "real-operator", roleId: BOOTSTRAP_ADMIN_ROLE_ID }],
    });
    const reporter = createSpyReporter();

    const credential = await ensureBootstrapAdmin(store, reporter);

    expect(credential).toBeUndefined();
    expect(reporter.reported).toEqual([]);
    // Untouched — still exactly the one pre-existing assignment.
    expect(store.userRoles).toEqual([{ userId: "real-operator", roleId: BOOTSTRAP_ADMIN_ROLE_ID }]);
    expect(store.roles.size).toBe(0);
  });

  it("already provisioned: an admin held by some other, non-bootstrap role name is irrelevant — only the admin role id counts", async () => {
    const store = createFakeStore({
      userRoles: [{ userId: "editor-eve", roleId: "editor" }],
    });
    const reporter = createSpyReporter();

    const credential = await ensureBootstrapAdmin(store, reporter);

    // "editor" is not "admin" — this is still a first-run-with-zero-admins state.
    expect(credential).toBeDefined();
    expect(reporter.reported).toHaveLength(1);
  });

  it("disabled automatically once at least one admin exists: a second call after provisioning is a no-op", async () => {
    const store = createFakeStore();
    const reporter = createSpyReporter();

    const first = await ensureBootstrapAdmin(store, reporter);
    expect(first).toBeDefined();

    const second = await ensureBootstrapAdmin(store, reporter);
    expect(second).toBeUndefined();
    // Still only the first call's credential was ever reported.
    expect(reporter.reported).toHaveLength(1);
    // Still only one user holds the admin role — no second bootstrap account.
    expect(store.userRoles).toHaveLength(1);
  });

  it("createConsoleBootstrapAdminReporter writes a single banner string containing the userId and token, and nothing else", () => {
    const write = vi.fn();
    const reporter = createConsoleBootstrapAdminReporter(write);

    reporter.reportProvisioned({ userId: "bootstrap-admin-abc123", token: "super-secret-token" });

    expect(write).toHaveBeenCalledTimes(1);
    const banner = write.mock.calls[0]?.[0] as string;
    expect(banner).toContain("bootstrap-admin-abc123");
    expect(banner).toContain("super-secret-token");
    expect(banner).toContain("ONLY ONCE");
  });
});

describe("rbac plugin onEnable — bootstrap-admin wiring (feature #40)", () => {
  function manifest(provides: string[]): PluginManifest {
    return {
      id: "rbac",
      version: "1.0.0",
      depends_on: {},
      capabilities: { provides, requires: [] },
      entry_point: "index.ts",
    };
  }

  /** Load the real rbac plugin through the real broker/loader — this is what actually triggers `onEnable`, unlike most of this plugin's other tests. */
  async function loadRbac(): Promise<{
    check: RbacCheckCapability["check"];
    manage: RbacManagementApi;
  }> {
    const definitions: PluginDefinition[] = [
      { manifest: manifest(["rbac:check", "rbac:manage"]), module: rbacModule },
    ];
    const broker = createCapabilityBroker();

    const loadResult = await loadPlugins(definitions, broker);
    expect(isOk(loadResult)).toBe(true);
    if (!isOk(loadResult)) {
      throw new Error("expected rbac to load successfully");
    }
    expect(loadResult.value.failed).toEqual([]);

    return {
      check: (rbacModule.provides?.["rbac:check"] as RbacCheckCapability).check,
      manage: rbacModule.provides?.["rbac:manage"] as RbacManagementApi,
    };
  }

  beforeEach(() => {
    rbacModule.resetPolicyStoreForTests();
  });

  it("first run: loading the plugin with zero admins provisions a bootstrap admin that can immediately self-heal via rbac:manage", async () => {
    const reporter = createSpyReporter();
    const credential = await rbacModule.ensureRbacBootstrapAdmin(reporter);
    expect(credential).toBeDefined();
    expect(reporter.reported).toEqual([credential]);

    const { check, manage } = await loadRbac();
    // The bootstrap admin genuinely holds rbac:manage through the real,
    // unmodified check() — not a special-cased bypass.
    expect(check(credential!.userId, "manage", "rbac")).toBe(true);

    // And can prove it by actually performing a management operation that
    // would otherwise be denied to anyone (this is the exact lockout
    // scenario feature #40 exists to prevent).
    const role = await manage.createRole(credential!.userId, { id: "editor", name: "Editor" });
    expect(role).toEqual({ id: "editor", name: "Editor" });
  });

  it("already provisioned: a pre-existing real admin means onEnable does nothing and reports nothing", async () => {
    rbacModule.roleCatalog.set("admin", { id: "admin", name: "Administrator" });
    rbacModule.policyStore.userRoles.push({ userId: "real-operator", roleId: "admin" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "admin", permissionId: "rbac:manage" });

    const reporter = createSpyReporter();
    const credential = await rbacModule.ensureRbacBootstrapAdmin(reporter);

    expect(credential).toBeUndefined();
    expect(reporter.reported).toEqual([]);
    // Still just the one, pre-existing admin — no bootstrap account was added.
    expect(rbacModule.policyStore.userRoles).toEqual([
      { userId: "real-operator", roleId: "admin" },
    ]);
  });

  it("onEnable (via loadPlugins) itself provisions on first run, using the real console reporter", async () => {
    expect(rbacModule.policyStore.userRoles).toEqual([]);

    await loadRbac();

    const adminAssignments = rbacModule.policyStore.userRoles.filter(
      (userRole) => userRole.roleId === "admin",
    );
    expect(adminAssignments).toHaveLength(1);
  });

  it("the bootstrap path disables itself the moment an admin exists — loading the plugin twice never creates two bootstrap accounts", async () => {
    await loadRbac();
    const afterFirstLoad = rbacModule.policyStore.userRoles.filter(
      (userRole) => userRole.roleId === "admin",
    );
    expect(afterFirstLoad).toHaveLength(1);

    await loadRbac();
    const afterSecondLoad = rbacModule.policyStore.userRoles.filter(
      (userRole) => userRole.roleId === "admin",
    );
    expect(afterSecondLoad).toHaveLength(1);
  });
});
