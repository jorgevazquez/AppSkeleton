import { describe, expect, it } from "vitest";
import { createCapabilityBroker, type CapabilityBroker } from "../../src/core/broker.js";
import { CapabilityDeniedError, PluginLoadError } from "../../src/core/errors.js";
import {
  grantAllDeclared,
  loadPlugins,
  unloadPlugins,
  type LoadedPlugin,
  type PluginDefinition,
  type PluginLifecycleContext,
  type PluginLoadResult,
  type PluginModule,
} from "../../src/core/loader.js";
import type { PluginManifest } from "../../src/core/manifest.js";
import { isErr, isOk } from "../../src/core/types.js";

/** Build a minimal, schema-shaped manifest fixture without going through validateManifest(). */
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

type HookName = "onInstall" | "onEnable" | "onDisable" | "onUninstall";

interface TrackingOverrides {
  onInstall?: (context: PluginLifecycleContext) => void | Promise<void>;
  onEnable?: (context: PluginLifecycleContext) => void | Promise<void>;
  onDisable?: (context: PluginLifecycleContext) => void | Promise<void>;
  onUninstall?: (context: PluginLifecycleContext) => void | Promise<void>;
  provides?: Readonly<Record<string, unknown>>;
}

/**
 * A fixture plugin module: every hook call is recorded into the shared
 * `log` as `"<id>:<hookName>"`, in the exact order the loader invokes it —
 * this is what test assertions on hook-call-order are built on. An
 * `overrides[hookName]` callback, if given, runs right after the log entry
 * is recorded (so it can, e.g., call `context.capabilities.obtain()`, throw
 * to simulate a broken plugin, or capture the context for later assertions).
 */
function trackingModule(
  id: string,
  log: string[],
  overrides: TrackingOverrides = {},
): PluginModule {
  const hook =
    (name: HookName) =>
    async (context: PluginLifecycleContext): Promise<void> => {
      log.push(`${id}:${name}`);
      await overrides[name]?.(context);
    };

  const module: PluginModule = {
    onInstall: hook("onInstall"),
    onEnable: hook("onEnable"),
    onDisable: hook("onDisable"),
    onUninstall: hook("onUninstall"),
  };
  if (overrides.provides) {
    module.provides = overrides.provides;
  }
  return module;
}

/** Assert Ok and return the value, or fail the test with a readable message. */
function expectOk<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isOk(result as never)) {
    expect.fail(`expected Ok, got Err: ${JSON.stringify((result as { error?: unknown }).error)}`);
  }
  return (result as { ok: true; value: T }).value;
}

/** Assert Err and return the error, or fail the test with a readable message. */
function expectErr<E>(result: { ok: boolean; value?: unknown; error?: E }): E {
  if (!isErr(result as never)) {
    expect.fail("expected Err, got Ok");
  }
  return (result as { ok: false; error: E }).error;
}

describe("loadPlugins — hook call order matches the dependency graph", () => {
  it("calls onInstall then onEnable per plugin, dependencies before dependents (linear chain a <- b <- c)", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("c", { dependsOn: { b: "^1.0.0" } }), module: trackingModule("c", log) },
      { manifest: manifest("a"), module: trackingModule("a", log) },
      { manifest: manifest("b", { dependsOn: { a: "^1.0.0" } }), module: trackingModule("b", log) },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.order).toEqual(["a", "b", "c"]);
    expect(log).toEqual([
      "a:onInstall",
      "a:onEnable",
      "b:onInstall",
      "b:onEnable",
      "c:onInstall",
      "c:onEnable",
    ]);
    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["a", "b", "c"]);
  });

  it("interleaves install/enable per plugin through a diamond (d depends on b and c, both depend on a)", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("d", { dependsOn: { b: "^1.0.0", c: "^1.0.0" } }),
        module: trackingModule("d", log),
      },
      { manifest: manifest("b", { dependsOn: { a: "^1.0.0" } }), module: trackingModule("b", log) },
      { manifest: manifest("c", { dependsOn: { a: "^1.0.0" } }), module: trackingModule("c", log) },
      { manifest: manifest("a"), module: trackingModule("a", log) },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.order).toEqual(["a", "b", "c", "d"]);
    expect(log).toEqual([
      "a:onInstall",
      "a:onEnable",
      "b:onInstall",
      "b:onEnable",
      "c:onInstall",
      "c:onEnable",
      "d:onInstall",
      "d:onEnable",
    ]);
  });

  it("is deterministic (lexicographic tie-break) for independent plugins with no dependency relationship", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("zebra"), module: trackingModule("zebra", log) },
      { manifest: manifest("apple"), module: trackingModule("apple", log) },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.order).toEqual(["apple", "zebra"]);
    expect(log).toEqual(["apple:onInstall", "apple:onEnable", "zebra:onInstall", "zebra:onEnable"]);
  });

  it("every loaded entry carries its own manifest, a working capability facade, and a logger", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const aManifest = manifest("a");
    const definitions: PluginDefinition[] = [
      { manifest: aManifest, module: trackingModule("a", log) },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));
    const loadedA = result.loaded[0] as LoadedPlugin;

    expect(loadedA.manifest).toBe(aManifest);
    expect(typeof loadedA.context.capabilities.obtain).toBe("function");
    expect(typeof loadedA.context.logger.info).toBe("function");
  });
});

