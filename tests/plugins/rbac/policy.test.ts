import { describe, expect, it } from "vitest";
import { addRoleParent } from "../../../src/plugins/rbac/src/hierarchy.js";
import { can, matchesPermission, type PolicyStore } from "../../../src/plugins/rbac/src/policy.js";
import type {
  RoleHierarchy,
  RolePermission,
  UserRole,
} from "../../../src/plugins/rbac/src/types.js";
import { ValidationError } from "../../../src/core/errors.js";

function store(
  userRoles: UserRole[],
  rolePermissions: RolePermission[],
  roleParents: readonly RoleHierarchy[] = [],
): PolicyStore {
  return { userRoles, rolePermissions, roleParents };
}

describe("can() — allow", () => {
  it("allows when the user's role holds the exact resource:action permission", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-editor" }],
      [{ roleId: "wiki-editor", permissionId: "wiki:read" }],
    );

    expect(can(s, "alice", "read", "wiki")).toBe(true);
  });

  it("allows when any one of several roles grants unrelated permissions plus the needed one", () => {
    const s = store(
      [
        { userId: "alice", roleId: "viewer" },
        { userId: "alice", roleId: "wiki-editor" },
      ],
      [
        { roleId: "viewer", permissionId: "page:read" },
        { roleId: "wiki-editor", permissionId: "wiki:read" },
        { roleId: "wiki-editor", permissionId: "wiki:edit" },
      ],
    );

    expect(can(s, "alice", "edit", "wiki")).toBe(true);
  });
});

describe("can() — deny-by-default", () => {
  it("denies a user with no role assignments at all", () => {
    const s = store([], []);
    expect(can(s, "alice", "read", "wiki")).toBe(false);
  });

  it("denies an unknown user id not present in any user-role association", () => {
    const s = store(
      [{ userId: "bob", roleId: "wiki-editor" }],
      [{ roleId: "wiki-editor", permissionId: "wiki:read" }],
    );
    expect(can(s, "alice", "read", "wiki")).toBe(false);
  });

  it("denies when the user's role has permissions but none matching the requested action/resource", () => {
    const s = store(
      [{ userId: "alice", roleId: "viewer" }],
      [{ roleId: "viewer", permissionId: "page:read" }],
    );
    expect(can(s, "alice", "delete", "wiki")).toBe(false);
  });

  it("denies when a role is assigned to the user but has no rows in rolePermissions at all", () => {
    const s = store([{ userId: "alice", roleId: "ghost-role" }], []);
    expect(can(s, "alice", "read", "wiki")).toBe(false);
  });

  it("denies same resource, different action even when the exact action exists on a different resource", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-editor" }],
      [{ roleId: "wiki-editor", permissionId: "wiki:read" }],
    );
    expect(can(s, "alice", "read", "page")).toBe(false);
  });
});

describe("can() — wildcard match", () => {
  it("allows any action on the resource when the role holds the resource:* wildcard", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-admin" }],
      [{ roleId: "wiki-admin", permissionId: "wiki:*" }],
    );

    expect(can(s, "alice", "read", "wiki")).toBe(true);
    expect(can(s, "alice", "edit", "wiki")).toBe(true);
    expect(can(s, "alice", "delete", "wiki")).toBe(true);
  });

  it("does not let a resource wildcard leak into a different resource", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-admin" }],
      [{ roleId: "wiki-admin", permissionId: "wiki:*" }],
    );

    expect(can(s, "alice", "read", "page")).toBe(false);
  });

  it("combines an exact match on one resource with a wildcard on another across roles", () => {
    const s = store(
      [
        { userId: "alice", roleId: "page-viewer" },
        { userId: "alice", roleId: "wiki-admin" },
      ],
      [
        { roleId: "page-viewer", permissionId: "page:read" },
        { roleId: "wiki-admin", permissionId: "wiki:*" },
      ],
    );

    expect(can(s, "alice", "read", "page")).toBe(true);
    expect(can(s, "alice", "delete", "wiki")).toBe(true);
    expect(can(s, "alice", "delete", "page")).toBe(false);
  });
});

describe("can() — conflicting-role scenarios", () => {
  it("allows when one of two conflicting roles grants and the other does not (additive union, most-permissive wins)", () => {
    const s = store(
      [
        { userId: "alice", roleId: "viewer" },
        { userId: "alice", roleId: "wiki-editor" },
      ],
      [
        { roleId: "viewer", permissionId: "wiki:read" },
        // "wiki-editor" grants nothing for wiki:delete — viewer doesn't
        // either, but wiki-editor's presence must not narrow what viewer
        // already grants.
      ],
    );

    expect(can(s, "alice", "read", "wiki")).toBe(true);
  });

  it("denies when none of several assigned roles grant the requested permission", () => {
    const s = store(
      [
        { userId: "alice", roleId: "viewer" },
        { userId: "alice", roleId: "commenter" },
      ],
      [
        { roleId: "viewer", permissionId: "wiki:read" },
        { roleId: "commenter", permissionId: "wiki:comment" },
      ],
    );

    expect(can(s, "alice", "delete", "wiki")).toBe(false);
  });

  it("a wildcard-granting role wins over a sibling role that only has narrower exact permissions", () => {
    const s = store(
      [
        { userId: "alice", roleId: "viewer" },
        { userId: "alice", roleId: "wiki-admin" },
      ],
      [
        { roleId: "viewer", permissionId: "wiki:read" },
        { roleId: "wiki-admin", permissionId: "wiki:*" },
      ],
    );

    expect(can(s, "alice", "purge", "wiki")).toBe(true);
  });
});

