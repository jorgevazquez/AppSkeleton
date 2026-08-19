import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import {
  validateManifest,
  type ManifestValidationIssue,
  type PluginManifest,
} from "../../src/core/manifest.js";
import { isErr, isOk } from "../../src/core/types.js";
import { validManifest } from "../fixtures/plugin-manifests.js";

/** Assert failure and return the issue list for further assertions. */
function expectIssues(input: unknown): ManifestValidationIssue[] {
  const result = validateManifest(input);
  expect(isErr(result)).toBe(true);
  if (!isErr(result)) {
    throw new Error("expected validateManifest to fail");
  }
  expect(result.error).toBeInstanceOf(ValidationError);
  expect(result.error.code).toBe("VALIDATION_ERROR");
  const issues = result.error.details?.["issues"];
  expect(Array.isArray(issues)).toBe(true);
  return issues as ManifestValidationIssue[];
}

describe("validateManifest — valid manifests", () => {
  it("accepts a fully populated manifest", () => {
    const result = validateManifest(validManifest());
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual<PluginManifest>({
        id: "database-mysql",
        version: "1.2.3",
        depends_on: { rbac: "^1.0.0" },
        capabilities: {
          provides: ["db:query", "db:transaction"],
          requires: ["config:read"],
        },
        entry_point: "index.ts",
      });
    }
  });

  it("accepts a minimal manifest, defaulting depends_on and capabilities", () => {
    const result = validateManifest({
      id: "wiki",
      version: "0.1.0",
      entry_point: "index.ts",
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.depends_on).toEqual({});
      expect(result.value.capabilities).toEqual({ provides: [], requires: [] });
    }
  });

  it("accepts a plugin id with multiple hyphenated segments and digits", () => {
    const result = validateManifest(validManifest({ id: "plugin-builder-v2" }));
    expect(isOk(result)).toBe(true);
  });

  it("accepts prerelease and build-metadata semver versions", () => {
    const result = validateManifest(validManifest({ version: "2.0.0-beta.1+build.5" }));
    expect(isOk(result)).toBe(true);
  });

  it("accepts a variety of valid semver ranges in depends_on", () => {
    const result = validateManifest(
      validManifest({
        depends_on: {
          rbac: "^1.0.0",
          "database-mysql": "~2.3.1",
          "html-renderer": ">=1.0.0 <3.0.0",
          "api-gateway": "1.x",
          wiki: "*",
        },
      }),
    );
    expect(isOk(result)).toBe(true);
  });

  it("accepts an entry_point nested under a subdirectory", () => {
    const result = validateManifest(validManifest({ entry_point: "src/index.ts" }));
    expect(isOk(result)).toBe(true);
  });

  it("accepts empty provides/requires arrays", () => {
    const result = validateManifest(
      validManifest({ capabilities: { provides: [], requires: [] } }),
    );
    expect(isOk(result)).toBe(true);
  });
});

describe("validateManifest — invalid: bad semver version", () => {
  it.each(["1.2", "not-a-version", "1.2.3.4", "v1.2.3", ""])("rejects version %j", (version) => {
    const issues = expectIssues(validManifest({ version }));
    expect(issues.some((issue) => issue.path === "version")).toBe(true);
  });

  it("error message names the offending path and does not leak into publicMessage", () => {
    const result = validateManifest(validManifest({ version: "not-a-version" }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).toContain("version");
      expect(result.error.publicMessage).toBe("The request was invalid.");
    }
  });
});

describe("validateManifest — invalid: missing id", () => {
  it("rejects a manifest with no id field", () => {
    const manifest = validManifest();
    delete manifest["id"];
    const issues = expectIssues(manifest);
    expect(issues.some((issue) => issue.path === "id")).toBe(true);
  });

  it("rejects an empty-string id", () => {
    const issues = expectIssues(validManifest({ id: "" }));
    expect(issues.some((issue) => issue.path === "id")).toBe(true);
  });
});

