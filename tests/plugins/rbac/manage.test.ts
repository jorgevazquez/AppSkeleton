/**
 * Unit tests for feature #36 — "Role and permission management operations
 * (create/update/delete role, assign/revoke permission and role)".
 *
 * Exercises `createRbacManagementApi` (`src/plugins/rbac/src/manage.ts`)
 * directly, against a hand-rolled in-memory {@link RbacManagementStore}
 * fake and a controllable {@link RbacManageAuthorizer} fake — no broker,
 * no loader, no MySQL. This is deliberate: `manage.ts`'s whole point (see
 * its own module docs) is to be a plain, storage-agnostic, directly
 * callable API, so its tests exercise it exactly that way.
 *
 * Covers all three of this feature's steps:
 *   1. Every operation is a typed async function, called directly here.
 *   2. Every operation is gated on the caller already holding
 *      `rbac:manage` (self-referential — see "denies every operation for
 *      an unauthorized caller" below), verified both by the thrown error
 *      *and* by asserting the store was never mutated.
 *   3. Failure paths: duplicate role name (createRole/updateRole) and
 *      assigning a nonexistent permission, plus not-found roles and
 *      already-existing assignments.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityDeniedError, NotFoundError, ValidationError } from "../../../src/core/errors.js";
import {
  createRbacManagementApi,
  type RbacManageAuthorizer,
  type RbacManagementApi,
  type RbacManagementStore,
} from "../../../src/plugins/rbac/src/manage.js";
import type {
  Permission,
  Role,
  RolePermission,
  UserRole,
} from "../../../src/plugins/rbac/src/types.js";

const ADMIN = "admin-alice";
const OUTSIDER = "outsider-oscar";

/** A plain in-memory `RbacManagementStore` fake — a real Map/array store, not a mock framework double, so assertions read as ordinary state checks. */
function createFakeStore(): RbacManagementStore & {
  roles: Map<string, Role>;
  permissions: Map<string, Permission>;
  rolePermissions: RolePermission[];
  userRoles: UserRole[];
} {
  const roles = new Map<string, Role>();
  const permissions = new Map<string, Permission>();
  const rolePermissions: RolePermission[] = [];
  const userRoles: UserRole[] = [];

  return {
    roles,
    permissions,
    rolePermissions,
    userRoles,

    async getRole(id) {
      return roles.get(id);
    },
    async listRoles() {
      return Array.from(roles.values());
    },
    async createRole(role) {
      if (roles.has(role.id)) {
        throw new ValidationError(`Role "${role.id}" already exists.`, {
          details: { roleId: role.id },
        });
      }
      roles.set(role.id, role);
    },
    async updateRole(id, changes) {
      const existing = roles.get(id);
      if (!existing) {
        throw new NotFoundError(`Role "${id}" does not exist.`, { details: { roleId: id } });
      }
      const name = changes.name ?? existing.name;
      const description =
        "description" in changes ? (changes.description ?? undefined) : existing.description;
      const updated: Role = description === undefined ? { id, name } : { id, name, description };
      roles.set(id, updated);
      return updated;
    },
    async deleteRole(id) {
      roles.delete(id);
    },
    async getPermission(id) {
      return permissions.get(id);
    },
    async assignPermissionToRole(roleId, permissionId) {
      rolePermissions.push({ roleId, permissionId });
    },
    async revokePermissionFromRole(roleId, permissionId) {
      const index = rolePermissions.findIndex(
        (grant) => grant.roleId === roleId && grant.permissionId === permissionId,
      );
      if (index !== -1) {
        rolePermissions.splice(index, 1);
      }
    },
    async assignRoleToUser(userId, roleId) {
      userRoles.push({ userId, roleId });
    },
    async revokeRoleFromUser(userId, roleId) {
      const index = userRoles.findIndex(
        (assignment) => assignment.userId === userId && assignment.roleId === roleId,
      );
      if (index !== -1) {
        userRoles.splice(index, 1);
      }
    },
  };
}

/** An authorizer that grants `rbac:manage` to exactly the callers listed in `authorized`. */
function createFakeAuthorizer(authorized: readonly string[]): RbacManageAuthorizer {
  return {
    check(callerId, action, resource) {
      return action === "manage" && resource === "rbac" && authorized.includes(callerId);
    },
  };
}

let store: ReturnType<typeof createFakeStore>;
let api: RbacManagementApi;

beforeEach(() => {
  store = createFakeStore();
  api = createRbacManagementApi(store, createFakeAuthorizer([ADMIN]));
});