describe("can() — role hierarchy / inheritance", () => {
  it("allows via a 2-level hierarchy: user holds the child role, permission is granted only to the parent role", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-editor" }],
      [{ roleId: "viewer", permissionId: "wiki:read" }],
      [{ roleId: "wiki-editor", parentRoleId: "viewer" }],
    );

    expect(can(s, "alice", "read", "wiki")).toBe(true);
  });

  it("still denies a permission neither the child role nor its parent grants", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-editor" }],
      [{ roleId: "viewer", permissionId: "wiki:read" }],
      [{ roleId: "wiki-editor", parentRoleId: "viewer" }],
    );

    expect(can(s, "alice", "delete", "wiki")).toBe(false);
  });

  it("inheriting from a parent is additive — the child role's own direct grants still apply", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-editor" }],
      [
        { roleId: "viewer", permissionId: "wiki:read" },
        { roleId: "wiki-editor", permissionId: "wiki:edit" },
      ],
      [{ roleId: "wiki-editor", parentRoleId: "viewer" }],
    );

    expect(can(s, "alice", "read", "wiki")).toBe(true);
    expect(can(s, "alice", "edit", "wiki")).toBe(true);
  });

  it("resolves a multi-level chain transitively, not just the immediate parent", () => {
    const s = store(
      [{ userId: "alice", roleId: "senior-editor" }],
      [{ roleId: "viewer", permissionId: "wiki:read" }],
      [
        { roleId: "senior-editor", parentRoleId: "wiki-editor" },
        { roleId: "wiki-editor", parentRoleId: "viewer" },
      ],
    );

    expect(can(s, "alice", "read", "wiki")).toBe(true);
  });

  it("a wildcard grant on a parent role is inherited too", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-editor" }],
      [{ roleId: "wiki-admin", permissionId: "wiki:*" }],
      [{ roleId: "wiki-editor", parentRoleId: "wiki-admin" }],
    );

    expect(can(s, "alice", "purge", "wiki")).toBe(true);
  });

  it("does not grant a permission held only by an unrelated role that is not an ancestor", () => {
    const s = store(
      [{ userId: "alice", roleId: "wiki-editor" }],
      [{ roleId: "commenter", permissionId: "wiki:comment" }],
      [{ roleId: "wiki-editor", parentRoleId: "viewer" }],
    );

    expect(can(s, "alice", "comment", "wiki")).toBe(false);
  });

  it("rejects a cyclic hierarchy at construction time via addRoleParent, instead of letting can() ever see it", () => {
    const roleParents: RoleHierarchy[] = [{ roleId: "wiki-editor", parentRoleId: "viewer" }];
    addRoleParent(roleParents, "senior-editor", "wiki-editor");

    // viewer -> senior-editor would close the loop
    // viewer -> senior-editor -> wiki-editor -> viewer.
    expect(() => addRoleParent(roleParents, "viewer", "senior-editor")).toThrow(ValidationError);
    // A direct self-reference is rejected the same way.
    expect(() => addRoleParent(roleParents, "wiki-editor", "wiki-editor")).toThrow(ValidationError);

    // The rejected edges never entered the store, so resolution is
    // unaffected and still reflects only the valid 3-level chain.
    const s = store(
      [{ userId: "alice", roleId: "senior-editor" }],
      [{ roleId: "viewer", permissionId: "wiki:read" }],
      roleParents,
    );
    expect(can(s, "alice", "read", "wiki")).toBe(true);
  });

  it("can() still terminates and produces a sane result if a cyclic hierarchy is hand-seeded directly (bypassing addRoleParent)", () => {
    const s = store(
      [{ userId: "alice", roleId: "a" }],
      [{ roleId: "b", permissionId: "wiki:read" }],
      [
        { roleId: "a", parentRoleId: "b" },
        { roleId: "b", parentRoleId: "a" },
      ],
    );

    expect(can(s, "alice", "read", "wiki")).toBe(true);
    expect(can(s, "alice", "delete", "wiki")).toBe(false);
  });
});

describe("matchesPermission()", () => {
  it("matches an exact resource:action grant", () => {
    expect(matchesPermission("wiki:read", "wiki", "read")).toBe(true);
  });

  it("does not match a different action", () => {
    expect(matchesPermission("wiki:read", "wiki", "edit")).toBe(false);
  });

  it("does not match a different resource", () => {
    expect(matchesPermission("wiki:read", "page", "read")).toBe(false);
  });

  it("matches any action via a resource:* wildcard", () => {
    expect(matchesPermission("wiki:*", "wiki", "anything")).toBe(true);
  });

  it("does not let a resource:* wildcard match a different resource", () => {
    expect(matchesPermission("wiki:*", "page", "read")).toBe(false);
  });

  it("returns false (never throws) for a malformed granted permission string", () => {
    expect(matchesPermission("not-a-permission", "wiki", "read")).toBe(false);
    expect(matchesPermission("", "wiki", "read")).toBe(false);
    expect(matchesPermission("wiki:read:extra", "wiki", "read")).toBe(false);
  });
});
