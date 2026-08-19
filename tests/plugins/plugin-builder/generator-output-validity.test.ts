import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isOk } from "../../../src/core/types.js";
import {
  isClean,
  lintPlugin,
  type ConventionsLintResult,
} from "../../../src/plugins/plugin-builder/src/conventions-linter.js";
import { generatePlugin } from "../../../src/plugins/plugin-builder/src/generate-plugin.js";

/**
 * Feature #83 — "Generator output validity test suite".
 *
 * Feature #75's own test (generate-plugin.test.ts) already proves the
 * generator's output shape is correct file-by-file, and feature #80's
 * programmatic-API test proves `generatePlugin` is directly callable. What
 * neither of those (nor feature #77's conventions-linter.test.ts, which only
 * sweeps the real, hand-authored `src/plugins` tree) ever asserts is the
 * thing this feature's steps actually ask for: that a plugin directory
 * freshly produced by `generatePlugin` — not a hand-authored one — passes
 * BOTH the kernel's manifest validator (`core/manifest.ts`'s
 * `validateManifest`) AND the plugin-builder's own conventions linter
 * (`conventions-linter.ts`'s `lintPlugin`), end to end, automatically as
 * part of `npm test`. This suite closes that gap for two distinct option
 * shapes (feature #83 step 2): the minimal option set (just `id` +
 * `description`, every optional field defaulted) and a fuller one that
 * exercises `capabilities.provides`/`capabilities.requires` together with a
 * realistic multi-sentence `description`.
 */

let tmpBaseDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpBaseDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpBaseDirs = [];
});

/** A fresh, isolated `{ pluginsRoot, testsRoot }` pair under one mkdtemp'd parent, cleaned up after the test. */
function freshRoots(): { pluginsRoot: string; testsRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "appskeleton-generator-output-validity-"));
  tmpBaseDirs.push(base);
  return {
    pluginsRoot: join(base, "src-plugins"),
    testsRoot: join(base, "tests-plugins"),
  };
}

function describeLintIssues(result: ConventionsLintResult): string {
  return result.issues
    .map((issue) => `[${issue.code}]${issue.file ? ` ${issue.file}:` : ""} ${issue.message}`)
    .join("\n");
}

/**
 * Runs a generated plugin directory through both gates feature #83 requires
 * and asserts each passes, given the id `generatePlugin` was called with.
 */
async function expectGeneratedPluginIsValid(pluginsRoot: string, id: string): Promise<void> {
  // --- Gate 1: the kernel's manifest validator, via the same scan+validate
  // path the real registry/loader uses (not a re-parse of the generator's
  // own template strings). ---
  const { entries } = await scanPluginDirectories(pluginsRoot);
  const entry = entries.find((candidate) => candidate.name === id);
  expect(entry, `plugin "${id}" should be discoverable under ${pluginsRoot}`).toBeDefined();

  const validated = validateManifest(entry?.manifest);
  expect(
    isOk(validated),
    isOk(validated) ? "" : `manifest validator rejected "${id}": ${validated.error.message}`,
  ).toBe(true);

  // --- Gate 2: the plugin-builder's own static conventions linter. ---
  const lintResult = await lintPlugin(pluginsRoot, id);
  expect(isClean(lintResult), describeLintIssues(lintResult)).toBe(true);
}

describe("generator output validity (feature #83)", () => {
  it("passes both the manifest validator and the conventions linter with the minimal option set", async () => {
    const roots = freshRoots();

    const result = await generatePlugin({
      id: "minimal-widget",
      description: "A minimally-configured plugin generated for feature #83's validity suite.",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    // Minimal really means minimal: no capabilities were requested, so the
    // generator's own default-empty behavior (plugin-templates.ts) is what
    // this case is exercising.
    expect(result.value.manifest.capabilities).toEqual({ provides: [], requires: [] });

    await expectGeneratedPluginIsValid(roots.pluginsRoot, "minimal-widget");
  });

  it("passes both the manifest validator and the conventions linter with a fuller option set (capabilities, description)", async () => {
    const roots = freshRoots();

    const result = await generatePlugin({
      id: "full-widget",
      description:
        "A fully-configured plugin generated for feature #83's validity suite, " +
        "declaring both provided and required capabilities up front.",
      capabilities: {
        provides: ["widget:render", "widget:configure"],
        requires: ["rbac:check"],
      },
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    expect(result.value.manifest.capabilities).toEqual({
      provides: ["widget:render", "widget:configure"],
      requires: ["rbac:check"],
    });

    await expectGeneratedPluginIsValid(roots.pluginsRoot, "full-widget");
  });
});
