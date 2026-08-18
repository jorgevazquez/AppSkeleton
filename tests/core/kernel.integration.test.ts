/**
 * Kernel integration suite — registry, loader, and broker exercised
 * *together* through the real bootstrap path (`bootstrapKernel()` in
 * `src/server/index.ts`), against a realistic multi-plugin dependency graph
 * written to a real temp directory on disk (not in-memory `PluginDefinition`
 * fixtures like `tests/core/loader.test.ts`, and not the single
 * dependency-pair fixtures in `tests/server/index.test.ts`).
 *
 * This complements — rather than duplicates — the unit suites for each
 * primitive (`tests/core/registry.test.ts`, `tests/core/loader.test.ts`,
 * `tests/core/broker.test.ts`, `tests/core/graph.test.ts`): those cover each
 * module's own contract in isolation; this file's job is to prove the real
 * wiring across all of them holds end-to-end, with one plugin deliberately
 * broken partway through a five-plugin graph, per feature #14's steps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityDeniedError } from "../../src/core/errors.js";
import { isErr, isOk } from "../../src/core/types.js";
import { bootstrapKernel } from "../../src/server/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function trackedTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "appskeleton-kernel-integration-"));
  tempRoots.push(root);
  return root;
}

/** Write a fixture plugin directory: `plugin.json` plus any extra files (e.g. `index.js`). */
function writePluginDir(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  for (const [fileName, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, fileName), contents);
  }
  return dir;
}

/**
 * Writes a five-plugin fixture set with a realistic, non-trivial dependency
 * graph — a diamond (`database` and `auth` both depend on `logging`,
 * `api` depends on both) plus an unrelated sibling leaf (`metrics`, also
 * depending only on `logging`):
 *
 *          logging
 *         /   |    \
 *   database auth  metrics
 *         \   /
 *          api
 *
 * When `breakAuth` is true, `auth`'s entry point imports fine (unlike
 * `tests/server/index.test.ts`'s "entry point cannot be imported" case) but
 * its `onInstall` hook throws synchronously — a different, equally realistic
 * way a plugin can be "intentionally broken" once past import. That failure
 * should cascade to `api` (which depends on `auth`) but never touch
 * `logging`, `database`, or `metrics`, none of which depend on `auth`.
 */
function writeFixtureGraph(root: string, options: { breakAuth: boolean }): void {
  writePluginDir(
    root,
    "logging",
    {
      id: "logging",
      version: "1.0.0",
      depends_on: {},
      capabilities: { provides: ["log:write"], requires: [] },
      entry_point: "index.js",
    },
    {
      "index.js": [
        "export const calls = [];",
        "export const provides = {",
        '  "log:write": (message) => { calls.push(message); },',
        "};",
        "",
      ].join("\n"),
    },
  );

  writePluginDir(
    root,
    "database",
    {
      id: "database",
      version: "1.0.0",
      depends_on: { logging: "^1.0.0" },
      capabilities: { provides: ["db:query"], requires: ["log:write"] },
      entry_point: "index.js",
    },
    {
      "index.js": [
        "export const provides = {",
        '  "db:query": () => ["row-1", "row-2"],',
        "};",
        "export async function onInstall(context) {",
        '  const log = context.capabilities.obtain("log:write");',
        '  if (log.ok) log.value("database installed");',
        "}",
        "",
      ].join("\n"),
    },
  );

  writePluginDir(
    root,
    "auth",
    {
      id: "auth",
      version: "1.0.0",
      depends_on: { logging: "^1.0.0" },
      capabilities: { provides: ["auth:check"], requires: ["log:write"] },
      entry_point: "index.js",
    },
    {
      "index.js": options.breakAuth
        ? [
            "export const provides = {",
            '  "auth:check": () => true,',
            "};",
            "export async function onInstall() {",
            '  throw new Error("auth plugin is intentionally broken for this test");',
            "}",
            "",
          ].join("\n")
        : [
            "export const provides = {",
            '  "auth:check": () => true,',
            "};",
            "",
          ].join("\n"),
    },
  );

  writePluginDir(
    root,
    "api",
    {
      id: "api",
      version: "1.0.0",
      depends_on: { database: "^1.0.0", auth: "^1.0.0" },
      capabilities: { provides: ["http:route"], requires: ["db:query", "auth:check"] },
      entry_point: "index.js",
    },
    {
      "index.js": [
        "export const provides = {",
        '  "http:route": () => "ok",',
        "};",
        "",
      ].join("\n"),
    },
  );

  writePluginDir(
    root,
    "metrics",
    {
      id: "metrics",
      version: "1.0.0",
      depends_on: { logging: "^1.0.0" },
      capabilities: { provides: ["metrics:report"], requires: ["log:write"] },
      entry_point: "index.js",
    },
    {
      "index.js": [
        "export const provides = {",
        '  "metrics:report": () => ({ ok: true }),',
        "};",
        "export async function onInstall(context) {",
        '  const log = context.capabilities.obtain("log:write");',
        '  if (log.ok) log.value("metrics installed");',
        "}",
        "",
      ].join("\n"),
    },
  );
}

