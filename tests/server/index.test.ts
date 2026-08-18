import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, PluginLoadError } from "../../src/core/errors.js";
import { isOk } from "../../src/core/types.js";
import { bootstrapKernel, formatFatalStartupError, listen } from "../../src/server/index.js";

/** Real `src/plugins` root — proves the wiring works against the actual shipped tree. */
const REAL_PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/plugins",
);

/** Repo root — two levels up from this file (`tests/server/index.test.ts`). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REAL_SERVER_ENTRY = path.join(REPO_ROOT, "src/server/index.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

/** Ask the OS for a currently-free TCP port by briefly binding to port 0 and reading it back. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("Could not determine a free port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

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
    // No api-gateway plugin present at all — nothing constructed a Fastify
    // instance for this boot, so there is nothing to mount/listen on.
    expect(kernel.httpApp).toBeUndefined();
  });

  it("boots cleanly against the real src/plugins tree without throwing", async () => {
    const kernel = await bootstrapKernel({ pluginsRoot: REAL_PLUGINS_ROOT, env: {} });

    // Most currently-shipped manifests still declare an entry_point that
    // doesn't exist on disk yet (see claude-progress.txt) — each becomes an
    // isolated, logged failure rather than crashing the boot, so this only
    // asserts the shape holds, not exact counts (which would grow brittle
    // as later features add real plugin lifecycle modules).
    expect(Array.isArray(kernel.plugins.loaded)).toBe(true);
    expect(Array.isArray(kernel.plugins.failed)).toBe(true);

    // api-gateway (feature #58) does have a real lifecycle module now — its
    // onEnable hook should have constructed a live Fastify instance, mounted
    // into the kernel via kernel.httpApp.
    expect(kernel.httpApp).toBeDefined();
    const res = await kernel.httpApp?.inject({ method: "GET", url: "/health" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json()).toEqual({ status: "ok" });
    await kernel.httpApp?.close();
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

describe("bootstrapKernel — kernel.introspectWithHealth() (feature #24)", () => {
  it("reports 'unhealthy' end-to-end for a plugin whose provided capability's healthCheck() fails, without disturbing an unrelated healthy plugin", async () => {
    const pluginsRoot = trackedTempRoot();
    // Stands in for database-mysql's real db:query capability (whose
    // healthCheck() runs a live SELECT 1) without needing an actual MySQL
    // connection — proves the *wiring* end-to-end through a real
    // bootstrapKernel(), same as this file's other kernel.introspect() tests.
    writePluginDir(
      pluginsRoot,
      "flaky-db",
      {
        id: "flaky-db",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: ["db:query"], requires: [] },
        entry_point: "index.js",
      },
      {
        "index.js":
          "export const provides = {\n" +
          '  "db:query": {\n' +
          "    query: async () => { throw new Error(\"unused\"); },\n" +
          "    healthCheck: async () => ({ healthy: false, error: \"connect ECONNREFUSED\" }),\n" +
          "  },\n" +
          "};\n",
      },
    );
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

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });
    const report = await kernel.introspectWithHealth();

    expect(report.plugins.find((plugin) => plugin.id === "flaky-db")?.health).toEqual({
      status: "unhealthy",
      error: "connect ECONNREFUSED",
    });
    // A plugin with nothing health-checkable is unaffected — no `health` key at all.
    const greeter = report.plugins.find((plugin) => plugin.id === "greeter");
    expect(greeter?.status).toBe("loaded");
    expect(greeter?.health).toBeUndefined();
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

describe("kernel.httpApp — Fastify owned by api-gateway, mounted into the kernel (feature #58)", () => {
  /** A fixture plugin shaped like api-gateway's own `index.ts`: constructs a Fastify instance in `onEnable` and exposes it via `http:route`. */
  const FIXTURE_API_GATEWAY_INDEX = `
    import Fastify from "fastify";
    let app;
    export const provides = {
      "http:route": { getApp: () => app },
    };
    export function onEnable() {
      app = Fastify({ logger: false });
      app.get("/health", async () => ({ status: "ok" }));
    }
  `;

  it("is undefined when no plugin named api-gateway is loaded (present but unrelated plugins)", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "unrelated",
      {
        id: "unrelated",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: [], requires: [] },
        entry_point: "index.js",
      },
      { "index.js": "export {};\n" },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.loaded.map((plugin) => plugin.id)).toEqual(["unrelated"]);
    expect(kernel.httpApp).toBeUndefined();
  });

  it("is undefined when api-gateway is present but fails to load", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(pluginsRoot, "api-gateway", {
      id: "api-gateway",
      version: "1.0.0",
      depends_on: {},
      capabilities: { provides: ["http:route"], requires: [] },
      entry_point: "index.js",
    });
    // Note: "api-gateway/index.js" is never written, so it fails to import().

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.failed.map((plugin) => plugin.id)).toEqual(["api-gateway"]);
    expect(kernel.httpApp).toBeUndefined();
  });

  it("is undefined, without throwing, when api-gateway's http:route provider doesn't have the expected shape", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "api-gateway",
      {
        id: "api-gateway",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: ["http:route"], requires: [] },
        entry_point: "index.js",
      },
      { "index.js": 'export const provides = { "http:route": "not-an-app" };\n' },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.plugins.loaded.map((plugin) => plugin.id)).toEqual(["api-gateway"]);
    expect(kernel.httpApp).toBeUndefined();
  });

  it("is the live Fastify instance api-gateway's onEnable constructed, answering /health end-to-end", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "api-gateway",
      {
        id: "api-gateway",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: ["http:route"], requires: [] },
        entry_point: "index.js",
      },
      { "index.js": FIXTURE_API_GATEWAY_INDEX },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.httpApp).toBeDefined();
    const res = await kernel.httpApp?.inject({ method: "GET", url: "/health" });
    expect(res?.statusCode).toBe(200);
    expect(res?.json()).toEqual({ status: "ok" });
    await kernel.httpApp?.close();
  });

  it("against the real src/plugins tree, is the same Fastify instance the real api-gateway plugin constructed", async () => {
    const kernel = await bootstrapKernel({ pluginsRoot: REAL_PLUGINS_ROOT, env: {} });

    expect(kernel.plugins.loaded.map((plugin) => plugin.id)).toContain("api-gateway");
    expect(kernel.httpApp).toBeDefined();
    await kernel.httpApp?.close();
  });
});

