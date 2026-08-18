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
 *
 * ## Per-plugin health (feature #24)
 *
 * {@link introspectKernelWithHealth} augments the same report with an
 * optional `health` field per plugin, sourced from any capability that plugin
 * provides whose implementation happens to expose a zero-arg
 * `healthCheck(): Promise<{ healthy, error? }>` method (see
 * {@link HealthCheckableCapability}) — duck-typed structurally, exactly the
 * way `server/index.ts`'s `getHttpApp()` reaches api-gateway's `http:route`
 * capability directly off `LoadedPlugin.module.provides` rather than through
 * `broker.obtain()` (which is gated to *other plugins*, not the kernel
 * itself). This is deliberately generic, not hard-coded to database-mysql's
 * `db:query` capability: any current or future capability (a cache, a queue,
 * a second database) gets the exact same treatment simply by implementing
 * `healthCheck()` on the object it registers with the broker — this module
 * has no import of, or special-case for, any specific plugin.
 *
 * A plugin that provides no health-checkable capability gets no `health` key
 * at all (not `undefined` written out, not a synthetic "unknown" status) —
 * its report is byte-for-byte identical to what {@link introspectKernel}
 * alone would have produced, so existing consumers of the base report are
 * unaffected. A plugin providing one or more health-checkable capabilities is
 * `"healthy"` only if every one of them reports healthy; the first
 * unhealthy result's `error` (if any) is surfaced on the plugin's `health`
 * field. A `healthCheck()` that itself throws/rejects (rather than resolving
 * `{ healthy: false, ... }` per its own contract) is treated the same as an
 * explicit unhealthy result — this function never rejects.
 *
 * `introspectKernel` itself stays synchronous and unchanged — a plugin's
 * `health` is inherently a live, point-in-time network probe, unlike the
 * rest of the report which is derived from already-known in-memory state —
 * so this is a separate, additive async function rather than a breaking
 * change to the existing sync API every current caller/test relies on.
 *
 * ## Basic query performance metrics (feature #26)
 *
 * `metrics` is folded directly into {@link introspectKernel}'s own
 * synchronous report — unlike `health` above, it needs no separate async
 * variant, because reading a capability's counters is just reading
 * already-accumulated in-memory numbers, never a live network probe. Any
 * capability a plugin provides whose implementation exposes a zero-arg,
 * synchronous `getMetrics(): { queryCount, errorCount, averageDurationMs }`
 * (see {@link MetricsCapability}) is picked up the same duck-typed way
 * `health` picks up `healthCheck()` — structurally, with no import of or
 * special-case for `database-mysql`'s `db:query` capability (see
 * `query-capability.ts`'s `DbQueryCapability.getMetrics`), which is simply
 * the first capability to implement it. A plugin providing more than one
 * metrics-capable capability gets one combined snapshot: counts summed,
 * and the average duration recomputed as a count-weighted mean across all
 * of them (not a plain average of averages, which would under-weight a
 * capability that handled far more queries than another).
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
  /**
   * Present only when {@link introspectKernelWithHealth} produced this report
   * AND this plugin provides at least one health-checkable capability — see
   * this module's "Per-plugin health" docs. Absent for `introspectKernel()`'s
   * plain report, and absent for any plugin with nothing health-checkable to
   * report on.
   */
  readonly health?: PluginHealthReport;
  /**
   * Present only when at least one capability this plugin provides exposes
   * a metrics-capable `getMetrics()` — see this module's "Basic query
   * performance metrics" docs and {@link MetricsCapability}. Unlike
   * `health`, this is populated by the plain, synchronous
   * {@link introspectKernel} itself (no `WithHealth`-style async variant
   * needed) and is absent for a `failed` plugin, same as `health`.
   */
  readonly metrics?: CapabilityMetricsSnapshot;
}

/** `"unhealthy"` if any health-checkable capability a plugin provides reported unhealthy (or threw); `"healthy"` only if every one of them reported healthy. */
export type PluginHealthStatus = "healthy" | "unhealthy";

/** A single plugin's folded-together health result — see {@link introspectKernelWithHealth}. */
export interface PluginHealthReport {
  readonly status: PluginHealthStatus;
  /** Present only for `status: "unhealthy"`, when the failing check supplied one. */
  readonly error?: string;
}

/**
 * The structural protocol (feature #24) a provided capability's
 * implementation can opt into for per-plugin health reporting: a zero-arg
 * `healthCheck()` resolving `{ healthy, error? }`. `database-mysql`'s
 * `db:query` capability implements this (see `query-capability.ts`'s
 * `DbQueryCapability.healthCheck`), but nothing here is specific to it — any
 * capability implementation with a matching `healthCheck` method is picked up
 * the same way, duck-typed rather than imported.
 */
export interface HealthCheckableCapability {
  healthCheck(): Promise<{ readonly healthy: boolean; readonly error?: string }>;
}

/** A capability's basic query performance counters — see {@link MetricsCapability} and this module's "Basic query performance metrics" docs. */
export interface CapabilityMetricsSnapshot {
  readonly queryCount: number;
  readonly errorCount: number;
  readonly averageDurationMs: number;
}

/**
 * The structural protocol (feature #26) a provided capability's
 * implementation can opt into for per-plugin performance-counter
 * reporting: a zero-arg, synchronous `getMetrics()` returning
 * `{ queryCount, errorCount, averageDurationMs }`. `database-mysql`'s
 * `db:query` capability implements this (see `query-capability.ts`'s
 * `DbQueryCapability.getMetrics`), but nothing here is specific to it —
 * any capability implementation with a matching `getMetrics` method is
 * picked up the same way, duck-typed rather than imported. Synchronous
 * (unlike {@link HealthCheckableCapability.healthCheck}) because reading
 * already-accumulated in-memory counters needs no I/O.
 */
