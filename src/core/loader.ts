/**
 * Plugin loader — instantiates plugins in dependency order and drives their
 * lifecycle hooks (spec.md's Plugin Registry & Loader: "...instantiates in
 * dependency order, calls lifecycle hooks (onInstall, onEnable, onDisable,
 * onUninstall)").
 *
 * {@link loadPlugins} takes plugin definitions (an already-validated
 * manifest paired with an in-memory module — see manifest.ts's
 * `validateManifest()` and registry.ts's `scanPluginDirectories()` for how a
 * caller gets there; this module does not itself read `plugin.json` from
 * disk or dynamically `import()` a plugin's `entry_point`), resolves their
 * load order via graph.ts's `resolveLoadOrder()`, and then, for each plugin
 * id in that order:
 *
 *   1. Declares the plugin's `capabilities.requires` with the broker
 *      (broker.ts's `declareRequirements`).
 *   2. Registers the plugin's `capabilities.provides` implementations with
 *      the broker (`registerProvider`), so a dependency's capability is
 *      obtainable the moment a dependent plugin's own hooks run — dependency
 *      order guarantees this registration always happens before any
 *      dependent reaches its own turn in the loop.
 *   3. Wires the plugin's *granted* capabilities: decides — via
 *      `options.grantPolicy` (default: {@link grantAllDeclared}, "grant
 *      everything the plugin declared") — which of its declared capabilities
 *      to `broker.grant()`, then hands the plugin `broker.forPlugin(id)`
 *      (the narrow, identity-bound facade — see broker.ts) as
 *      `context.capabilities`, so its hooks can immediately `obtain()`
 *      anything just granted. `grantPolicy` is broker.ts's documented
 *      "operator/admin surface" made pluggable: a real kernel bootstrap can
 *      supply a policy backed by RBAC/config instead of the permissive
 *      default this module ships.
 *   4. Calls `onInstall(context)` then `onEnable(context)`, awaited in
 *      sequence, before moving on to the next plugin in the order.
 *
 * {@link unloadPlugins} reverses the process for a set of already-loaded
 * plugins: `onDisable` then `onUninstall`, in *reverse* dependency order
 * (dependents torn down before the dependencies they rely on), revoking
 * every capability the loader granted along the way.
 *
 * ## Failure handling — error isolation (spec.md: "a broken plugin must not
 * crash the kernel or unrelated plugins")
 *
 * `loadPlugins()` never lets one plugin's failure abort the whole pass.
 * Every step for a plugin — broker wiring (declaring requirements,
 * registering providers, grants) and its `onInstall`/`onEnable` hooks — runs
 * inside a try/catch scoped to that plugin alone. If it throws, the error is
 * logged and the plugin is recorded in the result's `failed` list instead of
 * `loaded`; the loop then moves on to the next plugin in dependency order
 * exactly as if nothing happened. Plugins with no `depends_on` relationship
 * to the failed one — and any dependency that already finished loading
 * *before* it, since dependency order guarantees those are unaffected by a
 * dependent's later failure — are never rolled back and load normally.
 *
 * A plugin whose `depends_on` names an id that already failed (directly or
 * transitively) is never attempted at all: it is recorded in `failed` with
 * `skipped: true` and a message naming the failed dependency, without
 * running any of its own broker wiring or hooks. This cascades naturally
 * through a dependency chain, since `order` always places a dependency
 * before its dependents.
 *
 * `loadPlugins()` only returns `Err(PluginLoadError)` when no load order
 * could be computed at all — a structural problem with the dependency graph
 * itself (circular dependency, missing dependency, an unsatisfied semver
 * range, or a duplicate plugin id), surfaced by `resolveLoadOrder()` before
 * any plugin is attempted. That is a kernel/config-level problem, not a
 * single plugin's runtime failure, so there is nothing to isolate.
 *
 * Within `unloadPlugins()`, a single plugin's teardown failing does NOT stop
 * the rest — every plugin still gets its `onDisable`/`onUninstall`
 * attempted, and any failures are aggregated into one `Err(PluginLoadError)`
 * afterward.
 */
