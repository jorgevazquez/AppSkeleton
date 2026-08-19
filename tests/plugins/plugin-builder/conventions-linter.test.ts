import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isClean,
  lintAllPlugins,
  lintPlugin,
  type ConventionsLintResult,
} from "../../../src/plugins/plugin-builder/src/conventions-linter.js";

/** Real `src/plugins` root — used by the "every shipped plugin" sweep below. */
const REAL_PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/plugins",
);

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/conventions-linter",
);

/** `<FIXTURES_ROOT>/<caseName>/src/plugins` — every fixture case mirrors a real `src/plugins` layout. */
function fixturePluginsRoot(caseName: string): string {
  return path.join(FIXTURES_ROOT, caseName, "src", "plugins");
}

function describeIssues(result: ConventionsLintResult): string {
  return result.issues
    .map((issue) => `[${issue.code}]${issue.file ? ` ${issue.file}:` : ""} ${issue.message}`)
    .join("\n");
}

describe("conventions linter (feature #77)", () => {
  describe("passing fixture", () => {
    it("reports no issues for a plugin whose naming, capabilities, and imports are all in order", async () => {
      const result = await lintPlugin(fixturePluginsRoot("passing"), "good-plugin");

      expect(isClean(result), describeIssues(result)).toBe(true);
    });
  });

  describe("failing fixture: bad naming", () => {
    it("flags a plugin.json whose id does not match its directory name", async () => {
      const result = await lintPlugin(fixturePluginsRoot("bad-naming"), "good-plugin");

      expect(isClean(result)).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("id_directory_mismatch");
      expect(
        result.issues.find((issue) => issue.code === "id_directory_mismatch")?.message,
      ).toMatch(/"great-plugin".*"good-plugin"/);
    });
  });

  describe("failing fixture: undeclared capability use", () => {
    it("flags an obtain() call for a capability missing from capabilities.requires", async () => {
      const result = await lintPlugin(fixturePluginsRoot("undeclared-capability"), "needs-thing");

      expect(isClean(result)).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("undeclared_capability_use");
      expect(
        result.issues.find((issue) => issue.code === "undeclared_capability_use")?.message,
      ).toContain("some:capability");
    });
  });

  describe("failing fixture: forbidden cross-plugin import", () => {
    it("flags a relative import that reaches into another plugin's internals", async () => {
      const result = await lintPlugin(fixturePluginsRoot("forbidden-import"), "plugin-a");

      expect(isClean(result)).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("forbidden_import");
      expect(result.issues.find((issue) => issue.code === "forbidden_import")?.message).toContain(
        "plugin-b",
      );
    });

    it("does not flag the plugin being imported from", async () => {
      const result = await lintPlugin(fixturePluginsRoot("forbidden-import"), "plugin-b");

      expect(isClean(result), describeIssues(result)).toBe(true);
    });
  });

  describe("run against every shipped plugin (step 2 — drift is caught automatically)", () => {
    it("finds zero convention violations across every plugin under src/plugins", async () => {
      const results = await lintAllPlugins(REAL_PLUGINS_ROOT);

      // Sanity check the sweep actually looked at every shipped plugin, so a
      // future refactor that (say) points REAL_PLUGINS_ROOT at an empty
      // directory fails loudly here instead of this test passing vacuously.
      expect(results.length).toBeGreaterThanOrEqual(6);

      const dirty = results.filter((result) => !isClean(result));
      const report = dirty
        .map((result) => `${result.pluginName}:\n${describeIssues(result)}`)
        .join("\n\n");

      expect(dirty, report).toHaveLength(0);
    });
  });
});
