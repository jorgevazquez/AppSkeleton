/**
 * Runtime plugin enable/disable — feature #16, "Runtime plugin enable/disable
 * without a full process restart" (spec.md's lifecycle hooks: onInstall,
 * onEnable, onDisable, onUninstall).
 *
 * {@link disablePlugin}/{@link enablePlugin} are pure functions over the
 * kernel's already-built state — loader.ts's `PluginLoadResult.loaded` and
 * plugin-status.ts's `PluginStatusTracker` — mirroring introspect.ts's own
 * approach of taking that state explicitly rather than reading hidden module
 * state, so both are directly testable without a full `bootstrapKernel()`
 * call. `server/index.ts` wires these up as `kernel.disablePlugin()` /
 * `kernel.enablePlugin()`, closing over that kernel instance's own
 * `plugins`/`pluginStatus`.
 *
 * ## Deliberately narrow scope
 *
 * Per plugin-status.ts's own docs for this feature, an administrative
 * disable/enable toggles a plugin between "running" and "paused":
 *
 *   - {@link disablePlugin} runs only `onDisable` (never `onUninstall`) then
 *     marks the plugin disabled via `statusTracker.disable()`.
 *   - {@link enablePlugin} runs only `onEnable` (never `onInstall`) then
 *     clears that marker via `statusTracker.enable()`.
 *
 * The plugin stays fully installed the whole time — still present in
 * `plugins.loaded`, still holding whatever the original `loadPlugins()` pass
 * granted/registered for it with the broker. Unlike `unloadPlugins()`
 * (loader.ts), neither function here revokes broker grants or unregisters
 * providers; `introspect.ts`'s `status: "disabled"` is the operator-facing
 * signal that a plugin is administratively paused, layered independently on
 * top of the broker state loader.ts already manages.
 *
 * ## The dependents check
 *
 * `disablePlugin()` refuses to run at all — before ever touching the
 * plugin's `onDisable` hook or status — if any *other* currently-loaded,
 * currently-*enabled* plugin declares this one under its own `depends_on`.
 * Disabling it anyway would leave that still-running dependent silently
 * depending on something no longer running, with nothing forcing the
 * dependent itself to notice. The error names every such dependent so an
 * operator knows exactly what has to be disabled first.
 *
 * A dependent that is itself already disabled does NOT block the disable:
 * two paused plugins depending on each other is a perfectly consistent
 * state (neither is doing any live work right now), so disabling
 * `database`, then `logging` (which `database` depends on), is allowed —
 * disabling them in the other order is rejected only until `database` is
 * paused first.
 */
import { PluginLoadError } from "./errors.js";
import type { LoadedPlugin, PluginLoadResult } from "./loader.js";
import type { PluginStatusTracker } from "./plugin-status.js";
import { err, ok, type Result } from "./types.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findLoaded(plugins: PluginLoadResult, pluginId: string): LoadedPlugin | undefined {
  return plugins.loaded.find((plugin) => plugin.id === pluginId);
}

function notLoadedError(pluginId: string): PluginLoadError {
  return new PluginLoadError(
    `Cannot change status of plugin "${pluginId}": it is not currently loaded (never discovered, ` +
      `failed to load, or was skipped).`,
    { details: { pluginId } },
  );
}

/**
 * Every currently-loaded, currently-*enabled* plugin whose manifest declares
 * `pluginId` under its own `depends_on` — i.e. every still-running plugin
 * that would be left depending on something no longer running if `pluginId`
 * were disabled right now. A dependent that is itself already disabled is
 * excluded (see module docs). Sorted lexicographically for a deterministic,
 * readable error message.
 */
function liveDependentsOf(
  plugins: PluginLoadResult,
  statusTracker: PluginStatusTracker,
  pluginId: string,
): string[] {
  return plugins.loaded
    .filter(
      (plugin) =>
        plugin.id !== pluginId &&
        pluginId in plugin.manifest.depends_on &&
        !statusTracker.isDisabled(plugin.id),
    )
    .map((plugin) => plugin.id)
    .sort((a, b) => a.localeCompare(b));
}

