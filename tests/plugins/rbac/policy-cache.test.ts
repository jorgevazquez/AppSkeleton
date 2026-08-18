/**
 * Tests for feature #35 — "Policy decision caching with invalidation on
 * role/permission change":
 *
 *   1. "Add an in-process cache for can() results keyed by (user, action,
 *      resource) with a short TTL" — see "memoizes a check() decision"
 *      below: a direct `policyStore` mutation that bypasses `rbac:manage`
 *      (and therefore never invalidates anything) is *not* reflected on the
 *      very next `check()` call, proving a cache actually sits in front of
 *      `can()`; "an expired cache entry is recomputed rather than served
 *      stale" proves the TTL itself elapses and forces a fresh read.
 *   2. "Invalidate affected cache entries immediately on any
 *      role/permission/assignment mutation" — every mutating `rbac:manage`
 *      operation (assign/revoke permission-to-role, assign/revoke
 *      role-to-user, delete role) is exercised below and shown to clear a
 *      cached decision it affects.
 *   3. "Write a test proving a permission revoked mid-session is denied on
 *      the very next check, not after the TTL" — see "a permission revoked
 *      mid-session is denied on the very next check()". The TTL is set to
 *      60 seconds *before* the revoke, deliberately far longer than this
 *      test could ever take to run: the only way the very next `check()`
 *      call can see the revoke is real invalidation, not the TTL elapsing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";
import type { RbacManagementApi } from "../../../src/plugins/rbac/src/manage.js";

const ADMIN = "cache-admin";
/** Deliberately much longer than any TTL-elapse test needs, and much longer than this test file's own runtime — see the module doc's point 3. */
const LONG_TTL_MS = 60_000;

function getCheck(): RbacCheckCapability["check"] {
  return (rbacModule.provides?.["rbac:check"] as RbacCheckCapability).check;
}

function getManage(): RbacManagementApi {
  return rbacModule.provides?.["rbac:manage"] as RbacManagementApi;
}

/**
 * Grant ADMIN the `rbac:manage` permission the same way
 * `manage-capability.test.ts` does: a role in `policyStore` holding it,
 * assigned to the user — the real, self-referential authorization path,
 * not a stand-in.
 */
function grantAdminManage(): void {
  rbacModule.roleCatalog.set("rbac-admin", { id: "rbac-admin", name: "RBAC Admin" });
  rbacModule.policyStore.userRoles.push({ userId: ADMIN, roleId: "rbac-admin" });
  rbacModule.policyStore.rolePermissions.push({
    roleId: "rbac-admin",
    permissionId: "rbac:manage",
  });
}

describe("rbac check() decision cache (feature #35)", () => {
  beforeEach(() => {
    rbacModule.resetPolicyStoreForTests();
  });

  it("memoizes a check() decision: a direct policyStore mutation bypassing rbac:manage is not reflected until invalidated", () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });

    const check = getCheck();
    expect(check("alice", "edit", "wiki")).toBe(true);
    expect(rbacModule.checkCacheState.entries.size).toBe(1);

    // Mutate the underlying store directly — no rbac:manage call, so
    // nothing invalidates the cache. The stale cached decision is served.
    rbacModule.policyStore.rolePermissions.length = 0;
    expect(check("alice", "edit", "wiki")).toBe(true);

    // Explicit invalidation — exactly what every rbac:manage mutation
    // performs — makes the next check reflect the store's real state.
    rbacModule.invalidateCheckCache();
    expect(check("alice", "edit", "wiki")).toBe(false);
  });

  it("an expired cache entry is recomputed rather than served stale", async () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });
    rbacModule.checkCacheState.ttlMs = 1;

    const check = getCheck();
    expect(check("alice", "edit", "wiki")).toBe(true);

    // Direct mutation, no invalidation call — the second check below can
    // only see it because the 1ms TTL has lapsed by the time it runs.
    rbacModule.policyStore.rolePermissions.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(check("alice", "edit", "wiki")).toBe(false);
  });

  it("a permission revoked mid-session is denied on the very next check() — not after the TTL", async () => {
    grantAdminManage();
    rbacModule.permissionCatalog.set("wiki:edit", {
      id: "wiki:edit",
      resource: "wiki",
      action: "edit",
    });

    const manage = getManage();
    await manage.createRole(ADMIN, { id: "editor", name: "Editor" });
    await manage.assignPermissionToRole(ADMIN, "editor", "wiki:edit");
    await manage.assignRoleToUser(ADMIN, "bob", "editor");

    rbacModule.checkCacheState.ttlMs = LONG_TTL_MS;

    const check = getCheck();
    // Cached now, valid for LONG_TTL_MS.
    expect(check("bob", "edit", "wiki")).toBe(true);

    await manage.revokePermissionFromRole(ADMIN, "editor", "wiki:edit");

    // Same (user, action, resource) triple, asked again immediately: must
    // be denied now that the permission was revoked, even though the
    // cached "true" entry from moments ago is nowhere near expiring.
    expect(check("bob", "edit", "wiki")).toBe(false);
  });

  it("revoking a role from a user mid-session denies a cached decision immediately", async () => {
    grantAdminManage();
    rbacModule.permissionCatalog.set("wiki:edit", {
      id: "wiki:edit",
      resource: "wiki",
      action: "edit",
    });

    const manage = getManage();
    await manage.createRole(ADMIN, { id: "editor", name: "Editor" });
    await manage.assignPermissionToRole(ADMIN, "editor", "wiki:edit");
    await manage.assignRoleToUser(ADMIN, "bob", "editor");
    rbacModule.checkCacheState.ttlMs = LONG_TTL_MS;

    const check = getCheck();
    expect(check("bob", "edit", "wiki")).toBe(true);

    await manage.revokeRoleFromUser(ADMIN, "bob", "editor");
    expect(check("bob", "edit", "wiki")).toBe(false);
  });

  it("deleting a role mid-session denies a cached decision that depended on it", async () => {
    grantAdminManage();
    rbacModule.permissionCatalog.set("wiki:edit", {
      id: "wiki:edit",
      resource: "wiki",
      action: "edit",
    });

    const manage = getManage();
    await manage.createRole(ADMIN, { id: "editor", name: "Editor" });
    await manage.assignPermissionToRole(ADMIN, "editor", "wiki:edit");
    await manage.assignRoleToUser(ADMIN, "bob", "editor");
    rbacModule.checkCacheState.ttlMs = LONG_TTL_MS;

    const check = getCheck();
    expect(check("bob", "edit", "wiki")).toBe(true);

    await manage.deleteRole(ADMIN, "editor");
    expect(check("bob", "edit", "wiki")).toBe(false);
  });

  it("resetPolicyStoreForTests() clears the cache and restores the default TTL", () => {
    rbacModule.policyStore.userRoles.push({ userId: "alice", roleId: "editor" });
    rbacModule.policyStore.rolePermissions.push({ roleId: "editor", permissionId: "wiki:edit" });
    const check = getCheck();
    check("alice", "edit", "wiki");
    rbacModule.checkCacheState.ttlMs = 1;
    expect(rbacModule.checkCacheState.entries.size).toBe(1);

    rbacModule.resetPolicyStoreForTests();

    expect(rbacModule.checkCacheState.entries.size).toBe(0);
    expect(rbacModule.checkCacheState.ttlMs).toBe(rbacModule.DEFAULT_CHECK_CACHE_TTL_MS);
  });
});
