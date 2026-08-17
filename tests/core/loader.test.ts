import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createCapabilityBroker, type CapabilityBroker } from "../../src/core/broker.js";
import { CapabilityDeniedError, PluginLoadError } from "../../src/core/errors.js";
import {
  grantAllDeclared,
  loadPlugins,
  unloadPlugins,
  type FailedPlugin,
  type LoadedPlugin,
  type PluginDefinition,
  type PluginLifecycleContext,
  type PluginLoadResult,
  type PluginModule,
} from "../../src/core/loader.js";
import { createLogger } from "../../src/core/logger.js";
import type { PluginManifest } from "../../src/core/manifest.js";
import { isErr, isOk } from "../../src/core/types.js";

/** In-memory sink for a pino logger's raw ndjson output, mirroring registry.test.ts's helper. */
function createCapturingLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ stream, level: "trace" });
  return {
    logger,
    lines: (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

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

  it("marks a plugin failed (not the whole load) when it declares capabilities.provides but its module supplies no implementation", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken", { provides: ["demo:greet"] }),
        module: trackingModule("broken", log),
      },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.loaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0] as FailedPlugin;
    expect(failure.id).toBe("broken");
    expect(failure.skipped).toBe(false);
    expect(failure.error).toBeInstanceOf(PluginLoadError);
    expect(failure.error.message).toContain("broken");
    expect(failure.error.message).toContain("demo:greet");
    expect(log).toEqual([]);
  });

  it("marks only the second plugin failed when two unrelated plugins both declare the same provided capability id; the first stays loaded (no rollback)", async () => {
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

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["alpha"]);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0] as FailedPlugin;
    expect(failure.id).toBe("beta");
    expect(failure.skipped).toBe(false);
    expect(failure.error.details?.["existingProviderId"]).toBe("alpha");
    expect(failure.error.details?.["attemptedProviderId"]).toBe("beta");
    // alpha's own hooks completed and were never torn down; beta never reached its own hooks.
    expect(log).toEqual(["alpha:onInstall", "alpha:onEnable"]);
  });
});

describe("loadPlugins — a failing plugin's already-loaded dependencies are not rolled back", () => {
  it("keeps a dependency chain loaded when a plugin above it fails; only the failing plugin is marked failed", async () => {
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

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["svc", "mid"]);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0] as FailedPlugin;
    expect(failure.id).toBe("top");
    expect(failure.skipped).toBe(false);
    expect(failure.error).toBeInstanceOf(PluginLoadError);
    expect(failure.error.message).toContain("top");
    expect(failure.error.message).toContain("boom");

    // No teardown of svc/mid: they finished loading, and top's failure doesn't cascade
    // upward to the dependencies it relies on — only downward to its own dependents (it has none).
    expect(log).toEqual([
      "svc:onInstall",
      "svc:onEnable",
      "mid:onInstall",
      "mid:onEnable",
      "top:onInstall",
    ]);

    // mid's grant of svc:thing is untouched — mid was never rolled back.
    expect(broker.isGranted("mid", "svc:thing")).toBe(true);
  });
});

describe("loadPlugins — security review regressions: a failing plugin's own partial state is rolled back", () => {
  it("revokes a capability grant obtained earlier in the same failed load attempt", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("provider", { provides: ["svc:x"] }),
        module: trackingModule("provider", log, { provides: { "svc:x": () => "ok" } }),
      },
      {
        manifest: manifest("leaky2", { dependsOn: { provider: "^1.0.0" }, requires: ["svc:x"] }),
        module: trackingModule("leaky2", log, {
          onInstall: () => {
            throw new Error("leaky2 boom");
          },
        }),
      },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["provider"]);
    expect(result.failed.map((plugin) => plugin.id)).toEqual(["leaky2"]);

    // Before the fix: leaky2's grant of svc:x (obtained before its onInstall
    // threw) stayed live forever, even though leaky2 itself is reported as
    // failed and absent from `loaded`.
    expect(broker.isGranted("leaky2", "svc:x")).toBe(false);
  });

  it("unregisters a provider registration made earlier in the same failed load attempt, freeing the capability id for another plugin", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        // Declares two provides, but only implements the first — the second
        // iteration throws mid-loop, after cap:a was already registered.
        manifest: manifest("leaky", { provides: ["cap:a", "cap:b"] }),
        module: trackingModule("leaky", log, { provides: { "cap:a": () => "impl-a" } }),
      },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));
    expect(result.loaded).toHaveLength(0);
    expect(result.failed.map((plugin) => plugin.id)).toEqual(["leaky"]);

    // Before the fix: "cap:a" stayed permanently registered to "leaky" (a
    // plugin the loader itself reports as failed), so no other plugin —
    // including a corrected retry under a different id — could ever
    // register it again for the lifetime of the broker.
    const registerResult = broker.registerProvider("someone-else", "cap:a", () => "impl-other");
    expect(isErr(registerResult)).toBe(false);
  });
});

