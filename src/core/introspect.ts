/**
 * Kernel introspection API (spec.md's plugin system, made observable):
 * "report loaded plugins, their capabilities, and load status."
 *
 * {@link introspectKernel} is a pure function over the kernel's already-built
 * state — loader.ts's `PluginLoadResult`, broker.ts's `CapabilityBroker`, and
 * plugin-status.ts's `PluginStatusTracker` — rather than a method that reads
 * hidden module state, so it can be exercised directly in tests without a
 * full `bootstrapKernel()` call. `server/index.ts` wires it up as
 * `kernel.introspect()`, closing over that kernel instance's own broker,
 * plugin-load result, and status tracker.
 *
 * ## Status derivation
 *
 * Every plugin id in `plugins.order` (loader.ts's dependency order — every
 * *valid* manifest that reached the dependency graph, whether it ultimately
 * loaded or failed) gets exactly one report, in that order:
 *
 *   - `"failed"`   — the plugin is in `plugins.failed` (its own load attempt
 *     threw, or it was skipped because a dependency of it failed first — see
 *     `FailedPlugin.skipped`).
 *   - `"disabled"` — the plugin is in `plugins.loaded` (it completed
 *     `onInstall`/`onEnable` successfully) AND `statusTracker.isDisabled(id)`
 *     is true (an operator-initiated decision — see plugin-status.ts).
 *   - `"loaded"`   — the plugin is in `plugins.loaded` and not disabled.
 *
 * ## Granted capabilities
 *
 * `capabilities.granted` is read live from the broker — `manifest.capabilities.requires`
 * filtered by `broker.isGranted(id, capabilityId)` — rather than cached at
 * load time, so a capability revoked after loading (including everything
 * loader.ts's own failure-rollback already revokes for a `failed` plugin)
 * is always reflected accurately, not just what was true at the moment the
 * plugin loaded.
 */
import type { CapabilityBroker } from "./broker.js";
import type { FailedPlugin, LoadedPlugin, PluginLoadResult } from "./loader.js";
import type { PluginStatusTracker } from "./plugin-status.js";

export type PluginStatus = "loaded" | "failed" | "disabled";

/** A single plugin's introspection entry: id, version, status, and capabilities. */
export interface PluginIntrospectionReport {
  readonly id: string;
  readonly version: string;
  readonly status: PluginStatus;
  readonly capabilities: {
    /** Capability ids this plugin's manifest declares under `capabilities.provides`. */
    readonly provides: readonly string[];
    /** Capability ids this plugin's manifest declares under `capabilities.requires` (the ceiling of what it may ever be granted). */
    readonly requires: readonly string[];
    /** The subset of `requires` currently granted per the broker, live — see module docs. */
    readonly granted: readonly string[];
  };
  /** Present only for `status: "failed"` — the normalized failure message (loader.ts's `FailedPlugin.error.message`). */
  readonly error?: string;
  /** Present only for `status: "failed"` — `true` if this plugin was never attempted because a dependency of it failed first. */
  readonly skipped?: boolean;
}

/** Full kernel introspection report: one entry per plugin plus a status-count summary. */
export interface KernelIntrospectionReport {
  readonly plugins: readonly PluginIntrospectionReport[];
  readonly summary: {
    readonly total: number;
    readonly loaded: number;
    readonly failed: number;
    readonly disabled: number;
  };
}

function grantedCapabilities(
  pluginId: string,
  requires: readonly string[],
  broker: CapabilityBroker,
): readonly string[] {
  return requires.filter((capabilityId) => broker.isGranted(pluginId, capabilityId));
}

function reportLoaded(
  plugin: LoadedPlugin,
  broker: CapabilityBroker,
  disabled: boolean,
): PluginIntrospectionReport {
  const { provides, requires } = plugin.manifest.capabilities;
  return {
    id: plugin.id,
    version: plugin.manifest.version,
    status: disabled ? "disabled" : "loaded",
    capabilities: { provides, requires, granted: grantedCapabilities(plugin.id, requires, broker) },
  };
}

function reportFailed(plugin: FailedPlugin, broker: CapabilityBroker): PluginIntrospectionReport {
  const { provides, requires } = plugin.manifest.capabilities;
  return {
    id: plugin.id,
    version: plugin.manifest.version,
    status: "failed",
    capabilities: { provides, requires, granted: grantedCapabilities(plugin.id, requires, broker) },
    error: plugin.error.message,
    skipped: plugin.skipped,
  };
}

/**
 * Build a full {@link KernelIntrospectionReport} from a completed
 * {@link PluginLoadResult}, the {@link CapabilityBroker} it was loaded
 * against, and (optionally) a {@link PluginStatusTracker} recording any
 * administrative disables. Never throws.
 */
export function introspectKernel(
  plugins: PluginLoadResult,
  broker: CapabilityBroker,
  statusTracker?: PluginStatusTracker,
): KernelIntrospectionReport {
  const loadedById = new Map(plugins.loaded.map((plugin) => [plugin.id, plugin]));
  const failedById = new Map(plugins.failed.map((plugin) => [plugin.id, plugin]));

  const reports: PluginIntrospectionReport[] = [];
  for (const id of plugins.order) {
    const failed = failedById.get(id);
    if (failed) {
      reports.push(reportFailed(failed, broker));
      continue;
    }
    const loaded = loadedById.get(id);
    if (loaded) {
      reports.push(reportLoaded(loaded, broker, statusTracker?.isDisabled(id) ?? false));
    }
    // Unreachable in practice: `order` is derived 1:1 from the same manifest
    // set loader.ts partitions into `loaded`/`failed` — every id lands in
    // exactly one of the two. If neither map has it, there is nothing
    // truthful to report, so it is silently skipped rather than guessed at.
  }

  const summary = {
    total: reports.length,
    loaded: reports.filter((report) => report.status === "loaded").length,
    failed: reports.filter((report) => report.status === "failed").length,
    disabled: reports.filter((report) => report.status === "disabled").length,
  };

  return { plugins: reports, summary };
}

function formatCapabilityList(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(", ") : "(none)";
}

/**
 * Render a {@link KernelIntrospectionReport} as a human-readable, multi-line
 * plain-text report — the CLI's own formatting (see `src/cli/introspect.ts`),
 * factored out here so it can be tested without spawning a process.
 */
export function formatIntrospectionReport(report: KernelIntrospectionReport): string {
  const lines: string[] = ["Kernel Plugin Report", "====================="];

  if (report.plugins.length === 0) {
    lines.push("(no plugins loaded)");
  }

  for (const plugin of report.plugins) {
    lines.push("");
    lines.push(`${plugin.id}@${plugin.version} — ${plugin.status}`);
    lines.push(`  provides: ${formatCapabilityList(plugin.capabilities.provides)}`);
    lines.push(`  requires: ${formatCapabilityList(plugin.capabilities.requires)}`);
    lines.push(`  granted:  ${formatCapabilityList(plugin.capabilities.granted)}`);
    if (plugin.status === "failed") {
      lines.push(`  error:    ${plugin.error ?? "unknown error"}`);
      if (plugin.skipped) {
        lines.push(`  (skipped — a dependency failed to load)`);
      }
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${String(report.summary.total)} total — ${String(report.summary.loaded)} loaded, ` +
      `${String(report.summary.failed)} failed, ${String(report.summary.disabled)} disabled.`,
  );

  return lines.join("\n");
}