describe("listen — starts the HTTP server only after every plugin has finished loading (feature #58, step 2)", () => {
  it("rejects with a PluginLoadError instead of attempting to listen when kernel.httpApp is undefined", async () => {
    const pluginsRoot = trackedTempRoot();
    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    expect(kernel.httpApp).toBeUndefined();
    await expect(listen(kernel)).rejects.toBeInstanceOf(PluginLoadError);
  });

  it("starts listening on the kernel's resolved port/host using the api-gateway-owned Fastify instance", async () => {
    // CoreConfigSchema requires PORT >= 1 (see config.ts), so this can't ask
    // the OS for an ephemeral port via "0" the way a raw net.Server could —
    // find one directly instead, so this test can't collide with anything
    // else already listening on the host.
    const freePort = await findFreePort();

    const kernel = await bootstrapKernel({
      pluginsRoot: REAL_PLUGINS_ROOT,
      env: { PORT: String(freePort) },
    });
    expect(kernel.httpApp).toBeDefined();
    expect(kernel.config.PORT).toBe(freePort);

    await listen(kernel);
    try {
      expect(kernel.httpApp?.server.listening).toBe(true);
    } finally {
      await kernel.httpApp?.close();
    }
  });
});

describe("process-level fail-fast on invalid config (feature #117)", () => {
  it(
    "exits non-zero with a single clear message naming the offending variable, and never binds the port",
    async () => {
      // Occupy a real, known port ourselves *before* spawning the child, and
      // keep it listening for the whole test. If `main()` ever reached
      // `listen()` — i.e. if config validation didn't abort the boot before
      // any plugin/HTTP work started — Fastify's own `.listen()` call would
      // collide with this probe (EADDRINUSE) instead of exiting cleanly with
      // just the ConfigError below, and the probe would stop being able to
      // accept new connections. So "the probe still happily accepts a
      // connection after the child has exited" is direct, positive proof the
      // child process never so much as attempted to bind a port — not just
      // that a port happens to be free afterward.
      const probe = createServer((socket) => socket.end());
      const port = await new Promise<number>((resolve, reject) => {
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Could not determine the probe's port."));
            return;
          }
          resolve(address.port);
        });
      });

      try {
        // LOG_LEVEL set to an invalid enum value is the one thing wrong with
        // this config — PORT itself is valid (and equal to the probe's own
        // port), so any attempt to listen would be unambiguously a bug, not
        // an unrelated port conflict.
        const child = spawn(TSX_BIN, [REAL_SERVER_ENTRY], {
          cwd: REPO_ROOT,
          env: { ...process.env, PORT: String(port), LOG_LEVEL: "not-a-real-level" },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf-8");
        });

        const { code } = await new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            child.on("error", reject);
            child.on("exit", (exitCode, signal) => resolve({ code: exitCode, signal }));
          },
        );

        // Fails fast and non-zero — never a partial/half-started server left
        // hanging with a zero (success-looking) exit code.
        expect(code).not.toBeNull();
        expect(code).not.toBe(0);

        // A single clear line identifying the offending variable, no stack trace.
        const stderrLines = stderr.trim().split("\n");
        expect(stderrLines).toHaveLength(1);
        expect(stderr).toContain("Fatal startup error:");
        expect(stderr).toContain("CONFIG_ERROR");
        expect(stderr).toContain("LOG_LEVEL");
        expect(stderr).not.toMatch(/\bat\b.*:\d+:\d+/);

        // Nothing was ever printed suggesting the kernel finished booting or
        // an HTTP server came up.
        expect(stdout.trim()).toBe("");
        expect(stdout).not.toContain("Kernel bootstrap complete");

        // The probe — not the child — still exclusively owns the port: a
        // fresh connection succeeds and is served by the probe, proving the
        // child process exited before ever binding it.
        await new Promise<void>((resolve, reject) => {
          const socket = connect({ port, host: "127.0.0.1" }, () => {
            socket.end();
          });
          socket.on("close", resolve);
          socket.on("error", reject);
        });
      } finally {
        await new Promise<void>((resolve) => probe.close(() => resolve()));
      }
    },
    15_000,
  );
});