describe("validateManifest — invalid: duplicate capability", () => {
  it("rejects a duplicate entry within capabilities.provides", () => {
    const issues = expectIssues(
      validManifest({ capabilities: { provides: ["db:query", "db:query"], requires: [] } }),
    );
    expect(
      issues.some(
        (issue) =>
          issue.code === "duplicate_capability" && issue.path.startsWith("capabilities.provides"),
      ),
    ).toBe(true);
  });

  it("rejects a duplicate entry within capabilities.requires", () => {
    const issues = expectIssues(
      validManifest({
        capabilities: { provides: [], requires: ["config:read", "config:read"] },
      }),
    );
    expect(
      issues.some(
        (issue) =>
          issue.code === "duplicate_capability" && issue.path.startsWith("capabilities.requires"),
      ),
    ).toBe(true);
  });

  it("does not flag the same capability appearing once in provides and once in requires", () => {
    const result = validateManifest(
      validManifest({
        capabilities: { provides: ["rbac:check"], requires: ["rbac:check"] },
      }),
    );
    expect(isOk(result)).toBe(true);
  });
});

describe("validateManifest — invalid: malformed capability grammar", () => {
  it.each([
    "dbquery", // no colon
    "db:", // empty action segment
    ":query", // empty namespace segment
    "db::query", // double colon
    "db:query:extra", // too many segments
    "DB:QUERY", // must be lowercase
    "db query", // space instead of colon
  ])("rejects malformed capability %j", (capability) => {
    const issues = expectIssues(
      validManifest({ capabilities: { provides: [capability], requires: [] } }),
    );
    expect(issues.some((issue) => issue.path === "capabilities.provides[0]")).toBe(true);
  });
});

describe("validateManifest — invalid: unknown field", () => {
  it("rejects an unrecognized top-level field", () => {
    const issues = expectIssues(validManifest({ unexpectedField: "surprise" }));
    expect(issues.some((issue) => issue.code === "unknown_field")).toBe(true);
  });

  it("rejects an unrecognized field nested under capabilities", () => {
    const issues = expectIssues(
      validManifest({
        capabilities: { provides: [], requires: [], extra: true },
      }),
    );
    expect(issues.some((issue) => issue.code === "unknown_field")).toBe(true);
  });
});

describe("validateManifest — additional invalid variants", () => {
  it("rejects a malformed semver range in depends_on", () => {
    const issues = expectIssues(validManifest({ depends_on: { rbac: "not-a-range" } }));
    expect(issues.some((issue) => issue.path === "depends_on.rbac")).toBe(true);
  });

  it("rejects a plugin id with uppercase letters", () => {
    const issues = expectIssues(validManifest({ id: "Database-Mysql" }));
    expect(issues.some((issue) => issue.path === "id")).toBe(true);
  });

  it("rejects a plugin id with underscores", () => {
    const issues = expectIssues(validManifest({ id: "database_mysql" }));
    expect(issues.some((issue) => issue.path === "id")).toBe(true);
  });

  it("rejects an absolute entry_point path", () => {
    const issues = expectIssues(validManifest({ entry_point: "/etc/passwd.ts" }));
    expect(issues.some((issue) => issue.path === "entry_point")).toBe(true);
  });

  it("rejects a directory-traversal entry_point path", () => {
    const issues = expectIssues(validManifest({ entry_point: "../../etc/passwd.ts" }));
    expect(issues.some((issue) => issue.path === "entry_point")).toBe(true);
  });

  it("rejects an entry_point with an unsupported extension", () => {
    const issues = expectIssues(validManifest({ entry_point: "index.py" }));
    expect(issues.some((issue) => issue.path === "entry_point")).toBe(true);
  });

  it("rejects a non-object input", () => {
    const issues = expectIssues("not a manifest");
    expect(issues.length).toBeGreaterThan(0);
  });

  it("rejects a manifest missing entry_point", () => {
    const manifest = validManifest();
    delete manifest["entry_point"];
    const issues = expectIssues(manifest);
    expect(issues.some((issue) => issue.path === "entry_point")).toBe(true);
  });

  it("collects every violation in a single call rather than stopping at the first", () => {
    const issues = expectIssues({
      id: "",
      version: "bad",
      entry_point: "/abs.ts",
      capabilities: { provides: ["bad grammar"], requires: [] },
      somethingUnexpected: true,
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "id",
        "version",
        "entry_point",
        "capabilities.provides[0]",
        "(root)",
      ]),
    );
  });
});
