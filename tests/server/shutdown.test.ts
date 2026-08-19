import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapKernel, shutdownKernel } from "../../src/server/index.js";

/** Repo root — two levels up from this file (`tests/server/shutdown.test.ts`). */
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

/** Poll `GET /health` on `port` until it responds (or `deadlineMs` elapses), proving the child has finished booting and is actually listening. */
async function waitForHealthy(port: number, deadlineMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // Not listening yet — keep polling.
    }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`Server on port ${String(port)} never became healthy.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete (globalThis as { __shutdownOrder?: string[] }).__shutdownOrder;
});

function trackedTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "appskeleton-shutdown-"));
  tempRoots.push(root);
  return root;
}

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

describe("shutdownKernel", () => {
  it("closes the HTTP server (stop-accepting + drain) fully before tearing down other plugins (e.g. the DB pool)", async () => {
    const pluginsRoot = trackedTempRoot();

    // Fixture shaped like api-gateway's own http:route wiring, but its fake
    // "app" just records ordering into a process-global array instead of
    // running a real Fastify instance — this test only cares about
    // sequencing, not HTTP behavior itself (that's covered elsewhere).
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
      {
        "index.js": `
          let app;
          export const provides = { "http:route": { getApp: () => app } };
          export function onEnable() {
            globalThis.__shutdownOrder ??= [];
            app = {
              close: async () => {
                globalThis.__shutdownOrder.push("http-close-start");
                await new Promise((r) => setTimeout(r, 20));
                globalThis.__shutdownOrder.push("http-close-end");
              },
            };
          }
        `,
      },
    );

    // Fixture shaped like database-mysql's onDisable (which is what actually
    // closes the mysql2 pool) — records ordering the same way.
    writePluginDir(
      pluginsRoot,
      "database-mysql",
      {
        id: "database-mysql",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: [], requires: [] },
        entry_point: "index.js",
      },
      {
        "index.js": `
          export async function onDisable() {
            globalThis.__shutdownOrder ??= [];
            globalThis.__shutdownOrder.push("db-close-start");
            await new Promise((r) => setTimeout(r, 5));
            globalThis.__shutdownOrder.push("db-close-end");
          }
        `,
      },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });
    expect(kernel.plugins.failed).toEqual([]);
    expect(kernel.httpApp).toBeDefined();

    await shutdownKernel(kernel);

    expect((globalThis as { __shutdownOrder?: string[] }).__shutdownOrder).toEqual([
      "http-close-start",
      "http-close-end",
      "db-close-start",
      "db-close-end",
    ]);
  });

  it("still unloads every plugin (closing the DB pool) even when there is no HTTP server at all", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "database-mysql",
      {
        id: "database-mysql",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: [], requires: [] },
        entry_point: "index.js",
      },
      {
        "index.js": `
          export async function onDisable() {
            globalThis.__shutdownOrder ??= [];
            globalThis.__shutdownOrder.push("db-close");
          }
        `,
      },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });
    expect(kernel.httpApp).toBeUndefined();

    await shutdownKernel(kernel);

    expect((globalThis as { __shutdownOrder?: string[] }).__shutdownOrder).toEqual(["db-close"]);
  });

  it("rejects once the hard timeout elapses rather than waiting forever on a hung plugin teardown", async () => {
    const pluginsRoot = trackedTempRoot();
    writePluginDir(
      pluginsRoot,
      "stuck",
      {
        id: "stuck",
        version: "1.0.0",
        depends_on: {},
        capabilities: { provides: [], requires: [] },
        entry_point: "index.js",
      },
      {
        "index.js": `
          export async function onDisable() {
            // Never resolves — simulates a hung teardown hook.
            await new Promise(() => {});
          }
        `,
      },
    );

    const kernel = await bootstrapKernel({ pluginsRoot, env: {} });

    const start = Date.now();
    await expect(shutdownKernel(kernel, { timeoutMs: 50 })).rejects.toThrow(/did not complete/);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("process-level graceful shutdown on SIGTERM (feature #111, step 3)", () => {
  it("exits cleanly (code 0) within the shutdown timeout after receiving SIGTERM, without leaving the port bound", async () => {
    const port = await findFreePort();

    const child = spawn(TSX_BIN, [REAL_SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port) },
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

    try {
      await waitForHealthy(port);

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (exitCode, signal) => resolve({ code: exitCode, signal }));
        },
      );

      const start = Date.now();
      child.kill("SIGTERM");

      const { code } = await exitPromise;
      const elapsedMs = Date.now() - start;

      // Clean, deliberate exit (process.exit(0) from inside the handler,
      // not the process being torn down by the signal itself) and well
      // within the (10s default) hard shutdown timeout.
      expect(code).toBe(0);
      expect(elapsedMs).toBeLessThan(10_000);

      // A fresh connection attempt on the same port must now fail — the
      // HTTP server really stopped listening rather than the process
      // merely disappearing while a socket lingered.
      await expect(waitForHealthy(port, 500)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }

    expect(stderr).not.toContain("Fatal startup error");
    expect(stdout + stderr).not.toBe("");
  }, 15_000);

  it("also exits cleanly on SIGINT", async () => {
    const port = await findFreePort();

    const child = spawn(TSX_BIN, [REAL_SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHealthy(port);

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (exitCode, signal) => resolve({ code: exitCode, signal }));
        },
      );

      child.kill("SIGINT");
      const { code } = await exitPromise;

      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }, 15_000);
});
