import { describe, expect, it } from "vitest";
import { can, matchesPermission, type PolicyStore } from "../../../src/plugins/rbac/src/policy.js";
import type { RolePermission, UserRole } from "../../../src/plugins/rbac/src/types.js";

function store(userRoles: UserRole[], rolePermissions: RolePermission[]): PolicyStore {
  return { userRoles, rolePermissions };
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
