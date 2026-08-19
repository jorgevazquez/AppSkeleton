import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { validateManifest } from "../../../src/core/manifest.js";
import { scanPluginDirectories } from "../../../src/core/registry.js";
import { isErr, isOk } from "../../../src/core/types.js";
import {
  DEFAULT_PLUGINS_ROOT,
  DEFAULT_TESTS_ROOT,
  generatePlugin,
} from "../../../src/plugins/plugin-builder/src/generate-plugin.js";

/**
 * Feature #75 step 3: "Write a test that generates a plugin into a temp
 * dir and validates every emitted file." Every assertion below drives the
 * *real* kernel machinery a shipped plugin would actually be checked
 * against — `validateManifest`, `scanPluginDirectories`, and the real
 * TypeScript compiler for syntax — rather than re-asserting the
 * generator's own template strings, so this suite would actually catch a
 * generator that silently drifted from what the kernel accepts.
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
  const base = mkdtempSync(join(tmpdir(), "appskeleton-create-plugin-"));
  tmpBaseDirs.push(base);
  return {
    pluginsRoot: join(base, "src-plugins"),
    testsRoot: join(base, "tests-plugins"),
  };
}

/**
 * Assert `source` is syntactically valid TypeScript — a fast,
 * type-checker-free stand-in for a full `tsc` run (this suite generates
 * into a temp dir outside `tsconfig.json`'s `include`, so `npm run build`
 * never actually compiles these files; this is the syntax-level guarantee
 * this test suite can give in their place).
 */