describe("loadPlugins — wires each plugin's granted capabilities via the broker", () => {
  it("a dependent's onEnable can obtain a capability its dependency provides, once declared + granted", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    let obtainedGreeting: string | undefined;

    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("provider", { provides: ["demo:greet"] }),
        module: trackingModule("provider", log, {
          provides: { "demo:greet": (name: string) => `hello, ${name}` },
        }),
      },
      {
        manifest: manifest("consumer", {
          dependsOn: { provider: "^1.0.0" },
          requires: ["demo:greet"],
        }),
        module: trackingModule("consumer", log, {
          onEnable: (context) => {
            const handle = expectOk(
              context.capabilities.obtain<(name: string) => string>("demo:greet"),
            );
            obtainedGreeting = handle("kernel");
          },
        }),
      },
    ];

    expectOk(await loadPlugins(definitions, broker));

    expect(obtainedGreeting).toBe("hello, kernel");
    expect(broker.isGranted("consumer", "demo:greet")).toBe(true);
  });

  it("a custom grantPolicy can withhold a declared capability; obtain() is then denied with reason not_granted", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    let denialReason: string | undefined;

    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("provider", { provides: ["demo:greet"] }),
        module: trackingModule("provider", log, { provides: { "demo:greet": () => "hi" } }),
      },
      {
        manifest: manifest("consumer", {
          dependsOn: { provider: "^1.0.0" },
          requires: ["demo:greet"],
        }),
        module: trackingModule("consumer", log, {
          onEnable: (context) => {
            const result = context.capabilities.obtain("demo:greet");
            if (isErr(result)) {
              denialReason = (result.error as CapabilityDeniedError).details?.["reason"] as string;
            }
          },
        }),
      },
    ];

    const result = expectOk(await loadPlugins(definitions, broker, { grantPolicy: () => false }));

    expect(denialReason).toBe("not_granted");
    expect(broker.isGranted("consumer", "demo:greet")).toBe(false);
    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["provider", "consumer"]);
  });

  it("grantAllDeclared() (the default policy) always returns true", () => {
    expect(grantAllDeclared()).toBe(true);
  });

  it("fails the whole load when a plugin declares capabilities.provides but its module supplies no implementation", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken", { provides: ["demo:greet"] }),
        module: trackingModule("broken", log),
      },
    ];

    const error = expectErr(await loadPlugins(definitions, broker));

    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error.message).toContain("broken");
    expect(error.message).toContain("demo:greet");
    expect(log).toEqual([]);
  });

  it("fails the whole load when two unrelated plugins both declare the same provided capability id, rolling back the first", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("alpha", { provides: ["shared:thing"] }),
        module: trackingModule("alpha", log, { provides: { "shared:thing": () => "alpha's" } }),
      },
      {
        manifest: manifest("beta", { provides: ["shared:thing"] }),
        module: trackingModule("beta", log, { provides: { "shared:thing": () => "beta's" } }),
      },
    ];

    const error = expectErr(await loadPlugins(definitions, broker));

    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error.details?.["existingProviderId"]).toBe("alpha");
    expect(error.details?.["attemptedProviderId"]).toBe("beta");
    // alpha fully loaded then got rolled back; beta never reached its own hooks.
    expect(log).toEqual([
      "alpha:onInstall",
      "alpha:onEnable",
      "alpha:onDisable",
      "alpha:onUninstall",
    ]);
  });
});

