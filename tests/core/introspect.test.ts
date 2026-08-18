import { describe, expect, it } from "vitest";
import { createCapabilityBroker, type CapabilityBroker } from "../../src/core/broker.js";
import {
  formatIntrospectionReport,
  introspectKernel,
  introspectKernelWithHealth,
} from "../../src/core/introspect.js";
import { loadPlugins, type PluginDefinition, type PluginModule } from "../../src/core/loader.js";
import type { PluginManifest } from "../../src/core/manifest.js";
import { createPluginStatusTracker } from "../../src/core/plugin-status.js";
import { isOk } from "../../src/core/types.js";

/** Assert Ok and return the value, or fail the test with a readable message — mirrors loader.test.ts's own helper. */
function expectOk<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isOk(result as never)) {
    expect.fail(`expected Ok, got Err: ${JSON.stringify((result as { error?: unknown }).error)}`);
  }
  return (result as { ok: true; value: T }).value;
}

/** Build a minimal, schema-shaped manifest fixture without going through validateManifest() — mirrors loader.test.ts's own helper. */
function manifest(
  id: string,
  options: {
    dependsOn?: Record<string, string>;
    provides?: string[];
    requires?: string[];
    version?: string;
  } = {},
): PluginManifest {
  return {
    id,
    version: options.version ?? "1.0.0",
    depends_on: options.dependsOn ?? {},
    capabilities: { provides: options.provides ?? [], requires: options.requires ?? [] },
    entry_point: "index.ts",
  };
}

/** A plugin module with no hooks, optionally providing capability implementations. */
function moduleFixture(overrides: Partial<PluginModule> = {}): PluginModule {
  return { ...overrides };
}