function expectValidTypeScriptSyntax(source: string, fileName: string): void {
  const transpiled = ts.transpileModule(source, {
    fileName,
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const syntaxErrors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  expect(syntaxErrors).toHaveLength(0);
}

describe("generatePlugin — defaults", () => {
  it("defaults pluginsRoot/testsRoot to this repo's real src/plugins and tests/plugins", () => {
    expect(DEFAULT_PLUGINS_ROOT.endsWith(join("src", "plugins"))).toBe(true);
    expect(DEFAULT_TESTS_ROOT.endsWith(join("tests", "plugins"))).toBe(true);
  });
});

describe("generatePlugin — scaffolds a valid plugin directory into a temp dir", () => {
  it("emits every file, each of which validates independently", async () => {
    const roots = freshRoots();

    const result = await generatePlugin({
      id: "sample-widget",
      description: "Renders a sample widget for the temp-dir generator test.",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    // --- plugin.json: run it through the exact scan + validate path the kernel loader uses ---
    const { entries } = await scanPluginDirectories(roots.pluginsRoot);
    const entry = entries.find((candidate) => candidate.name === "sample-widget");
    expect(entry).toBeDefined();
    expect(entry?.manifestPath).toBe(join(roots.pluginsRoot, "sample-widget", "plugin.json"));

    const validated = validateManifest(entry?.manifest);
    expect(isOk(validated)).toBe(true);
    if (isOk(validated)) {
      expect(validated.value).toEqual({
        id: "sample-widget",
        version: "0.1.0",
        depends_on: {},
        capabilities: { provides: [], requires: [] },
        entry_point: "index.ts",
      });
      // The manifest handed back in the result is the same, already-validated value.
      expect(result.value.manifest).toEqual(validated.value);
    }

    // --- index.ts: exports every lifecycle hook + provides, and is syntactically valid TS ---
    const indexPath = join(roots.pluginsRoot, "sample-widget", "index.ts");
    const indexSource = readFileSync(indexPath, "utf-8");
    for (const exportName of ["onInstall", "onEnable", "onDisable", "onUninstall", "provides"]) {
      expect(indexSource).toMatch(new RegExp(`export (function|const) ${exportName}\\b`));
    }
    expect(indexSource).toContain("Renders a sample widget for the temp-dir generator test.");
    expectValidTypeScriptSyntax(indexSource, indexPath);

    // --- src/ exists as a real directory on disk ---
    expect(existsSync(join(roots.pluginsRoot, "sample-widget", "src"))).toBe(true);
    expect(existsSync(join(roots.pluginsRoot, "sample-widget", "src", ".gitkeep"))).toBe(true);

    // --- README.md carries the id and description ---
    const readme = readFileSync(join(roots.pluginsRoot, "sample-widget", "README.md"), "utf-8");
    expect(readme).toContain("# sample-widget plugin");
    expect(readme).toContain("Renders a sample widget for the temp-dir generator test.");

    // --- tests/plugins/sample-widget/manifest.test.ts: valid TS, and actually discovers/validates ---
    const testPath = join(roots.testsRoot, "sample-widget", "manifest.test.ts");
    const testSource = readFileSync(testPath, "utf-8");
    expect(testSource).toContain('"sample-widget"');
    expect(testSource).toContain("scanPluginDirectories");
    expect(testSource).toContain("validateManifest");
    expectValidTypeScriptSyntax(testSource, testPath);

    // --- the result's own file manifest matches what's actually on disk ---
    expect(result.value.files.map((file) => file.path).sort()).toEqual(
      [
        join(roots.pluginsRoot, "sample-widget", "plugin.json"),
        join(roots.pluginsRoot, "sample-widget", "index.ts"),
        join(roots.pluginsRoot, "sample-widget", "README.md"),
        join(roots.pluginsRoot, "sample-widget", "src", ".gitkeep"),
        join(roots.testsRoot, "sample-widget", "manifest.test.ts"),
      ].sort(),
    );
    for (const file of result.value.files) {
      expect(readFileSync(file.path, "utf-8")).toBe(file.contents);
    }
  });

  it("sanitizes a description containing '*/' so it cannot break out of index.ts's doc comment", async () => {
    const roots = freshRoots();

    const result = await generatePlugin({
      id: "comment-breaker",
      description: "Does a thing */ export const evil = true; /* like this",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }

    const indexSource = readFileSync(
      join(roots.pluginsRoot, "comment-breaker", "index.ts"),
      "utf-8",
    );
    expect(indexSource).not.toContain("*/ export const evil = true;");
    expectValidTypeScriptSyntax(
      indexSource,
      join(roots.pluginsRoot, "comment-breaker", "index.ts"),
    );

    const { entries } = await scanPluginDirectories(roots.pluginsRoot);
    const entry = entries.find((candidate) => candidate.name === "comment-breaker");
    expect(isOk(validateManifest(entry?.manifest))).toBe(true);
  });
});

describe("generatePlugin — rejects invalid input without writing anything", () => {
  it("rejects an id that isn't lowercase-kebab-case", async () => {
    const roots = freshRoots();

    const result = await generatePlugin({
      id: "Not-Valid",
      description: "irrelevant",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });

    expect(isErr(result)).toBe(true);
    expect(existsSync(join(roots.pluginsRoot, "Not-Valid"))).toBe(false);
  });

  it("rejects an empty description", async () => {
    const roots = freshRoots();

    const result = await generatePlugin({
      id: "empty-description",
      description: "   ",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });

    expect(isErr(result)).toBe(true);
    expect(existsSync(join(roots.pluginsRoot, "empty-description"))).toBe(false);
  });

  it("refuses to overwrite a plugin directory that already exists", async () => {
    const roots = freshRoots();

    const first = await generatePlugin({
      id: "already-there",
      description: "first generation",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });
    expect(isOk(first)).toBe(true);

    const second = await generatePlugin({
      id: "already-there",
      description: "second generation should be refused",
      pluginsRoot: roots.pluginsRoot,
      testsRoot: roots.testsRoot,
    });
    expect(isErr(second)).toBe(true);

    // The original files are untouched by the refused second attempt.
    const readme = readFileSync(join(roots.pluginsRoot, "already-there", "README.md"), "utf-8");
    expect(readme).toContain("first generation");
    expect(readme).not.toContain("second generation");
  });
});
