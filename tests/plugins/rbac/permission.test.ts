import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import { isErr, isOk } from "../../../src/core/types.js";
import {
  isValidPermissionString,
  parsePermissionString,
  toPermission,
  type ParsedPermission,
} from "../../../src/plugins/rbac/src/permission.js";

describe("parsePermissionString — valid permission strings", () => {
  it.each<[string, ParsedPermission]>([
    ["wiki:read", { resource: "wiki", action: "read" }],
    ["rbac:check", { resource: "rbac", action: "check" }],
    ["rbac:manage", { resource: "rbac", action: "manage" }],
    ["db:query", { resource: "db", action: "query" }],
    ["a:b", { resource: "a", action: "b" }],
    ["user-profile:update", { resource: "user-profile", action: "update" }],
    ["wiki:soft-delete", { resource: "wiki", action: "soft-delete" }],
    [
      "multi-word-resource:multi-word-action",
      { resource: "multi-word-resource", action: "multi-word-action" },
    ],
    ["a1b2:c3d4", { resource: "a1b2", action: "c3d4" }],
  ])("accepts %s", (input, expected) => {
    const result = parsePermissionString(input);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual(expected);
    }
  });
});

describe("parsePermissionString — invalid permission strings", () => {
  it.each<[string, unknown]>([
    ["empty string", ""],
    ["missing colon", "wikiread"],
    ["missing action", "wiki:"],
    ["missing resource", ":read"],
    ["double colon", "wiki::read"],
    ["extra segment", "wiki:read:extra"],
    ["uppercase resource", "Wiki:read"],
    ["uppercase action", "wiki:Read"],
    ["leading hyphen in resource", "-wiki:read"],
    ["trailing hyphen in action", "wiki:read-"],
    ["double hyphen", "wiki:re--ad"],
    ["leading digit in resource", "1wiki:read"],
    ["space in permission", "wiki: read"],
    ["underscore instead of hyphen", "user_profile:update"],
    ["wildcard action", "wiki:*"],
    ["wildcard resource", "*:read"],
    ["just a colon", ":"],
    ["not a string (number)", 42],
    ["not a string (null)", null],
    ["not a string (undefined)", undefined],
    ["not a string (object)", { resource: "wiki", action: "read" }],
  ])("rejects %s (%j)", (_description, input) => {
    const result = parsePermissionString(input);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details?.["input"]).toEqual(input);
    }
  });
});

describe("isValidPermissionString", () => {
  it("returns true for syntactically valid permission strings", () => {
    expect(isValidPermissionString("wiki:read")).toBe(true);
    expect(isValidPermissionString("rbac:manage")).toBe(true);
  });

  it("returns false for invalid input, including non-strings", () => {
    expect(isValidPermissionString("wiki")).toBe(false);
    expect(isValidPermissionString("wiki:*")).toBe(false);
    expect(isValidPermissionString("")).toBe(false);
    expect(isValidPermissionString(42)).toBe(false);
    expect(isValidPermissionString(null)).toBe(false);
    expect(isValidPermissionString(undefined)).toBe(false);
  });

  it("narrows its argument to a string when true (compile-time type guard)", () => {
    const candidate: unknown = "wiki:read";
    if (isValidPermissionString(candidate)) {
      // This assignment only type-checks if isValidPermissionString is a
      // proper `input is PermissionString` type guard.
      const narrowed: string = candidate;
      expect(narrowed).toBe("wiki:read");
    } else {
      throw new Error("expected candidate to be recognized as valid");
    }
  });
});

describe("toPermission", () => {
  it("builds a Permission whose id/resource/action agree, without a description", () => {
    const result = toPermission("wiki:read");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({ id: "wiki:read", resource: "wiki", action: "read" });
      expect(result.value).not.toHaveProperty("description");
    }
  });

  it("builds a Permission with a description when provided", () => {
    const result = toPermission("wiki:read", "Read wiki pages");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        id: "wiki:read",
        resource: "wiki",
        action: "read",
        description: "Read wiki pages",
      });
    }
  });

  it("propagates a parse failure for an invalid id, without constructing a Permission", () => {
    const result = toPermission("not-valid");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });
});
