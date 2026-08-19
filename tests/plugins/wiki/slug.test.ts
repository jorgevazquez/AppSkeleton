/**
 * Unit tests for `slug.ts` (feature #87 step 2 — "Enforce slug format
 * validation ... on create"). Mirrors `tests/plugins/rbac/permission.test.ts`'s
 * shape for the sibling `resource:action` grammar parser.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/core/errors.js";
import { isErr, isOk } from "../../../src/core/types.js";
import { isValidSlug, parseSlug } from "../../../src/plugins/wiki/src/slug.js";

describe("parseSlug — valid slugs", () => {
  it.each<string>([
    "getting-started",
    "home",
    "a",
    "a1",
    "multi-word-slug-title",
    "page42",
    "release-2024-notes",
  ])("accepts %s", (input) => {
    const result = parseSlug(input);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(input);
    }
  });
});

describe("parseSlug — invalid slugs", () => {
  it.each<[string, unknown]>([
    ["empty string", ""],
    ["uppercase", "Getting-Started"],
    ["leading hyphen", "-getting-started"],
    ["trailing hyphen", "getting-started-"],
    ["double hyphen", "getting--started"],
    ["whitespace", "getting started"],
    ["underscore", "getting_started"],
    ["path separator", "getting/started"],
    ["just a hyphen", "-"],
    ["too long", "a".repeat(256)],
    ["not a string (number)", 42],
    ["not a string (null)", null],
    ["not a string (undefined)", undefined],
    ["not a string (object)", { slug: "getting-started" }],
  ])("rejects %s (%j)", (_description, input) => {
    const result = parseSlug(input);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.details?.["input"]).toEqual(input);
    }
  });
});

describe("isValidSlug", () => {
  it("returns true for syntactically valid slugs", () => {
    expect(isValidSlug("getting-started")).toBe(true);
    expect(isValidSlug("home")).toBe(true);
  });

  it("returns false for invalid input, including non-strings", () => {
    expect(isValidSlug("Getting-Started")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug(42)).toBe(false);
    expect(isValidSlug(null)).toBe(false);
    expect(isValidSlug(undefined)).toBe(false);
  });

  it("narrows its argument to a string when true (compile-time type guard)", () => {
    const candidate: unknown = "getting-started";
    if (isValidSlug(candidate)) {
      const narrowed: string = candidate;
      expect(narrowed).toBe("getting-started");
    } else {
      throw new Error("expected isValidSlug to return true for this candidate");
    }
  });
});
