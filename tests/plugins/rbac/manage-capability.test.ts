/**
 * Wiring-level tests for feature #36's `rbac:manage` capability
 * (`src/plugins/rbac/index.ts`'s `provides["rbac:manage"]`) — proves the
 * real in-memory adapter (`createInMemoryManagementStore`, over the same
 * `policyStore`/`roleCatalog`/`permissionCatalog` module state `check()`
 * itself reads) is actually wired up, and that the self-referential
 * authorization gate is powered by this plugin's own real `check()`, not a
 * stand-in. `manage.test.ts` covers the business logic (`createRbacManagementApi`)
 * in isolation with fakes; this file covers the concrete wiring those unit
 * tests can't see.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityDeniedError } from "../../../src/core/errors.js";
import * as rbacModule from "../../../src/plugins/rbac/index.js";
import type { RbacManagementApi } from "../../../src/plugins/rbac/src/manage.js";

const ADMIN = "admin-alice";
const OUTSIDER = "outsider-oscar";

function getManage(): RbacManagementApi {
  return rbacModule.provides?.["rbac:manage"] as RbacManagementApi;
}

describe("rbac:manage — wiring (feature #36)", () => {
  beforeEach(() => {
    rbacModule.resetPolicyStoreForTests();
  });

  it("is exported under provides alongside rbac:check", () => {
    expect(rbacModule.provides).toBeDefined();
    expect(typeof getManage().createRole).toBe("function");
    expect(typeof rbacModule.provides?.["rbac:check"]).toBe("object");
  });

  it("denies a caller with no roles at all — even role/permission management is deny-by-default", async () => {
    await expect(
      getManage().createRole(OUTSIDER, { id: "editor", name: "Editor" }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("a caller holding rbac:manage (via the real policyStore/check()) can manage roles, and the change is visible on the very next check()", async () => {
    // Grant ADMIN the rbac:manage permission the same way any other
    // permission is granted: a role in policyStore holding it, assigned to
    // the user — this *is* the self-referential check feature #36 asks
    // for, exercised through the plugin's real, unmodified check().
    rbacModule.roleCatalog.set("rbac-admin", { id: "rbac-admin", name: "RBAC Admin" });
    rbacModule.policyStore.userRoles.push({ userId: ADMIN, roleId: "rbac-admin" });
    rbacModule.policyStore.rolePermissions.push({
      roleId: "rbac-admin",
      permissionId: "rbac:manage",
    });

    const manage = getManage();
    const role = await manage.createRole(ADMIN, { id: "editor", name: "Editor" });
    expect(role).toEqual({ id: "editor", name: "Editor" });

    rbacModule.permissionCatalog.set("wiki:edit", {
      id: "wiki:edit",
      resource: "wiki",
      action: "edit",
    });
    await manage.assignPermissionToRole(ADMIN, "editor", "wiki:edit");
    await manage.assignRoleToUser(ADMIN, "bob", "editor");

    // No caching layer in front of check() yet (feature #35) — the
    // assignment just made is visible immediately.
    const check = (rbacModule.provides?.["rbac:check"] as { check: RbacCheckFn }).check;
    expect(check("bob", "edit", "wiki")).toBe(true);
    expect(check("bob", "delete", "wiki")).toBe(false);

    await manage.revokeRoleFromUser(ADMIN, "bob", "editor");
    expect(check("bob", "edit", "wiki")).toBe(false);
  });

  it("resetPolicyStoreForTests() also clears roleCatalog/permissionCatalog", async () => {
    rbacModule.roleCatalog.set("stale-role", { id: "stale-role", name: "Stale" });
    rbacModule.permissionCatalog.set("wiki:edit", {
      id: "wiki:edit",
      resource: "wiki",
      action: "edit",
    });

    rbacModule.resetPolicyStoreForTests();

    expect(rbacModule.roleCatalog.size).toBe(0);
    expect(rbacModule.permissionCatalog.size).toBe(0);
  });
});

type RbacCheckFn = (userId: string, action: string, resource: string) => boolean;