describe("loadPlugins — error isolation (feature #10): a failing plugin cannot crash the kernel or unrelated plugins", () => {
  it("a plugin that throws in onEnable results in only that plugin (and its dependents) being marked failed", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      { manifest: manifest("base"), module: trackingModule("base", log) },
      {
        manifest: manifest("flaky", { dependsOn: { base: "^1.0.0" } }),
        module: trackingModule("flaky", log, {
          onEnable: () => {
            throw new Error("flaky boom");
          },
        }),
      },
      {
        manifest: manifest("dependent", { dependsOn: { flaky: "^1.0.0" } }),
        module: trackingModule("dependent", log),
      },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["base"]);
    expect(result.failed.map((failure) => failure.id).sort()).toEqual(["dependent", "flaky"]);

    const flakyFailure = result.failed.find((failure) => failure.id === "flaky") as FailedPlugin;
    expect(flakyFailure.skipped).toBe(false);
    expect(flakyFailure.error).toBeInstanceOf(PluginLoadError);
    expect(flakyFailure.error.message).toContain("flaky boom");

    const dependentFailure = result.failed.find(
      (failure) => failure.id === "dependent",
    ) as FailedPlugin;
    expect(dependentFailure.skipped).toBe(true);
    expect(dependentFailure.error.message).toContain("flaky");

    // dependent's own hooks never ran at all — it was skipped, not attempted, because
    // its dependency (flaky) already failed.
    expect(log).toEqual(["base:onInstall", "base:onEnable", "flaky:onInstall", "flaky:onEnable"]);
  });

  it("an independent plugin with no depends_on relationship to a failing plugin still loads successfully", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken"),
        module: trackingModule("broken", log, {
          onInstall: () => {
            throw new Error("broken boom");
          },
        }),
      },
      { manifest: manifest("solo"), module: trackingModule("solo", log) },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["solo"]);
    expect(log).toEqual(["broken:onInstall", "solo:onInstall", "solo:onEnable"]);
    expect(result.failed.map((failure) => failure.id)).toEqual(["broken"]);
    expect(result.failed[0]?.skipped).toBe(false);
  });

  it("logs the failure (plugin id + cause) for the plugin that threw, via the provided logger", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const { logger, lines } = createCapturingLogger();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("broken"),
        module: trackingModule("broken", log, {
          onEnable: () => {
            throw new Error("kaboom");
          },
        }),
      },
    ];

    await loadPlugins(definitions, broker, { logger });

    const errorLines = lines().filter((line) => line["level"] === 50);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]?.["plugin"]).toBe("broken");
  });

  it("multiple unrelated plugins can each fail independently in a single load pass", async () => {
    const log: string[] = [];
    const broker = createCapabilityBroker();
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("first"),
        module: trackingModule("first", log, {
          onInstall: () => {
            throw new Error("first boom");
          },
        }),
      },
      {
        manifest: manifest("second"),
        module: trackingModule("second", log, {
          onEnable: () => {
            throw new Error("second boom");
          },
        }),
      },
      { manifest: manifest("third"), module: trackingModule("third", log) },
    ];

    const result = expectOk(await loadPlugins(definitions, broker));

    expect(result.loaded.map((plugin) => plugin.id)).toEqual(["third"]);
    expect(result.failed.map((failure) => failure.id).sort()).toEqual(["first", "second"]);
    expect(result.failed.every((failure) => !failure.skipped)).toBe(true);
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
