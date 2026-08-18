/**
 * Unit tests for runtime-control.ts's `disablePlugin()`/`enablePlugin()` —
 * feature #16, "Runtime plugin enable/disable without a full process
 * restart". Builds a real `PluginLoadResult` via loader.ts's `loadPlugins()`
 * against in-memory fixture modules (mirroring loader.test.ts's own
 * `manifest()`/`trackingModule()` helpers) rather than going through a full
 * filesystem-backed `bootstrapKernel()` — this suite's job is
 * runtime-control.ts's own contract in isolation, not the kernel wiring
 * (that's `src/server/index.ts`'s thin `kernel.disablePlugin()` /
 * `kernel.enablePlugin()` pass-through, exercised for real in
 * tests/server/index.test.ts / tests/core/kernel.integration.test.ts).
 */
import { describe, expect, it } from "vitest";
import { createCapabilityBroker } from "../../src/core/broker.js";
import { PluginLoadError } from "../../src/core/errors.js";
import {
  loadPlugins,
  type PluginDefinition,
  type PluginLifecycleContext,
  type PluginLoadResult,
  type PluginModule,
} from "../../src/core/loader.js";
import type { PluginManifest } from "../../src/core/manifest.js";
import { createPluginStatusTracker, type PluginStatusTracker } from "../../src/core/plugin-status.js";
import { disablePlugin, enablePlugin } from "../../src/core/runtime-control.js";
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

/** A fixture plugin module: every hook call is recorded into the shared `log` as `"<id>:<hookName>"`. */
function trackingModule(id: string, log: string[], overrides: TrackingOverrides = {}): PluginModule {
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

/** Load `definitions` for real via loader.ts, against a fresh broker, and return the result (never Err for these fixtures). */
async function loadFixture(definitions: PluginDefinition[]): Promise<PluginLoadResult> {
  const broker = createCapabilityBroker();
  const result = await loadPlugins(definitions, broker);
  if (isErr(result)) {
    throw new Error(`fixture setup failed: ${result.error.message}`);
  }
  return result.value;
}

function expectOk<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isOk(result as never)) {
    expect.fail(`expected Ok, got Err: ${JSON.stringify((result as { error?: unknown }).error)}`);
  }
  return (result as { ok: true; value: T }).value;
}

function expectErr<E>(result: { ok: boolean; value?: unknown; error?: E }): E {
  if (!isErr(result as never)) {
    expect.fail("expected Err, got Ok");
  }
  return (result as { ok: false; error: E }).error;
}

