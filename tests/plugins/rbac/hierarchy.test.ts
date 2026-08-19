import { describe, expect, it } from "vitest";
import {
  addRoleParent,
  resolveAncestorRoleIds,
  wouldCreateCycle,
} from "../../../src/plugins/rbac/src/hierarchy.js";
import { ValidationError } from "../../../src/core/errors.js";
import type { RoleHierarchy } from "../../../src/plugins/rbac/src/types.js";

describe("resolveAncestorRoleIds()", () => {
  it("returns an empty set for a role with no parents", () => {
    expect(resolveAncestorRoleIds([], "wiki-editor")).toEqual(new Set());
  });

  it("resolves a single direct parent (2-level hierarchy)", () => {
    const edges: RoleHierarchy[] = [{ roleId: "wiki-editor", parentRoleId: "viewer" }];
    expect(resolveAncestorRoleIds(edges, "wiki-editor")).toEqual(new Set(["viewer"]));
  });

  it("resolves a multi-level chain transitively (A <- B <- C)", () => {
    const edges: RoleHierarchy[] = [
      { roleId: "senior-editor", parentRoleId: "wiki-editor" },
      { roleId: "wiki-editor", parentRoleId: "viewer" },
    ];
    expect(resolveAncestorRoleIds(edges, "senior-editor")).toEqual(
      new Set(["wiki-editor", "viewer"]),
    );
  });

  it("resolves multiple parents on the same role (additive)", () => {
    const edges: RoleHierarchy[] = [
      { roleId: "moderator", parentRoleId: "commenter" },
      { roleId: "moderator", parentRoleId: "viewer" },
    ];
    expect(resolveAncestorRoleIds(edges, "moderator")).toEqual(new Set(["commenter", "viewer"]));
  });

  it("never includes the role itself", () => {
    const edges: RoleHierarchy[] = [{ roleId: "wiki-editor", parentRoleId: "viewer" }];
    expect(resolveAncestorRoleIds(edges, "wiki-editor").has("wiki-editor")).toBe(false);
  });

  it("terminates and returns a correct result even if the stored data already contains a cycle", () => {
    // Simulates hand-seeded/fixture data that bypassed addRoleParent's
    // cycle guard — resolution must still not hang or stack-overflow.
    const edges: RoleHierarchy[] = [
      { roleId: "a", parentRoleId: "b" },
      { roleId: "b", parentRoleId: "a" },
    ];
    expect(resolveAncestorRoleIds(edges, "a")).toEqual(new Set(["b"]));
  });
});

describe("wouldCreateCycle()", () => {
  it("is true for a direct self-reference", () => {
    expect(wouldCreateCycle([], "wiki-editor", "wiki-editor")).toBe(true);
  });

  it("is false for a fresh, unrelated edge", () => {
    expect(wouldCreateCycle([], "wiki-editor", "viewer")).toBe(false);
  });

  it("is true for a direct 2-cycle (A already parents B, adding B parents A)", () => {
    const edges: RoleHierarchy[] = [{ roleId: "b", parentRoleId: "a" }];
    expect(wouldCreateCycle(edges, "a", "b")).toBe(true);
  });

  it("is true for an indirect cycle through a longer chain (b's parent is a, c's parent is b, adding a's parent as c)", () => {
    const edges: RoleHierarchy[] = [
      { roleId: "b", parentRoleId: "a" },
      { roleId: "c", parentRoleId: "b" },
    ];
    // a -> c -> b -> a would close the loop.
    expect(wouldCreateCycle(edges, "a", "c")).toBe(true);
  });

  it("is false for a new edge that shares an ancestor but does not loop back", () => {
    const edges: RoleHierarchy[] = [{ roleId: "b", parentRoleId: "a" }];
    // "c" inheriting from "a" too is a diamond, not a cycle.
    expect(wouldCreateCycle(edges, "c", "a")).toBe(false);
  });
});

describe("addRoleParent()", () => {
  it("adds a valid edge to the array in place", () => {
    const edges: RoleHierarchy[] = [];
    addRoleParent(edges, "wiki-editor", "viewer");
    expect(edges).toEqual([{ roleId: "wiki-editor", parentRoleId: "viewer" }]);
  });

  it("rejects a direct self-reference and does not mutate the array", () => {
    const edges: RoleHierarchy[] = [];
    expect(() => addRoleParent(edges, "wiki-editor", "wiki-editor")).toThrow(ValidationError);
    expect(edges).toEqual([]);
  });

  it("rejects an edge that would create an indirect cycle and does not mutate the array", () => {
    const edges: RoleHierarchy[] = [
      { roleId: "wiki-editor", parentRoleId: "viewer" },
      { roleId: "senior-editor", parentRoleId: "wiki-editor" },
    ];
    // "viewer" already transitively inherits nothing from "senior-editor";
    // making "viewer" inherit from "senior-editor" would close the loop
    // viewer -> senior-editor -> wiki-editor -> viewer.
    expect(() => addRoleParent(edges, "viewer", "senior-editor")).toThrow(ValidationError);
    expect(edges).toHaveLength(2);
  });

  it("rejects re-adding an already-present edge", () => {
    const edges: RoleHierarchy[] = [{ roleId: "wiki-editor", parentRoleId: "viewer" }];
    expect(() => addRoleParent(edges, "wiki-editor", "viewer")).toThrow(ValidationError);
    expect(edges).toHaveLength(1);
  });

  it("allows a role to have multiple distinct parents", () => {
    const edges: RoleHierarchy[] = [];
    addRoleParent(edges, "moderator", "commenter");
    addRoleParent(edges, "moderator", "viewer");
    expect(edges).toEqual([
      { roleId: "moderator", parentRoleId: "commenter" },
      { roleId: "moderator", parentRoleId: "viewer" },
    ]);
  });
});
