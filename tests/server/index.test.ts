import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, PluginLoadError } from "../../src/core/errors.js";
import { isOk } from "../../src/core/types.js";
import { bootstrapKernel, buildServer, formatFatalStartupError } from "../../src/server/index.js";

/** Real `src/plugins` root — proves the wiring works against the actual shipped tree. */
const REAL_PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/plugins",
);

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function trackedTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "appskeleton-bootstrap-"));
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

describe("bootstrapKernel", () => {
  it("boots cleanly with zero plugins present", async () => {
    const pluginsRoot = trackedTempRoot();

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.loaded).toEqual([]);
    expect(kernel.plugins.failed).toEqual([]);
    expect(kernel.plugins.order).toEqual([]);
    expect(kernel.config.PORT).toBe(3000);
    expect(kernel.broker).toBeDefined();
    expect(kernel.auditSink).toBeDefined();
    expect(kernel.eventBus).toBeDefined();
  });

  it("boots cleanly against the real src/plugins tree without throwing", async () => {
    const kernel = await bootstrapKernel({ pluginsRoot: REAL_PLUGINS_ROOT, env: {} });

    // Every currently-shipped manifest declares an entry_point that doesn't
    // exist on disk yet (see claude-progress.txt) — each becomes an
    // isolated, logged failure rather than crashing the boot, so this only
    // asserts the shape holds, not exact counts (which would grow brittle
    // as later features add real plugin lifecycle modules).
    expect(Array.isArray(kernel.plugins.loaded)).toBe(true);
    expect(Array.isArray(kernel.plugins.failed)).toBe(true);
  });

  it("discovers, loads, and wires a real plugin end-to-end (registry -> manifest -> loader -> broker)", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "greeter",
      {
        id: "greeter",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: ["demo:greet"], requires: [] },
        entry_point: "index.js",
      },
      { "index.js": 'export const provides = {\n  "demo:greet": () => "hello",\n};\n' },
    );
    writePluginDir(
      pluginsRoot,
      "consumer",
      {
        id: "consumer",
        version: "1.0.0",
        depends_on: { greeter: "^1.0.0" },
        capabilities: { provides: [], requires: ["demo:greet"] },
        entry_point: "index.js",
      },
      { "index.js": "export {};\n" },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.failed).toEqual([]);
    expect(kernel.plugins.loaded.map((plugin) => plugin.id).sort()).toEqual([
      "consumer",
      "greeter",
    ]);
    // Dependency order: greeter (the dependency) must precede consumer.
    expect(kernel.plugins.order.indexOf("greeter")).toBeLessThan(
      kernel.plugins.order.indexOf("consumer"),
    );

    const consumer = kernel.plugins.loaded.find((plugin) => plugin.id === "consumer");
    expect(consumer).toBeDefined();
    const obtained = consumer?.context.capabilities.obtain<() => string>("demo:greet");
    expect(obtained !== undefined && isOk(obtained)).toBe(true);
    if (obtained !== undefined && isOk(obtained)) {
      expect(obtained.value()).toBe("hello");
    }
  });

  it("isolates a plugin whose entry point cannot be imported without crashing the whole boot", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(pluginsRoot, "broken", {
      id: "broken",
      version: "1.0.0",
      depends_on: {},
      capabilities: { provides: [], requires: [] },
      entry_point: "index.js",
    });
    // Note: "broken/index.js" is never written.

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.loaded).toEqual([]);
    expect(kernel.plugins.failed).toHaveLength(1);
    expect(kernel.plugins.failed[0]?.id).toBe("broken");
    expect(kernel.plugins.failed[0]?.skipped).toBe(false);
    expect(kernel.plugins.failed[0]?.error.message).toContain("entry point");
  });

  it("skips a plugin with a schema-invalid manifest without crashing the whole boot", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(pluginsRoot, "bad-id", {
      id: "NOT-VALID-ID",
      version: "1.0.0",
      depends_on: {},
      entry_point: "index.js",
    });

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.loaded).toEqual([]);
    expect(kernel.plugins.failed).toEqual([]);
  });

  it("is fatal on invalid core config, rejecting with a ConfigError", async () => {
    const pluginsRoot = trackedTempRoot();

    await expect(
      bootstrapKernel({ pluginsRoot, env: { PORT: "not-a-number" } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("is fatal when the plugins root itself does not exist, rejecting with a PluginLoadError", async () => {
    const missingRoot = path.join(tmpdir(), `appskeleton-does-not-exist-${String(Date.now())}`);

    await expect(bootstrapKernel({ pluginsRoot: missingRoot, env: {} })).rejects.toBeInstanceOf(
      PluginLoadError,
    );
  });

  it("is fatal on a structural dependency-graph error (a cycle), even when neither plugin's entry point can be imported", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(pluginsRoot, "a", {
      id: "a",
      version: "1.0.0",
      depends_on: { b: "^1.0.0" },
      entry_point: "index.js",
    });
    writePluginDir(pluginsRoot, "b", {
      id: "b",
      version: "1.0.0",
      depends_on: { a: "^1.0.0" },
      entry_point: "index.js",
    });
    // Note: neither "a/index.js" nor "b/index.js" is ever written — the
    // cycle must still be detected from the manifests' depends_on alone.

    let caught: unknown;
    try {
      await bootstrapKernel({ pluginsRoot, env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as PluginLoadError).message).toContain("Circular dependency");
  });
});

describe("bootstrapKernel — kernel.introspect()", () => {
  it("reports every discovered plugin's id, version, status, and granted capabilities end-to-end", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "greeter",
      {
        id: "greeter",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: ["demo:greet"], requires: [] },
        entry_point: "index.js",
      },
      { "index.js": 'export const provides = {\n  "demo:greet": () => "hello",\n};\n' },
    );
    writePluginDir(
      pluginsRoot,
      "consumer",
      {
        id: "consumer",
        version: "1.0.0",
        depends_on: { greeter: "^1.0.0" },
        capabilities: { provides: [], requires: ["demo:greet"] },
        entry_point: "index.js",
      },
      { "index.js": "export {};\n" },
    );
    writePluginDir(pluginsRoot, "broken", {
      id: "broken",
      version: "1.0.0",
      depends_on: {},
      capabilities: { provides: [], requires: [] },
      entry_point: "index.js",
    });
    // Note: "broken/index.js" is never written, so it fails to import().

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });
    const report = kernel.introspect();

    const greeter = report.plugins.find((plugin) => plugin.id === "greeter");
    const consumer = report.plugins.find((plugin) => plugin.id === "consumer");
    const broken = report.plugins.find((plugin) => plugin.id === "broken");

    expect(greeter).toMatchObject({ id: "greeter", version: "1.0.0", status: "loaded" });
    expect(consumer).toMatchObject({
      id: "consumer",
      version: "1.0.0",
      status: "loaded",
      capabilities: { requires: ["demo:greet"], granted: ["demo:greet"] },
    });
    expect(broken).toMatchObject({
      id: "broken",
      version: "1.0.0",
      status: "failed",
      skipped: false,
    });
    expect(broken?.error).toContain("entry point");
    expect(report.summary).toEqual({ total: 3, loaded: 2, failed: 1, disabled: 0 });
  });

  it("reflects a plugin marked disabled via kernel.pluginStatus, without affecting other loaded plugins", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "leaf-a",
      {
        id: "leaf-a",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: [], requires: [] },
        entry_point: "index.js",
      },
      { "index.js": "export {};\n" },
    );
    writePluginDir(
      pluginsRoot,
      "leaf-b",
      {
        id: "leaf-b",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: [], requires: [] },
        entry_point: "index.js",
      },
      { "index.js": "export {};\n" },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });
    expect(kernel.plugins.failed).toEqual([]);

    kernel.pluginStatus.disable("leaf-a");
    const report = kernel.introspect();

    expect(report.plugins.find((plugin) => plugin.id === "leaf-a")?.status).toBe("disabled");
    expect(report.plugins.find((plugin) => plugin.id === "leaf-b")?.status).toBe("loaded");
    expect(report.summary).toEqual({ total: 2, loaded: 1, failed: 0, disabled: 1 });

    kernel.pluginStatus.enable("leaf-a");
    expect(kernel.introspect().plugins.find((plugin) => plugin.id === "leaf-a")?.status).toBe(
      "loaded",
    );
  });

  it("returns an empty report with zero counts when no plugins are present", async () => {
    const pluginsRoot = trackedTempRoot();

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });
    const report = kernel.introspect();

    expect(report.plugins).toEqual([]);
    expect(report.summary).toEqual({ total: 0, loaded: 0, failed: 0, disabled: 0 });
  });
});

describe("formatFatalStartupError", () => {
  it("formats an AppError as a single line with its code and message, never a stack trace", () => {
    const error = new ConfigError("Invalid configuration: PORT is required");

    const formatted = formatFatalStartupError(error);

    expect(formatted).toBe("CONFIG_ERROR: Invalid configuration: PORT is required");
    expect(formatted).not.toMatch(/\n/);
  });

  it("formats a plain Error by its message only, ignoring its stack", () => {
    const error = new Error("boom");

    const formatted = formatFatalStartupError(error);

    expect(formatted).toBe("boom");
    expect(formatted).not.toMatch(/\bat\b.*:\d+:\d+/);
  });

  it("formats a non-Error throw safely", () => {
    expect(formatFatalStartupError("just a string")).toBe("just a string");
  });
});

describe("buildServer", () => {
  it("still answers /health with the bare shape when built without a kernel (toolchain smoke test compatibility)", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("includes plugin load counts in /health when built with a kernel", async () => {
    const pluginsRoot = trackedTempRoot();
    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    const app = buildServer({ kernel });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ status: "ok", plugins: { loaded: 0, failed: 0 } });
    await app.close();
  });
});