describe("disablePlugin / enablePlugin", () => {
  it("disables then re-enables a leaf plugin (no dependents) successfully, running onDisable/onEnable and updating status", async () => {
    const log: string[] = [];
    const definitions: PluginDefinition[] = [
      { manifest: manifest("leaf"), module: trackingModule("leaf", log) },
    ];
    const plugins = await loadFixture(definitions);
    const statusTracker: PluginStatusTracker = createPluginStatusTracker();

    expect(statusTracker.isDisabled("leaf")).toBe(false);
    log.length = 0; // clear onInstall/onEnable calls from the initial load

    const disableResult = await disablePlugin(plugins, statusTracker, "leaf");
    expectOk(disableResult);
    expect(statusTracker.isDisabled("leaf")).toBe(true);
    expect(log).toEqual(["leaf:onDisable"]);

    const enableResult = await enablePlugin(plugins, statusTracker, "leaf");
    expectOk(enableResult);
    expect(statusTracker.isDisabled("leaf")).toBe(false);
    expect(log).toEqual(["leaf:onDisable", "leaf:onEnable"]);
  });

  it("rejects disabling a plugin that another loaded plugin depends on, naming every dependent", async () => {
    const log: string[] = [];
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("logging", { provides: ["log:write"] }),
        module: trackingModule("logging", log, {
          provides: { "log:write": () => undefined },
        }),
      },
      {
        manifest: manifest("database", {
          dependsOn: { logging: "^1.0.0" },
          requires: ["log:write"],
        }),
        module: trackingModule("database", log),
      },
      {
        manifest: manifest("metrics", {
          dependsOn: { logging: "^1.0.0" },
          requires: ["log:write"],
        }),
        module: trackingModule("metrics", log),
      },
    ];
    const plugins = await loadFixture(definitions);
    const statusTracker = createPluginStatusTracker();
    log.length = 0;

    const result = await disablePlugin(plugins, statusTracker, "logging");
    const error = expectErr(result);

    expect(error).toBeInstanceOf(PluginLoadError);
    expect(error.message).toContain("logging");
    expect(error.message).toContain("database");
    expect(error.message).toContain("metrics");
    expect(error.details?.["dependents"]).toEqual(["database", "metrics"]);

    // Nothing happened: onDisable was never called and status is unchanged.
    expect(log).toEqual([]);
    expect(statusTracker.isDisabled("logging")).toBe(false);
  });

  it("allows disabling a plugin once its dependent has itself been disabled first", async () => {
    const log: string[] = [];
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("logging", { provides: ["log:write"] }),
        module: trackingModule("logging", log, { provides: { "log:write": () => undefined } }),
      },
      {
        manifest: manifest("database", { dependsOn: { logging: "^1.0.0" }, requires: ["log:write"] }),
        module: trackingModule("database", log),
      },
    ];
    const plugins = await loadFixture(definitions);
    const statusTracker = createPluginStatusTracker();

    expect(isErr(await disablePlugin(plugins, statusTracker, "logging"))).toBe(true);

    expectOk(await disablePlugin(plugins, statusTracker, "database"));
    expectOk(await disablePlugin(plugins, statusTracker, "logging"));
    expect(statusTracker.isDisabled("database")).toBe(true);
    expect(statusTracker.isDisabled("logging")).toBe(true);
  });

  it("is idempotent: disabling an already-disabled plugin succeeds without calling onDisable again", async () => {
    const log: string[] = [];
    const definitions: PluginDefinition[] = [
      { manifest: manifest("leaf"), module: trackingModule("leaf", log) },
    ];
    const plugins = await loadFixture(definitions);
    const statusTracker = createPluginStatusTracker();

    expectOk(await disablePlugin(plugins, statusTracker, "leaf"));
    log.length = 0;
    expectOk(await disablePlugin(plugins, statusTracker, "leaf"));

    expect(log).toEqual([]);
    expect(statusTracker.isDisabled("leaf")).toBe(true);
  });

  it("is idempotent: enabling a plugin that is not disabled succeeds without calling onEnable again", async () => {
    const log: string[] = [];
    const definitions: PluginDefinition[] = [
      { manifest: manifest("leaf"), module: trackingModule("leaf", log) },
    ];
    const plugins = await loadFixture(definitions);
    const statusTracker = createPluginStatusTracker();
    log.length = 0;

    expectOk(await enablePlugin(plugins, statusTracker, "leaf"));

    expect(log).toEqual([]);
    expect(statusTracker.isDisabled("leaf")).toBe(false);
  });

  it("rejects disabling/enabling a plugin id that never loaded", async () => {
    const plugins = await loadFixture([]);
    const statusTracker = createPluginStatusTracker();

    const disableError = expectErr(await disablePlugin(plugins, statusTracker, "ghost"));
    expect(disableError).toBeInstanceOf(PluginLoadError);
    expect(disableError.message).toContain("ghost");

    const enableError = expectErr(await enablePlugin(plugins, statusTracker, "ghost"));
    expect(enableError).toBeInstanceOf(PluginLoadError);
    expect(enableError.message).toContain("ghost");
  });

  it("leaves status unchanged and surfaces the failure when onDisable throws", async () => {
    const log: string[] = [];
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("flaky"),
        module: trackingModule("flaky", log, {
          onDisable: () => {
            throw new Error("cannot pause right now");
          },
        }),
      },
    ];
    const plugins = await loadFixture(definitions);
    const statusTracker = createPluginStatusTracker();

    const result = await disablePlugin(plugins, statusTracker, "flaky");
    const error = expectErr(result);
    expect(error.message).toContain("cannot pause right now");
    expect(statusTracker.isDisabled("flaky")).toBe(false);
  });

  it("leaves status unchanged and surfaces the failure when onEnable throws", async () => {
    const log: string[] = [];
    // onEnable only throws on its *second* call (the runtime re-enable) —
    // its first call happens during the initial loadPlugins() pass itself,
    // which must succeed so "flaky" actually ends up in plugins.loaded.
    let enableCalls = 0;
    const definitions: PluginDefinition[] = [
      {
        manifest: manifest("flaky"),
        module: trackingModule("flaky", log, {
          onEnable: () => {
            enableCalls += 1;
            if (enableCalls > 1) {
              throw new Error("cannot resume right now");
            }
          },
        }),
      },
    ];
    const plugins = await loadFixture(definitions);
    const statusTracker = createPluginStatusTracker();
    expectOk(await disablePlugin(plugins, statusTracker, "flaky"));

    const result = await enablePlugin(plugins, statusTracker, "flaky");
    const error = expectErr(result);
    expect(error.message).toContain("cannot resume right now");
    expect(statusTracker.isDisabled("flaky")).toBe(true);
  });
});