import type { CapabilityBroker, PluginCapabilityAccess } from "./broker.js";
import { PluginLoadError } from "./errors.js";
import { resolveLoadOrder } from "./graph.js";
import { createLogger, withContext, type Logger } from "./logger.js";
import type { PluginManifest } from "./manifest.js";
import { err, isErr, ok, type Result } from "./types.js";

/** Context object passed to every lifecycle hook a plugin module exports. */
export interface PluginLifecycleContext {
  /** This plugin's own validated manifest. */
  readonly manifest: PluginManifest;
  /** The narrow, identity-bound capability facade — see broker.ts's `forPlugin()`. */
  readonly capabilities: PluginCapabilityAccess;
  /** A logger pre-scoped with `{ plugin: manifest.id }` context. */
  readonly logger: Logger;
}

/** A single lifecycle hook. May be synchronous or return a Promise; the loader always awaits it. */
export type PluginLifecycleHook = (context: PluginLifecycleContext) => void | Promise<void>;

/**
 * A plugin's runtime module — what its `entry_point` is expected to export.
 * Every hook is optional: a plugin with nothing to do on a given transition
 * simply omits it. `provides` supplies the actual implementation for each
 * capability id listed in the plugin's manifest under `capabilities.provides`
 * (keyed by capability id) — the loader registers these with the broker
 * before calling any of this module's hooks.
 */
export interface PluginModule {
  onInstall?: PluginLifecycleHook;
  onEnable?: PluginLifecycleHook;
  onDisable?: PluginLifecycleHook;
  onUninstall?: PluginLifecycleHook;
  provides?: Readonly<Record<string, unknown>>;
}

/** A plugin ready to be loaded: its validated manifest paired with its instantiated module. */
export interface PluginDefinition {
  readonly manifest: PluginManifest;
  readonly module: PluginModule;
}

/**
 * Decides whether the loader should `broker.grant()` `capabilityId` to
 * `pluginId` during this load pass. Only ever consulted for ids the plugin
 * already declared under `capabilities.requires` — a `GrantPolicy` cannot
 * grant anything outside that declared ceiling (broker.ts's `grant()`
 * enforces this independently regardless).
 */
export type GrantPolicy = (
  pluginId: string,
  capabilityId: string,
  manifest: PluginManifest,
) => boolean;

/** Default {@link GrantPolicy}: grant every capability a plugin declared under `capabilities.requires`. */
export function grantAllDeclared(): boolean {
  return true;
}

export interface LoadPluginsOptions {
  /** Defaults to `createLogger({ context: { module: "plugin-loader" } })`. */
  logger?: Logger;
  /** Defaults to {@link grantAllDeclared}. */
  grantPolicy?: GrantPolicy;
}

/** One plugin that completed `onInstall` + `onEnable`, and everything needed to unload it later. */
export interface LoadedPlugin {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly module: PluginModule;
  readonly context: PluginLifecycleContext;
}

/**
 * One plugin that did NOT complete loading — either its own broker wiring
 * or a lifecycle hook threw ({@link skipped} `false`), or it was never even
 * attempted because one of its dependencies already failed
 * ({@link skipped} `true`). Either way, this plugin is isolated: its failure
 * does not affect `loaded` plugins or dependency-unrelated plugins recorded
 * elsewhere in the same {@link PluginLoadResult}.
 */
export interface FailedPlugin {
  readonly id: string;
  readonly manifest: PluginManifest;
  /** The normalized failure. For a cascaded skip, names the failed dependency (see `error.details.dependencyId`). */
  readonly error: PluginLoadError;
  /** `true` if this plugin's own wiring/hooks never ran because a dependency of it failed first. */
  readonly skipped: boolean;
}