describe("introspectKernel", () => {
  it("reports a loaded plugin's id, version, status, and currently-granted capabilities", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("provider", { version: "2.1.0", provides: ["demo:greet"] }),
        module: moduleFixture({ provides: { "demo:greet": () => "hi" } }),
      },
      {
        manifest: manifest("consumer", {
          version: "1.0.0",
          dependsOn: { provider: "^2.0.0" },
          requires: ["demo:greet"],
        }),
        module: moduleFixture(),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = introspectKernel(result, broker);

    expect(report.plugins).toHaveLength(2);
    const provider = report.plugins.find((plugin) => plugin.id === "provider");
    const consumer = report.plugins.find((plugin) => plugin.id === "consumer");

    expect(provider).toEqual({
      id: "provider",
      version: "2.1.0",
      status: "loaded",
      capabilities: { provides: ["demo:greet"], requires: [], granted: [] },
    });
    expect(consumer).toEqual({
      id: "consumer",
      version: "1.0.0",
      status: "loaded",
      capabilities: { provides: [], requires: ["demo:greet"], granted: ["demo:greet"] },
    });
    expect(report.summary).toEqual({ total: 2, loaded: 2, failed: 0, disabled: 0 });
  });

  it("reports a failed plugin's status, its error message, and whether it was skipped due to a failed dependency", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken"),
        module: moduleFixture({
          onInstall: () => {
            throw new Error("broken boom");
          },
        }),
      },
      {
        manifest: manifest("dependent", { dependsOn: { broken: "^1.0.0" } }),
        module: moduleFixture(),
      },
      { manifest: manifest("solo"), module: moduleFixture() },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = introspectKernel(result, broker);

    const broken = report.plugins.find((plugin) => plugin.id === "broken");
    const dependent = report.plugins.find((plugin) => plugin.id === "dependent");
    const solo = report.plugins.find((plugin) => plugin.id === "solo");

    expect(broken?.status).toBe("failed");
    expect(broken?.skipped).toBe(false);
    expect(broken?.error).toContain("broken boom");
    expect(broken?.capabilities.granted).toEqual([]);

    expect(dependent?.status).toBe("failed");
    expect(dependent?.skipped).toBe(true);
    expect(dependent?.error).toContain("broken");

    expect(solo?.status).toBe("loaded");

    expect(report.summary).toEqual({ total: 3, loaded: 1, failed: 2, disabled: 0 });
  });

  it("reports a loaded plugin as disabled when the plugin status tracker marks it disabled, leaving other plugins unaffected", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("leaf-a"), module: moduleFixture() },
      { manifest: manifest("leaf-b"), module: moduleFixture() },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));
    const statusTracker = createPluginStatusTracker();
    statusTracker.disable("leaf-a");

    const report = introspectKernel(result, broker, statusTracker);

    const leafA = report.plugins.find((plugin) => plugin.id === "leaf-a");
    const leafB = report.plugins.find((plugin) => plugin.id === "leaf-b");
    expect(leafA?.status).toBe("disabled");
    expect(leafB?.status).toBe("loaded");
    expect(report.summary).toEqual({ total: 2, loaded: 1, failed: 0, disabled: 1 });
  });

  it("re-enabling via the status tracker flips a plugin's reported status back to loaded", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("leaf"), module: moduleFixture() },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));
    const statusTracker = createPluginStatusTracker();

    statusTracker.disable("leaf");
    expect(introspectKernel(result, broker, statusTracker).plugins[0]?.status).toBe("disabled");

    statusTracker.enable("leaf");
    expect(introspectKernel(result, broker, statusTracker).plugins[0]?.status).toBe("loaded");
  });

  it("reads granted capabilities live from the broker, reflecting a revoke made after loading", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("provider", { provides: ["svc:x"] }),
        module: moduleFixture({ provides: { "svc:x": () => "ok" } }),
      },
      {
        manifest: manifest("consumer", {
          dependsOn: { provider: "^1.0.0" },
          requires: ["svc:x"],
        }),
        module: moduleFixture(),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));
    expect(
      introspectKernel(result, broker).plugins.find((p) => p.id === "consumer")?.capabilities
        .granted,
    ).toEqual(["svc:x"]);

    broker.revoke("consumer", "svc:x");

    const report = introspectKernel(result, broker);
    expect(report.plugins.find((plugin) => plugin.id === "consumer")?.capabilities.granted).toEqual(
      [],
    );
  });

  it("orders the report by the loader's dependency order", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("c", { dependsOn: { b: "^1.0.0" } }), module: moduleFixture() },
      { manifest: manifest("b", { dependsOn: { a: "^1.0.0" } }), module: moduleFixture() },
      { manifest: manifest("a"), module: moduleFixture() },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = introspectKernel(result, broker);

    expect(report.plugins.map((plugin) => plugin.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty report with all-zero summary counts for zero plugins", () => {
    const broker: CapabilityBroker = createCapabilityBroker();
    const report = introspectKernel({ order: [], loaded: [], failed: [] }, broker);

    expect(report.plugins).toEqual([]);
    expect(report.summary).toEqual({ total: 0, loaded: 0, failed: 0, disabled: 0 });
  });
});

describe("formatIntrospectionReport", () => {
  it("renders each plugin's id@version, status, and capability lists, plus a summary line", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("provider", { version: "1.2.3", provides: ["demo:greet"] }),
        module: moduleFixture({ provides: { "demo:greet": () => "hi" } }),
      },
      {
        manifest: manifest("consumer", {
          version: "0.1.0",
          dependsOn: { provider: "^1.0.0" },
          requires: ["demo:greet"],
        }),
        module: moduleFixture(),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const text = formatIntrospectionReport(introspectKernel(result, broker));

    expect(text).toContain("provider@1.2.3");
    expect(text).toContain("consumer@0.1.0");
    expect(text).toContain("loaded");
    expect(text).toContain("granted:  demo:greet");
    expect(text).toContain("provides: demo:greet");
    expect(text).toContain("Summary: 2 total — 2 loaded, 0 failed, 0 disabled.");
  });

  it("renders a failed plugin's error message and a skipped note for a cascaded failure", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken"),
        module: moduleFixture({
          onInstall: () => {
            throw new Error("kaboom");
          },
        }),
      },
      {
        manifest: manifest("dependent", { dependsOn: { broken: "^1.0.0" } }),
        module: moduleFixture(),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const text = formatIntrospectionReport(introspectKernel(result, broker));

    expect(text).toContain("broken@1.0.0 — failed");
    expect(text).toContain("kaboom");
    expect(text).toContain("dependent@1.0.0 — failed");
    expect(text).toContain("(skipped — a dependency failed to load)");
  });

  it("shows a disabled plugin's status and marks capability lists (none) when empty", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("leaf"), module: moduleFixture() },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));
    const statusTracker = createPluginStatusTracker();
    statusTracker.disable("leaf");

    const text = formatIntrospectionReport(introspectKernel(result, broker, statusTracker));

    expect(text).toContain("leaf@1.0.0 — disabled");
    expect(text).toContain("provides: (none)");
    expect(text).toContain("requires: (none)");
    expect(text).toContain("granted:  (none)");
    expect(text).toContain("Summary: 1 total — 0 loaded, 0 failed, 1 disabled.");
  });

  it("renders a placeholder line when there are no plugins at all", () => {
    const broker = createCapabilityBroker();
    const text = formatIntrospectionReport(
      introspectKernel({ order: [], loaded: [], failed: [] }, broker),
    );

    expect(text).toContain("(no plugins loaded)");
    expect(text).toContain("Summary: 0 total — 0 loaded, 0 failed, 0 disabled.");
  });

  it("renders a metrics-capable plugin's query count, error count, and average duration (feature #26)", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("database-mysql", { provides: ["db:query"] }),
        module: moduleFixture({
          provides: {
            "db:query": {
              getMetrics: () => ({ queryCount: 5, errorCount: 1, averageDurationMs: 12.34 }),
            },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const text = formatIntrospectionReport(introspectKernel(result, broker));

    expect(text).toContain("metrics:  5 queries, 1 errors, 12.3ms avg");
  });
});