describe("rbac role/permission management API (feature #36)", () => {
  describe("self-referential authorization (step 2)", () => {
    it("denies every operation for a caller who does not hold rbac:manage, without mutating the store", async () => {
      store.roles.set("editor", { id: "editor", name: "Editor" });
      store.permissions.set("wiki:edit", { id: "wiki:edit", resource: "wiki", action: "edit" });

      await expect(api.listRoles(OUTSIDER)).rejects.toBeInstanceOf(CapabilityDeniedError);
      await expect(
        api.createRole(OUTSIDER, { id: "viewer", name: "Viewer" }),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      await expect(api.updateRole(OUTSIDER, "editor", { name: "Renamed" })).rejects.toBeInstanceOf(
        CapabilityDeniedError,
      );
      await expect(api.deleteRole(OUTSIDER, "editor")).rejects.toBeInstanceOf(
        CapabilityDeniedError,
      );
      await expect(
        api.assignPermissionToRole(OUTSIDER, "editor", "wiki:edit"),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      await expect(
        api.revokePermissionFromRole(OUTSIDER, "editor", "wiki:edit"),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      await expect(api.assignRoleToUser(OUTSIDER, "alice", "editor")).rejects.toBeInstanceOf(
        CapabilityDeniedError,
      );
      await expect(api.revokeRoleFromUser(OUTSIDER, "alice", "editor")).rejects.toBeInstanceOf(
        CapabilityDeniedError,
      );

      // Nothing was mutated by any of the denied calls above.
      expect(store.roles.size).toBe(1);
      expect(store.roles.get("editor")).toEqual({ id: "editor", name: "Editor" });
      expect(store.rolePermissions).toEqual([]);
      expect(store.userRoles).toEqual([]);
    });

    it("the denial names the rbac:manage capability and the denied caller", async () => {
      const caught = await api
        .createRole(OUTSIDER, { id: "viewer", name: "Viewer" })
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(CapabilityDeniedError);
      const error = caught as CapabilityDeniedError;
      expect(error.code).toBe("CAPABILITY_DENIED");
      expect(error.details).toMatchObject({ capabilityId: "rbac:manage", callerId: OUTSIDER });
    });

    it("allows every operation for a caller who does hold rbac:manage", async () => {
      const role = await api.createRole(ADMIN, { id: "editor", name: "Editor" });
      expect(role).toEqual({ id: "editor", name: "Editor" });
      expect(store.roles.get("editor")).toEqual(role);
    });
  });

  describe("listRoles (feature #44, step 1 — 'list roles')", () => {
    it("returns every currently-defined role for an authorized caller", async () => {
      await expect(api.listRoles(ADMIN)).resolves.toEqual([]);

      await api.createRole(ADMIN, { id: "editor", name: "Editor" });
      await api.createRole(ADMIN, { id: "viewer", name: "Viewer" });

      const roles = await api.listRoles(ADMIN);
      expect(roles).toEqual(
        expect.arrayContaining([
          { id: "editor", name: "Editor" },
          { id: "viewer", name: "Viewer" },
        ]),
      );
      expect(roles).toHaveLength(2);
    });
  });

  describe("createRole", () => {
    it("creates a role with an optional description", async () => {
      const role = await api.createRole(ADMIN, {
        id: "wiki-editor",
        name: "Wiki Editor",
        description: "Can edit wiki pages",
      });
      expect(role).toEqual({
        id: "wiki-editor",
        name: "Wiki Editor",
        description: "Can edit wiki pages",
      });
    });

    it("rejects a duplicate role name (failure path required by step 3)", async () => {
      await api.createRole(ADMIN, { id: "editor", name: "Editor" });

      const caught = await api
        .createRole(ADMIN, { id: "editor-2", name: "Editor" })
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ValidationError);
      const error = caught as ValidationError;
      expect(error.details).toMatchObject({ name: "Editor", conflictingRoleId: "editor" });

      // The rejected role was never persisted.
      expect(store.roles.has("editor-2")).toBe(false);
      expect(store.roles.size).toBe(1);
    });

    it("allows two different roles to share the same id-adjacent but distinct name only if actually distinct", async () => {
      await api.createRole(ADMIN, { id: "editor", name: "Editor" });
      await expect(api.createRole(ADMIN, { id: "viewer", name: "Viewer" })).resolves.toEqual({
        id: "viewer",
        name: "Viewer",
      });
    });

    it("propagates a duplicate role id from the store unchanged (primary-key collision is the store's concern, not this module's)", async () => {
      await api.createRole(ADMIN, { id: "editor", name: "Editor" });
      await expect(
        api.createRole(ADMIN, { id: "editor", name: "A Totally Different Name" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("updateRole", () => {
    beforeEach(async () => {
      await api.createRole(ADMIN, { id: "editor", name: "Editor" });
      await api.createRole(ADMIN, { id: "viewer", name: "Viewer" });
    });

    it("updates a role's name", async () => {
      const updated = await api.updateRole(ADMIN, "editor", { name: "Senior Editor" });
      expect(updated).toEqual({ id: "editor", name: "Senior Editor" });
    });

    it("updates a role's description, and clears it with an explicit null", async () => {
      await api.updateRole(ADMIN, "editor", { description: "Edits things" });
      expect(store.roles.get("editor")).toEqual({
        id: "editor",
        name: "Editor",
        description: "Edits things",
      });

      await api.updateRole(ADMIN, "editor", { description: null });
      expect(store.roles.get("editor")).toEqual({ id: "editor", name: "Editor" });
    });

    it("throws NotFoundError for a role id that does not exist", async () => {
      await expect(api.updateRole(ADMIN, "no-such-role", { name: "X" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("rejects renaming a role to a name already used by a different role (duplicate name failure path)", async () => {
      const caught = await api
        .updateRole(ADMIN, "viewer", { name: "Editor" })
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).details).toMatchObject({
        name: "Editor",
        conflictingRoleId: "editor",
      });
      // Unchanged.
      expect(store.roles.get("viewer")).toEqual({ id: "viewer", name: "Viewer" });
    });

    it("allows updating a role to keep its own current name (not a self-conflict)", async () => {
      await expect(api.updateRole(ADMIN, "editor", { name: "Editor" })).resolves.toEqual({
        id: "editor",
        name: "Editor",
      });
    });
  });

  describe("deleteRole", () => {
    it("deletes an existing role", async () => {
      await api.createRole(ADMIN, { id: "editor", name: "Editor" });
      await api.deleteRole(ADMIN, "editor");
      expect(store.roles.has("editor")).toBe(false);
    });

    it("throws NotFoundError for a role id that does not exist", async () => {
      await expect(api.deleteRole(ADMIN, "no-such-role")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("assignPermissionToRole / revokePermissionFromRole", () => {
    beforeEach(async () => {
      await api.createRole(ADMIN, { id: "editor", name: "Editor" });
      store.permissions.set("wiki:edit", { id: "wiki:edit", resource: "wiki", action: "edit" });
    });

    it("assigns an existing permission to an existing role", async () => {
      await api.assignPermissionToRole(ADMIN, "editor", "wiki:edit");
      expect(store.rolePermissions).toEqual([{ roleId: "editor", permissionId: "wiki:edit" }]);
    });

    it("rejects assigning a nonexistent permission (failure path required by step 3)", async () => {
      const caught = await api
        .assignPermissionToRole(ADMIN, "editor", "wiki:delete")
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).details).toMatchObject({ permissionId: "wiki:delete" });

      // No dangling grant was created.
      expect(store.rolePermissions).toEqual([]);
    });

    it("rejects assigning a permission to a role that does not exist", async () => {
      await expect(
        api.assignPermissionToRole(ADMIN, "no-such-role", "wiki:edit"),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(store.rolePermissions).toEqual([]);
    });

    it("revokes a previously assigned permission", async () => {
      await api.assignPermissionToRole(ADMIN, "editor", "wiki:edit");
      await api.revokePermissionFromRole(ADMIN, "editor", "wiki:edit");
      expect(store.rolePermissions).toEqual([]);
    });

    it("revoking a grant that was never assigned is a harmless no-op", async () => {
      await expect(
        api.revokePermissionFromRole(ADMIN, "editor", "wiki:edit"),
      ).resolves.toBeUndefined();
      expect(store.rolePermissions).toEqual([]);
    });
  });

  describe("assignRoleToUser / revokeRoleFromUser", () => {
    beforeEach(async () => {
      await api.createRole(ADMIN, { id: "editor", name: "Editor" });
    });

    it("assigns an existing role to a user", async () => {
      await api.assignRoleToUser(ADMIN, "alice", "editor");
      expect(store.userRoles).toEqual([{ userId: "alice", roleId: "editor" }]);
    });

    it("rejects assigning a role that does not exist to a user", async () => {
      await expect(api.assignRoleToUser(ADMIN, "alice", "no-such-role")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(store.userRoles).toEqual([]);
    });

    it("revokes a previously assigned role from a user", async () => {
      await api.assignRoleToUser(ADMIN, "alice", "editor");
      await api.revokeRoleFromUser(ADMIN, "alice", "editor");
      expect(store.userRoles).toEqual([]);
    });

    it("revoking a role assignment that never existed is a harmless no-op", async () => {
      await expect(api.revokeRoleFromUser(ADMIN, "alice", "editor")).resolves.toBeUndefined();
      expect(store.userRoles).toEqual([]);
    });
  });
});