/** Result of a {@link loadPlugins} call. Always `Ok` unless the dependency graph itself is unresolvable — see the module docs. */
export interface PluginLoadResult {
  /** The dependency order used (dependencies before dependents) — graph.ts's `resolveLoadOrder()` output. */
  readonly order: readonly string[];
  /** One entry per plugin that completed `onInstall` + `onEnable`, in load order. Pass to {@link unloadPlugins} for teardown. */
  readonly loaded: readonly LoadedPlugin[];
  /** One entry per plugin that failed or was skipped due to a failed dependency, in load order. Never affects `loaded`. */
  readonly failed: readonly FailedPlugin[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalize whatever a load step threw into a `PluginLoadError`, preserving one if it already is one. */
function toPluginLoadError(pluginId: string, cause: unknown): PluginLoadError {
  if (cause instanceof PluginLoadError) {
    return cause;
  }
  return new PluginLoadError(`Plugin "${pluginId}" failed during load: ${describeError(cause)}`, {
    details: { pluginId },
    cause,
  });
}

/** Run `onDisable` then `onUninstall` for one loaded plugin, and revoke every capability it was granted. */
async function teardownOne(plugin: LoadedPlugin, broker: CapabilityBroker): Promise<void> {
  await plugin.module.onDisable?.(plugin.context);
  await plugin.module.onUninstall?.(plugin.context);
  for (const capabilityId of plugin.manifest.capabilities.requires) {
    broker.revoke(plugin.id, capabilityId);
  }
}

/**
 * Instantiate `definitions` in dependency order and run each plugin's
 * `onInstall` then `onEnable`, wiring its declared-and-granted capabilities
 * through `broker` first. See the module docs for the full per-plugin
 * sequence and failure-isolation behavior.
 */
export async function loadPlugins(
  definitions: readonly PluginDefinition[],
  broker: CapabilityBroker,
  options: LoadPluginsOptions = {},
): Promise<Result<PluginLoadResult, PluginLoadError>> {
  const logger = options.logger ?? createLogger({ context: { module: "plugin-loader" } });
  const grantPolicy = options.grantPolicy ?? grantAllDeclared;

  const byId = new Map<string, PluginDefinition>();
  for (const definition of definitions) {
    byId.set(definition.manifest.id, definition);
  }

  const orderResult = resolveLoadOrder(definitions.map((definition) => definition.manifest));
  if (isErr(orderResult)) {
    return orderResult;
  }
  const order = orderResult.value;

  const loaded: LoadedPlugin[] = [];
  const failed: FailedPlugin[] = [];
  // Ids that failed (directly or by cascade) — checked against each later
  // plugin's own depends_on to decide whether to skip it too. `order`
  // guarantees every dependency is visited before its dependents, so a
  // single forward pass is enough for the cascade to reach every descendant.
  const failedIds = new Set<string>();

  for (const id of order) {
    const definition = byId.get(id);
    if (!definition) {
      // Unreachable: resolveLoadOrder() only ever returns ids drawn from the
      // manifests we just derived 1:1 from `definitions`.
      continue;
    }
    const { manifest, module } = definition;

    const failedDependencyId = Object.keys(manifest.depends_on).find((dependencyId) =>
      failedIds.has(dependencyId),
    );
    if (failedDependencyId !== undefined) {
      const skipError = new PluginLoadError(
        `Plugin "${id}" was not loaded because its dependency "${failedDependencyId}" failed to load.`,
        { details: { pluginId: id, dependencyId: failedDependencyId } },
      );
      logger.error(
        { plugin: id, dependency: failedDependencyId },
        `Plugin "${id}" skipped: its dependency "${failedDependencyId}" failed to load.`,
      );
      failed.push({ id, manifest, error: skipError, skipped: true });
      failedIds.add(id);
      continue;
    }

    // Tracks capabilities this plugin's own load attempt has already
    // mutated shared broker state for, so a failure partway through this
    // plugin's own sequence can be rolled back without touching any other
    // plugin's state. Without this, a plugin that fails after successfully
    // registering a provider or obtaining a grant would leave that
    // registration/grant permanently live even though the plugin itself is
    // recorded as failed — see feature #10's isolation contract and the
    // kernel security review that found this gap.
    const registeredThisAttempt: string[] = [];
    const grantedThisAttempt: string[] = [];

    try {
      broker.declareRequirements(id, manifest.capabilities.requires);

      for (const capabilityId of manifest.capabilities.provides) {
        const implementation = module.provides?.[capabilityId];
        if (implementation === undefined) {
          throw new PluginLoadError(
            `Plugin "${id}" declares capabilities.provides "${capabilityId}" but its module does ` +
              `not export an implementation for it.`,
            { details: { pluginId: id, capabilityId } },
          );
        }
        const registerResult = broker.registerProvider(id, capabilityId, implementation);
        if (isErr(registerResult)) {
          throw registerResult.error;
        }
        registeredThisAttempt.push(capabilityId);
      }

      for (const capabilityId of manifest.capabilities.requires) {
        if (grantPolicy(id, capabilityId, manifest)) {
          const grantResult = broker.grant(id, capabilityId);
          if (isErr(grantResult)) {
            throw grantResult.error;
          }
          grantedThisAttempt.push(capabilityId);
        }
      }

      const context: PluginLifecycleContext = {
        manifest,
        capabilities: broker.forPlugin(id),
        logger: withContext(logger, { plugin: id }),
      };

      await module.onInstall?.(context);
      await module.onEnable?.(context);

      loaded.push({ id, manifest, module, context });
    } catch (cause) {
      for (const capabilityId of registeredThisAttempt) {
        broker.unregisterProvider(id, capabilityId);
      }
      for (const capabilityId of grantedThisAttempt) {
        broker.revoke(id, capabilityId);
      }
      logger.error(
        { plugin: id, err: cause },
        `Plugin "${id}" failed to load; isolated from unrelated plugins — load continues.`,
      );
      failed.push({ id, manifest, error: toPluginLoadError(id, cause), skipped: false });
      failedIds.add(id);
    }
  }

  return ok({ order, loaded, failed });
}

export interface UnloadPluginsOptions {
  /** Defaults to `createLogger({ context: { module: "plugin-loader" } })`. */
  logger?: Logger;
}

/**
 * Tear down `loaded` plugins in reverse dependency order: `onDisable` then
 * `onUninstall` per plugin (dependents before the dependencies they rely
 * on), revoking every capability {@link loadPlugins} granted along the way.
 * Every plugin's teardown is attempted even if an earlier one fails —
 * failures are collected and, if any occurred, returned together as one
 * `Err(PluginLoadError)` once every plugin has been given the chance to
 * unload.
 */
export async function unloadPlugins(
  loaded: readonly LoadedPlugin[],
  broker: CapabilityBroker,
  options: UnloadPluginsOptions = {},
): Promise<Result<void, PluginLoadError>> {
  const logger = options.logger ?? createLogger({ context: { module: "plugin-loader" } });
  const issues: { pluginId: string; message: string }[] = [];

  for (const plugin of [...loaded].reverse()) {
    try {
      await teardownOne(plugin, broker);
    } catch (cause) {
      const message = describeError(cause);
      logger.error({ plugin: plugin.id, err: cause }, `Plugin "${plugin.id}" failed to unload.`);
      issues.push({ pluginId: plugin.id, message });
    }
  }

  if (issues.length > 0) {
    const summary = issues.map((issue) => `${issue.pluginId}: ${issue.message}`).join("; ");
    return err(
      new PluginLoadError(`Failed to fully unload plugin(s): ${summary}`, {
        details: { issues },
      }),
    );
  }

  return ok(undefined);
}