function dependentsRejection(pluginId: string, dependents: readonly string[]): PluginLoadError {
  const names = dependents.map((id) => `"${id}"`).join(", ");
  const plural = dependents.length === 1 ? "plugin" : "plugins";
  return new PluginLoadError(
    `Cannot disable plugin "${pluginId}": it is still depended on by ${names}. ` +
      `Disable ${plural} ${names} first, or update ${
        dependents.length === 1 ? "its" : "their"
      } manifest to no longer depend on "${pluginId}".`,
    { details: { pluginId, dependents } },
  );
}

function hookFailure(
  pluginId: string,
  hookName: "onDisable" | "onEnable",
  cause: unknown,
): PluginLoadError {
  return new PluginLoadError(
    `Plugin "${pluginId}" threw from its ${hookName} hook: ${describeError(cause)}`,
    { details: { pluginId, hook: hookName }, cause },
  );
}

/**
 * Disable `pluginId` at runtime — no full process restart. Runs its
 * `onDisable` hook (if any), then marks it disabled in `statusTracker` so
 * `introspectKernel()` reports `status: "disabled"` for it from here on.
 *
 * Idempotent: disabling an already-disabled plugin succeeds immediately as a
 * no-op, without calling `onDisable` a second time.
 *
 * Rejected with `Err(PluginLoadError)`:
 *   - if `pluginId` is not currently in `plugins.loaded` (never discovered,
 *     failed to load, or was skipped) — there is no running plugin to pause;
 *   - if any other loaded plugin still depends on it (see module docs) —
 *     `error.details.dependents` lists every such plugin id;
 *   - if the plugin's own `onDisable` hook throws — the plugin is left
 *     exactly as it was (still enabled) rather than marked disabled despite
 *     a failed teardown.
 */
export async function disablePlugin(
  plugins: PluginLoadResult,
  statusTracker: PluginStatusTracker,
  pluginId: string,
): Promise<Result<void, PluginLoadError>> {
  const plugin = findLoaded(plugins, pluginId);
  if (!plugin) {
    return err(notLoadedError(pluginId));
  }

  if (statusTracker.isDisabled(pluginId)) {
    return ok(undefined);
  }

  const dependents = liveDependentsOf(plugins, statusTracker, pluginId);
  if (dependents.length > 0) {
    return err(dependentsRejection(pluginId, dependents));
  }

  try {
    await plugin.module.onDisable?.(plugin.context);
  } catch (cause) {
    return err(hookFailure(pluginId, "onDisable", cause));
  }

  statusTracker.disable(pluginId);
  return ok(undefined);
}

/**
 * Re-enable `pluginId` at runtime after a prior {@link disablePlugin} call —
 * no full process restart. Runs its `onEnable` hook (if any), then clears
 * its disabled marker in `statusTracker` so `introspectKernel()` reports
 * `status: "loaded"` for it again.
 *
 * Idempotent: enabling a plugin that is not currently disabled succeeds
 * immediately as a no-op, without calling `onEnable` a second time.
 *
 * Rejected with `Err(PluginLoadError)`:
 *   - if `pluginId` is not currently in `plugins.loaded` — there is no
 *     installed plugin to resume;
 *   - if the plugin's own `onEnable` hook throws — the plugin is left
 *     exactly as it was (still disabled) rather than marked enabled despite
 *     a failed re-activation.
 */
export async function enablePlugin(
  plugins: PluginLoadResult,
  statusTracker: PluginStatusTracker,
  pluginId: string,
): Promise<Result<void, PluginLoadError>> {
  const plugin = findLoaded(plugins, pluginId);
  if (!plugin) {
    return err(notLoadedError(pluginId));
  }

  if (!statusTracker.isDisabled(pluginId)) {
    return ok(undefined);
  }

  try {
    await plugin.module.onEnable?.(plugin.context);
  } catch (cause) {
    return err(hookFailure(pluginId, "onEnable", cause));
  }

  statusTracker.enable(pluginId);
  return ok(undefined);
}
