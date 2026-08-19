/**
 * Unit tests for `access.ts` (feature #93, step 1 — "Define the wiki:
 * permission grammar ... and apply rbac:check on every mutating and
 * restricted-read operation"). Exercises `wikiNamespaceResource`,
 * `checkWikiAccess`, and `assertWikiAccess` against a hand-rolled fake
 * `RbacCheckCapability` (a plain `Map`-backed allow-list) — no real `rbac`
 * plugin/policy engine involved here, that cross-plugin proof lives in
 * `authorized-store.integration.test.ts` instead. This file only proves
 * this module's own resolution logic (namespace-scoped-first,
 * global-default-fallback; the 401-vs-403 split) is correct for whatever
 * `rbac:check` happens to say.
 */
import { describe, expect, it } from "vitest";
import { AuthenticationError, AuthorizationError } from "../../../src/core/errors.js";
import {
  WIKI_RESOURCE,
  assertWikiAccess,
  checkWikiAccess,
  wikiNamespaceResource,
  type WikiAction,
} from "../../../src/plugins/wiki/src/access.js";
import type { RbacCheckCapability } from "../../../src/plugins/rbac/index.js";

/**
 * A fake `rbac:check` backed by an explicit `(userId, action, resource)`
 * allow-list — deliberately not the real `can()` policy engine, so these
 * tests can assert on exactly which `(action, resource)` pairs
 * `checkWikiAccess`/`assertWikiAccess` ask about, in what order.
 */
function fakeRbacCheck(allowed: ReadonlyArray<readonly [string, string, string]>) {
  const calls: Array<readonly [string, string, string]> = [];
  const check: RbacCheckCapability["check"] = (userId, action, resource) => {
    calls.push([userId, action, resource]);
    return allowed.some(([u, a, r]) => u === userId && a === action && r === resource);
  };
  return { check, calls } satisfies { check: RbacCheckCapability["check"]; calls: unknown };
}

describe("wikiNamespaceResource", () => {
  it("joins the namespace id onto the wiki resource with a hyphen, not a colon", () => {
    expect(wikiNamespaceResource("engineering")).toBe("wiki-engineering");
  });
});

describe("checkWikiAccess", () => {
  it("grants access via the global wiki:<action> default when no namespace override exists", () => {
    const rbac = fakeRbacCheck([["alice", "read", WIKI_RESOURCE]]);
    expect(checkWikiAccess(rbac, "alice", "read")).toBe(true);
  });

  it("denies by default when neither a namespace-scoped nor the global permission is granted", () => {
    const rbac = fakeRbacCheck([]);
    expect(checkWikiAccess(rbac, "alice", "read")).toBe(false);
  });

  it("grants access via a namespace-scoped override even when the global default denies", () => {
    const rbac = fakeRbacCheck([["alice", "write", "wiki-engineering"]]);
    expect(checkWikiAccess(rbac, "alice", "write", "engineering")).toBe(true);
    // The override is scoped to that one namespace only — a different namespace still falls through to (and is denied by) the global default.
    expect(checkWikiAccess(rbac, "alice", "write", "docs")).toBe(false);
  });

  it("falls through to the global default when a namespace override is checked but not granted", () => {
    const rbac = fakeRbacCheck([["alice", "read", WIKI_RESOURCE]]);
    expect(checkWikiAccess(rbac, "alice", "read", "engineering")).toBe(true);
  });

  it("checks the namespace-scoped resource before the global default", () => {
    const rbac = fakeRbacCheck([["alice", "read", WIKI_RESOURCE]]);
    checkWikiAccess(rbac, "alice", "read", "engineering");
    expect(rbac.calls[0]).toEqual(["alice", "read", "wiki-engineering"]);
    expect(rbac.calls[1]).toEqual(["alice", "read", WIKI_RESOURCE]);
  });

  it("only ever checks the global default when no namespaceId is supplied", () => {
    const rbac = fakeRbacCheck([["alice", "read", WIKI_RESOURCE]]);
    checkWikiAccess(rbac, "alice", "read");
    expect(rbac.calls).toEqual([["alice", "read", WIKI_RESOURCE]]);
  });
});

describe("assertWikiAccess", () => {
  const actions: WikiAction[] = ["read", "write", "admin"];

  it.each(actions)(
    "throws AuthenticationError for %s when userId is undefined, without consulting rbac:check",
    (action) => {
      const rbac = fakeRbacCheck([["alice", action, WIKI_RESOURCE]]);
      expect(() => assertWikiAccess(rbac, undefined, action)).toThrow(AuthenticationError);
      expect(rbac.calls).toEqual([]);
    },
  );

  it.each(actions)(
    "throws AuthorizationError for %s when the resolved user is not granted the permission",
    (action) => {
      const rbac = fakeRbacCheck([]);
      expect(() => assertWikiAccess(rbac, "bob", action)).toThrow(AuthorizationError);
    },
  );

  it.each(actions)(
    "does not throw for %s when the resolved user holds the global default permission",
    (action) => {
      const rbac = fakeRbacCheck([["alice", action, WIKI_RESOURCE]]);
      expect(() => assertWikiAccess(rbac, "alice", action)).not.toThrow();
    },
  );

  it("does not throw when the user holds only a namespace-scoped override, not the global default", () => {
    const rbac = fakeRbacCheck([["alice", "admin", "wiki-engineering"]]);
    expect(() => assertWikiAccess(rbac, "alice", "admin", "engineering")).not.toThrow();
  });

  it("throws AuthorizationError when the user holds the override for a different namespace than requested", () => {
    const rbac = fakeRbacCheck([["alice", "admin", "wiki-engineering"]]);
    expect(() => assertWikiAccess(rbac, "alice", "admin", "docs")).toThrow(AuthorizationError);
  });
});