describe("introspectKernelWithHealth (feature #24 — database health check integrated into kernel introspection)", () => {
  it("reports 'unhealthy' for a plugin whose db:query-shaped capability's healthCheck() resolves healthy: false", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("database-mysql", { provides: ["db:query"] }),
        module: moduleFixture({
          provides: {
            "db:query": {
              query: async () => {
                throw new Error("unused in this test");
              },
              // Mirrors query-capability.ts's DbQueryCapability.healthCheck
              // contract: a trivial SELECT 1 that failed because the
              // database is unreachable, normalized to a resolved (not
              // rejected) result.
              healthCheck: async () => ({
                healthy: false,
                error: "connect ECONNREFUSED 127.0.0.1:3306",
              }),
            },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = await introspectKernelWithHealth(result, broker);

    const plugin = report.plugins.find((p) => p.id === "database-mysql");
    expect(plugin?.health).toEqual({
      status: "unhealthy",
      error: "connect ECONNREFUSED 127.0.0.1:3306",
    });
  });

  it("reports 'unhealthy' when the capability's healthCheck() rejects instead of resolving, rather than throwing out of introspection", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("database-mysql", { provides: ["db:query"] }),
        module: moduleFixture({
          provides: {
            "db:query": {
              query: async () => "unused",
              healthCheck: async () => {
                throw new Error("connect ETIMEDOUT");
              },
            },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = await introspectKernelWithHealth(result, broker);

    expect(report.plugins.find((p) => p.id === "database-mysql")?.health).toEqual({
      status: "unhealthy",
      error: "connect ETIMEDOUT",
    });
  });

  it("reports 'healthy' for a plugin whose capability's healthCheck() resolves healthy: true", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("database-mysql", { provides: ["db:query"] }),
        module: moduleFixture({
          provides: {
            "db:query": {
              query: async () => "unused",
              healthCheck: async () => ({ healthy: true }),
            },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = await introspectKernelWithHealth(result, broker);

    expect(report.plugins.find((p) => p.id === "database-mysql")?.health).toEqual({
      status: "healthy",
    });
  });

  it("omits the health field entirely for a plugin that provides no health-checkable capability", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("html-renderer", { provides: ["render:template"] }),
        module: moduleFixture({ provides: { "render:template": () => "<html></html>" } }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = await introspectKernelWithHealth(result, broker);

    const plugin = report.plugins.find((p) => p.id === "html-renderer");
    expect(plugin).toBeDefined();
    expect(plugin?.health).toBeUndefined();
    expect("health" in (plugin ?? {})).toBe(false);
  });

  it("leaves a failed plugin's report untouched — no health field, since there is no live module to probe", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken"),
        module: moduleFixture({
          onInstall: () => {
            throw new Error("boom");
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = await introspectKernelWithHealth(result, broker);

    const broken = report.plugins.find((p) => p.id === "broken");
    expect(broken?.status).toBe("failed");
    expect(broken?.health).toBeUndefined();
  });

  it("is unhealthy overall when only one of several health-checkable capabilities a plugin provides is unhealthy", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("multi", { provides: ["db:query", "cache:get"] }),
        module: moduleFixture({
          provides: {
            "db:query": { healthCheck: async () => ({ healthy: true }) },
            "cache:get": { healthCheck: async () => ({ healthy: false, error: "cache down" }) },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = await introspectKernelWithHealth(result, broker);

    expect(report.plugins.find((p) => p.id === "multi")?.health?.status).toBe("unhealthy");
  });

  it("does not mutate or otherwise alter the plain introspectKernel() report for an unrelated call [health]", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("database-mysql", { provides: ["db:query"] }),
        module: moduleFixture({
          provides: {
            "db:query": { healthCheck: async () => ({ healthy: false, error: "down" }) },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const plainReport = introspectKernel(result, broker);
    expect(plainReport.plugins[0]?.health).toBeUndefined();
    expect("health" in (plainReport.plugins[0] ?? {})).toBe(false);
  });
});

describe("introspectKernel — basic query performance metrics (feature #26)", () => {
  it("reports a metrics-capable capability's queryCount/errorCount/averageDurationMs on the plain, synchronous report", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("database-mysql", { provides: ["db:query"] }),
        module: moduleFixture({
          provides: {
            "db:query": {
              getMetrics: () => ({ queryCount: 42, errorCount: 3, averageDurationMs: 12.5 }),
            },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    // No `introspectKernelWithHealth`-style async wrapper needed — see
    // this module's "Basic query performance metrics" docs for why.
    const report = introspectKernel(result, broker);

    expect(report.plugins.find((p) => p.id === "database-mysql")?.metrics).toEqual({
      queryCount: 42,
      errorCount: 3,
      averageDurationMs: 12.5,
    });
  });

  it("omits the metrics field entirely for a plugin that provides no metrics-capable capability", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("html-renderer", { provides: ["render:template"] }),
        module: moduleFixture({ provides: { "render:template": () => "<html></html>" } }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = introspectKernel(result, broker);

    const plugin = report.plugins.find((p) => p.id === "html-renderer");
    expect(plugin).toBeDefined();
    expect(plugin?.metrics).toBeUndefined();
    expect("metrics" in (plugin ?? {})).toBe(false);
  });

  it("leaves a failed plugin's report untouched — no metrics field, since there is no live module to read counters from", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken"),
        module: moduleFixture({
          onInstall: () => {
            throw new Error("boom");
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = introspectKernel(result, broker);

    const broken = report.plugins.find((p) => p.id === "broken");
    expect(broken?.status).toBe("failed");
    expect(broken?.metrics).toBeUndefined();
  });

  it("combines multiple metrics-capable capabilities a plugin provides into one count-weighted snapshot", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("multi", { provides: ["db:query", "cache:get"] }),
        module: moduleFixture({
          provides: {
            "db:query": {
              getMetrics: () => ({ queryCount: 8, errorCount: 2, averageDurationMs: 10 }),
            },
            "cache:get": {
              getMetrics: () => ({ queryCount: 2, errorCount: 0, averageDurationMs: 100 }),
            },
          },
        }),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = introspectKernel(result, broker);

    // queryCount: 8 + 2 = 10; errorCount: 2 + 0 = 2;
    // averageDurationMs: (8*10 + 2*100) / 10 = 28 — a count-weighted mean,
    // not a plain average of the two averages (which would give 55).
    expect(report.plugins.find((p) => p.id === "multi")?.metrics).toEqual({
      queryCount: 10,
      errorCount: 2,
      averageDurationMs: 28,
    });
  });

  it("does not mutate or otherwise alter the plain introspectKernel() report for an unrelated call [metrics omitted]", async () => {
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("leaf"), module: moduleFixture() },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));

    const report = introspectKernel(result, broker);

    expect(report.plugins[0]?.metrics).toBeUndefined();
    expect("metrics" in (report.plugins[0] ?? {})).toBe(false);
  });
});