describe("loadPlugins — a mid-load failure rolls back already-loaded plugins in reverse order", () => {
  it("tears down (onDisable/onUninstall) and revokes capabilities for plugins that finished loading before the failure", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("svc", { provides: ["svc:thing"] }),
        module: trackingModule("svc", log, { provides: { "svc:thing": () => "ok" } }),
      },
      {
        manifest: manifest("mid", { dependsOn: { svc: "^1.0.0" }, requires: ["svc:thing"] }),
        module: trackingModule("mid", log),
      },
      {
        manifest: manifest("top", { dependsOn: { mid: "^1.0.0" } }),
        module: trackingModule("top", log, {
          onInstall: () => {
            throw new Error("boom");
          },
        }),
      },
    ];

    const error = expectErr(await loadPlugins(definitions, broker));

    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error.message).toContain("top");
    expect(error.message).toContain("boom");

    expect(log).toEqual([
      "svc:onInstall",
      "svc:onEnable",
      "mid:onInstall",
      "mid:onEnable",
      "top:onInstall",
      "mid:onDisable",
      "mid:onUninstall",
      "svc:onDisable",
      "svc:onUninstall",
    ]);

    // mid's grant of svc:thing was revoked as part of the rollback.
    expect(broker.isGranted("mid", "svc:thing")).toBe(false);
  });
});

describe("loadPlugins — propagates dependency graph errors without running any hooks", () => {
  it("returns Err(PluginLoadError) for a circular dependency and never calls a single hook", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("a", { dependsOn: { b: "^1.0.0" } }), module: trackingModule("a", log) },
      { manifest: manifest("b", { dependsOn: { a: "^1.0.0" } }), module: trackingModule("b", log) },
    ];

    const error = expectErr(await loadPlugins(definitions, broker));

    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error.message).toContain("Circular dependency");
    expect(log).toEqual([]);
  });
});

/** Load a linear chain a <- b <- c (each requiring/providing nothing) and return the broker + result + log. */
async function loadLinearChain(): Promise<{
  broker: CapabilityBroker;
  result: PluginLoadResult;
  log: string[];
}> {
  const log: string[] = [];
  const broker = createCapabilityBroker();
  const definitions: PluginDefinition[] = [
    { manifest: manifest("a"), module: trackingModule("a", log) },
    { manifest: manifest("b", { dependsOn: { a: "^1.0.0" } }), module: trackingModule("b", log) },
    { manifest: manifest("c", { dependsOn: { b: "^1.0.0" } }), module: trackingModule("c", log) },
  ];
  const result = expectOk(await loadPlugins(definitions, broker));
  return { broker, result, log };
}

describe("unloadPlugins — reverse dependency order", () => {
  it("calls onDisable then onUninstall per plugin, dependents before the dependencies they rely on", async () => {
    const { broker, result, log } = await loadLinearChain();
    const loadLogLength = log.length;

    expectOk(await unloadPlugins(result.loaded, broker));

    expect(log.slice(loadLogLength)).toEqual([
      "c:onDisable",
      "c:onUninstall",
      "b:onDisable",
      "b:onUninstall",
      "a:onDisable",
      "a:onUninstall",
    ]);
  });

  it("revokes every capability the loader granted along the way", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("svc", { provides: ["svc:thing"] }),
        module: trackingModule("svc", log, { provides: { "svc:thing": () => "ok" } }),
      },
      {
        manifest: manifest("mid", { dependsOn: { svc: "^1.0.0" }, requires: ["svc:thing"] }),
        module: trackingModule("mid", log),
      },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));
    expect(broker.isGranted("mid", "svc:thing")).toBe(true);

    expectOk(await unloadPlugins(result.loaded, broker));

    expect(broker.isGranted("mid", "svc:thing")).toBe(false);
  });

  it("keeps tearing down remaining plugins even if one plugin's onDisable throws, aggregating the failure", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("a"), module: trackingModule("a", log) },
      {
        manifest: manifest("b", { dependsOn: { a: "^1.0.0" } }),
        module: trackingModule("b", log, {
          onDisable: () => {
            throw new Error("teardown boom");
          },
        }),
      },
      { manifest: manifest("c", { dependsOn: { b: "^1.0.0" } }), module: trackingModule("c", log) },
    ];
    const result = expectOk(await loadPlugins(definitions, broker));
    const loadLogLength = log.length;

    const error = expectErr(await unloadPlugins(result.loaded, broker));

    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error.message).toContain("b");
    expect(error.message).toContain("teardown boom");

    // c unwinds fully; b's onDisable is attempted (and throws, skipping its onUninstall);
    // a still gets torn down despite b's failure in the middle.
    expect(log.slice(loadLogLength)).toEqual([
      "c:onDisable",
      "c:onUninstall",
      "b:onDisable",
      "a:onDisable",
      "a:onUninstall",
    ]);
  });
});