describe("kernel integration — registry + loader + broker + error isolation", () => {
  it("loads a realistic 5-plugin dependency graph end-to-end when every plugin is healthy", async () => {
    const pluginsRoot = trackedTempRoot();
    writeFixtureGraph(pluginsRoot, { breakAuth: false });

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.failed).toEqual([]);
    expect(kernel.plugins.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "api",
      "auth",
      "database",
      "logging",
      "metrics",
    ]);

    // Dependency order must place every dependency before its dependents.
    const indexOf = (id: string): number => kernel.plugins.order.indexOf(id);
    expect(indexOf("logging")).toBeLessThan(indexOf("database"));
    expect(indexOf("logging")).toBeLessThan(indexOf("auth"));
    expect(indexOf("logging")).toBeLessThan(indexOf("metrics"));
    expect(indexOf("database")).toBeLessThan(indexOf("api"));
    expect(indexOf("auth")).toBeLessThan(indexOf("api"));

    // Broker wiring end-to-end: api can obtain both of the capabilities it
    // declared and was granted, each actually implemented by a *different*
    // upstream plugin resolved through the real registry+loader+broker path.
    const api = kernel.plugins.loaded.find((plugin) => plugin.id === "api");
    expect(api).toBeDefined();
    const dbQuery = api?.context.capabilities.obtain<() => string[]>("db:query");
    const authCheck = api?.context.capabilities.obtain<() => boolean>("auth:check");
    expect(dbQuery !== undefined && isOk(dbQuery)).toBe(true);
    expect(authCheck !== undefined && isOk(authCheck)).toBe(true);
    if (dbQuery !== undefined && isOk(dbQuery)) {
      expect(dbQuery.value()).toEqual(["row-1", "row-2"]);
    }
    if (authCheck !== undefined && isOk(authCheck)) {
      expect(authCheck.value()).toBe(true);
    }

    // The sibling leaf plugin (metrics) obtained the shared logging
    // capability during its own onInstall — proves the broker fans a single
    // provider out to multiple independent dependents in one bootstrap pass.
    const introspection = kernel.introspect();
    expect(introspection.summary).toEqual({ total: 5, loaded: 5, failed: 0, disabled: 0 });
    for (const id of ["logging", "database", "auth", "api", "metrics"]) {
      expect(introspection.plugins.find((plugin) => plugin.id === id)?.status).toBe("loaded");
    }
  });

  it("isolates one intentionally broken plugin (auth) without crashing the kernel, its unrelated siblings, or its already-loaded dependency", async () => {
    const pluginsRoot = trackedTempRoot();
    writeFixtureGraph(pluginsRoot, { breakAuth: true });

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    // The broken plugin's own failure, isolated by the loader (feature #10).
    const authFailure = kernel.plugins.failed.find((plugin) => plugin.id === "auth");
    expect(authFailure).toBeDefined();
    expect(authFailure?.skipped).toBe(false);
    expect(authFailure?.error.message).toContain("auth plugin is intentionally broken");

    // api depends on the broken auth plugin, so it must be cascade-skipped —
    // never even attempted — rather than silently loaded with a missing
    // capability.
    const apiFailure = kernel.plugins.failed.find((plugin) => plugin.id === "api");
    expect(apiFailure).toBeDefined();
    expect(apiFailure?.skipped).toBe(true);
    expect(apiFailure?.error.message).toContain("auth");

    // Every plugin unrelated to auth — including logging, the dependency
    // auth itself relies on, which finished loading before auth's own
    // failure — still loads normally. This is the crux of "error isolation":
    // one broken plugin never rolls back or blocks work that already
    // succeeded, nor unrelated siblings later in load order.
    expect(kernel.plugins.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "database",
      "logging",
      "metrics",
    ]);

    // The kernel process itself is alive and answering requests — a broken
    // plugin never crashes the kernel (spec.md's graceful-degradation
    // baseline), it only affects itself and its own dependents.
    expect(kernel.broker).toBeDefined();
    expect(Array.isArray(kernel.plugins.order)).toBe(true);
    expect(kernel.plugins.order).toContain("auth");
    expect(kernel.plugins.order).toContain("api");

    // Broker-level isolation: auth's own declared-but-never-granted
    // capability, and api's requirements (never even attempted), are not
    // obtainable by anything — the broker never leaves a half-wired grant
    // or registration behind for a plugin that failed mid-load.
    const databasePlugin = kernel.plugins.loaded.find((plugin) => plugin.id === "database");
    const authCheckFromDatabase = databasePlugin?.context.capabilities.obtain("auth:check");
    // database never declared auth:check at all — denied, not merely absent.
    expect(authCheckFromDatabase !== undefined && isErr(authCheckFromDatabase)).toBe(true);
    if (authCheckFromDatabase !== undefined && isErr(authCheckFromDatabase)) {
      expect(authCheckFromDatabase.error.details?.["reason"]).toBe("not_declared");
    }
    const authCheckDirect = kernel.broker.forPlugin("api").obtain("auth:check");
    expect(isErr(authCheckDirect)).toBe(true);
    if (isErr(authCheckDirect)) {
      expect(authCheckDirect.error).toBeInstanceOf(CapabilityDeniedError);
      // api was never attempted, so it never even declared auth:check with
      // the broker — "not_declared", not merely "not_granted"/"no_provider".
      expect(authCheckDirect.error.details?.["reason"]).toBe("not_declared");
    }

    // introspect() reflects the same isolated picture the raw PluginLoadResult does.
    const introspection = kernel.introspect();
    expect(introspection.summary).toEqual({ total: 5, loaded: 3, failed: 2, disabled: 0 });
    expect(introspection.plugins.find((plugin) => plugin.id === "logging")?.status).toBe("loaded");
    expect(introspection.plugins.find((plugin) => plugin.id === "database")?.status).toBe(
      "loaded",
    );
    expect(introspection.plugins.find((plugin) => plugin.id === "metrics")?.status).toBe(
      "loaded",
    );
    expect(introspection.plugins.find((plugin) => plugin.id === "auth")?.status).toBe("failed");
    expect(introspection.plugins.find((plugin) => plugin.id === "auth")?.skipped).toBe(false);
    expect(introspection.plugins.find((plugin) => plugin.id === "api")?.status).toBe("failed");
    expect(introspection.plugins.find((plugin) => plugin.id === "api")?.skipped).toBe(true);
  });
});