export interface MetricsCapability {
  getMetrics(): CapabilityMetricsSnapshot;
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

/** Structural check for {@link MetricsCapability} — a `getMetrics` function on an object, nothing more. */
function isMetricsCapable(value: unknown): value is MetricsCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    "getMetrics" in value &&
    typeof (value as { getMetrics: unknown }).getMetrics === "function"
  );
}

/**
 * Fold multiple capabilities' {@link CapabilityMetricsSnapshot}s into one:
 * counts summed, average duration recomputed as a count-weighted mean (see
 * this module's "Basic query performance metrics" docs for why — a plain
 * average of averages would under-weight a capability that handled far
 * more queries than another).
 */
function foldCapabilityMetrics(
  snapshots: readonly CapabilityMetricsSnapshot[],
): CapabilityMetricsSnapshot | undefined {
  if (snapshots.length === 0) {
    return undefined;
  }

  const queryCount = snapshots.reduce((sum, snapshot) => sum + snapshot.queryCount, 0);
  const errorCount = snapshots.reduce((sum, snapshot) => sum + snapshot.errorCount, 0);
  const totalDurationMs = snapshots.reduce(
    (sum, snapshot) => sum + snapshot.averageDurationMs * snapshot.queryCount,
    0,
  );

  return {
    queryCount,
    errorCount,
    averageDurationMs: queryCount === 0 ? 0 : totalDurationMs / queryCount,
  };
}

/**
 * Read and fold every metrics-capable capability `module.provides`
 * exposes into one {@link CapabilityMetricsSnapshot}, or `undefined` if
 * none of them are metrics-capable. Synchronous and never throws — unlike
 * {@link healthForModule}, `getMetrics()` is defined to be a plain,
 * synchronous read of in-memory counters, so there is no rejection path to
 * guard against here.
 */
function metricsForModule(
  provides: Readonly<Record<string, unknown>> | undefined,
): CapabilityMetricsSnapshot | undefined {
  const capable = Object.values(provides ?? {}).filter(isMetricsCapable);
  if (capable.length === 0) {
    return undefined;
  }

  return foldCapabilityMetrics(capable.map((capability) => capability.getMetrics()));
}

function reportLoaded(
  plugin: LoadedPlugin,
  broker: CapabilityBroker,
  disabled: boolean,
): PluginIntrospectionReport {
  const { provides, requires } = plugin.manifest.capabilities;
  const metrics = metricsForModule(plugin.module.provides);
  return {
    id: plugin.id,
    version: plugin.manifest.version,
    status: disabled ? "disabled" : "loaded",
    capabilities: { provides, requires, granted: grantedCapabilities(plugin.id, requires, broker) },
    ...(metrics ? { metrics } : {}),
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

/** Human-readable detail from an unknown thrown value — mirrors query-capability.ts's own `describeError`. */
function describeHealthCheckError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Structural check for {@link HealthCheckableCapability} — a `healthCheck` function on an object, nothing more. */
function isHealthCheckable(value: unknown): value is HealthCheckableCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    "healthCheck" in value &&
    typeof (value as { healthCheck: unknown }).healthCheck === "function"
  );
}

/**
 * Run every health-checkable capability `module.provides` exposes and fold
 * the results into one {@link PluginHealthReport}, or `undefined` if none of
 * them are health-checkable. See this module's "Per-plugin health" docs for
 * the folding rule (unhealthy wins) and never-throws guarantee.
 */
async function healthForModule(
  provides: Readonly<Record<string, unknown>> | undefined,
): Promise<PluginHealthReport | undefined> {
  const checkable = Object.values(provides ?? {}).filter(isHealthCheckable);
  if (checkable.length === 0) {
    return undefined;
  }

  const results = await Promise.all(
    checkable.map(async (capability) => {
      try {
        return await capability.healthCheck();
      } catch (cause) {
        return { healthy: false, error: describeHealthCheckError(cause) };
      }
    }),
  );

  const failure = results.find((result) => !result.healthy);
  if (!failure) {
    return { status: "healthy" };
  }
  return failure.error !== undefined
    ? { status: "unhealthy", error: failure.error }
    : { status: "unhealthy" };
}

/**
 * Build a {@link KernelIntrospectionReport} exactly like {@link introspectKernel},
 * then augment each loaded plugin's entry with a `health` field — see this
 * module's "Per-plugin health" docs. A `failed` plugin's entry is left
 * untouched (there is no live `module.provides` to probe for a plugin whose
 * load attempt itself failed). Never rejects.
 */
export async function introspectKernelWithHealth(
  plugins: PluginLoadResult,
  broker: CapabilityBroker,
  statusTracker?: PluginStatusTracker,
): Promise<KernelIntrospectionReport> {
  const report = introspectKernel(plugins, broker, statusTracker);
  const loadedById = new Map(plugins.loaded.map((plugin) => [plugin.id, plugin]));

  const withHealth = await Promise.all(
    report.plugins.map(async (entry): Promise<PluginIntrospectionReport> => {
      const loaded = loadedById.get(entry.id);
      const health = await healthForModule(loaded?.module.provides);
      return health ? { ...entry, health } : entry;
    }),
  );

  return { ...report, plugins: withHealth };
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
    if (plugin.health) {
      const suffix = plugin.health.error !== undefined ? ` (${plugin.health.error})` : "";
      lines.push(`  health:   ${plugin.health.status}${suffix}`);
    }
    if (plugin.metrics) {
      lines.push(
        `  metrics:  ${String(plugin.metrics.queryCount)} queries, ` +
          `${String(plugin.metrics.errorCount)} errors, ` +
          `${plugin.metrics.averageDurationMs.toFixed(1)}ms avg`,
      );
    }
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
