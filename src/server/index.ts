/**
 * Kernel bootstrap.
 *
 * This is the one place every kernel primitive gets wired together and the
 * HTTP server starts (spec.md: "server/index.ts — bootstrap: load kernel,
 * mount plugins, listen"):
 *
 *   1. Load and validate the kernel's own config (config.ts's
 *      `loadCoreConfig()` — NODE_ENV/PORT/LOG_LEVEL).
 *   2. Build the kernel-scoped structured logger (logger.ts's
 *      `createLogger()`), using the config's own `LOG_LEVEL`.
 *   3. Construct the kernel's shared primitives: the in-memory audit sink
 *      (audit.ts), the capability broker wired to that sink (broker.ts), and
 *      the typed event bus (events.ts) — each created exactly once, per
 *      those modules' own "factory, not singleton, no ambient authority"
 *      design, and threaded explicitly from here.
 *   4. Discover plugins under `src/plugins/*` (registry.ts's
 *      `scanPluginDirectories()`), validate each one's manifest
 *      (manifest.ts's `validateManifest()`), and dynamically `import()` its
 *      `entry_point` to get an in-memory module — the glue loader.ts's own
 *      docs (feature #8) flagged as still missing and left for this feature.
 *   5. Resolve dependency order and run every plugin's lifecycle hooks
 *      (loader.ts's `loadPlugins()`), wired to the broker built in step 3.
 *   6. Once every plugin has finished its load attempt, reach the Fastify
 *      instance the `api-gateway` plugin constructed in its own `onEnable`
 *      (feature #58 — this module never calls `Fastify(...)` itself) via its
 *      `http:route` capability, and start listening on it ({@link listen}).
 *      This is why listening only ever happens strictly after the whole
 *      plugin-load pass completes, never mid-load.
 *
 * ## Fatal vs. isolated failures
 *
 * Per spec.md's "graceful degradation" baseline ("a broken plugin must not
 * crash the kernel or unrelated plugins"), most per-plugin problems are
 * isolated, not fatal:
 *
 *   - A plugin directory with a missing/malformed `plugin.json` is skipped
 *     and logged by `scanPluginDirectories()` itself (registry.ts).
 *   - A `plugin.json` that parses but fails schema validation
 *     (`validateManifest()`) is skipped and logged here — it never becomes a
 *     graph node, since an invalid manifest carries no trustworthy id or
 *     `depends_on` to reason about.
 *   - A *valid* manifest whose `entry_point` fails to `import()` (the normal
 *     case today, per claude-progress.txt — no shipped plugin has a real
 *     lifecycle module yet) is still added to the dependency graph as a real
 *     node, so genuine cross-plugin structural problems referencing it are
 *     still caught, but with a "poison" module whose `onInstall` throws
 *     immediately. `loadPlugins()`'s own per-plugin isolation (feature #10)
 *     then takes over exactly as it would for any other runtime failure:
 *     that one plugin — and only its dependents — are recorded as `failed`,
 *     without aborting the rest of the boot.
 *
 * Two classes of problem ARE fatal — they abort the whole boot with a clear,
 * single-line, non-stack-trace message on stderr and a non-zero exit code
 * (see {@link formatFatalStartupError}), because there is no safe, partial
 * way to recover from them:
 *
 *   - A config error (`loadCoreConfig()` throwing `ConfigError`) — the
 *     kernel does not even know what port to listen on or how verbosely to
 *     log.
 *   - A structural dependency-graph error across the *valid* manifest set —
 *     a circular dependency, a `depends_on` id that does not exist, an
 *     unsatisfied semver range, or two plugins claiming the same id
 *     (`resolveLoadOrder()`, called inside `loadPlugins()`, returning `Err`)
 *     — or the plugins root itself being unreadable
 *     (`scanPluginDirectories()` throwing). Both are manifest-level
 *     misconfigurations spanning more than one plugin, not a single
 *     plugin's own runtime failure, so there is nothing to isolate.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInMemoryAuditSink, type InMemoryAuditSink } from "../core/audit.js";
import { createCapabilityBroker, type CapabilityBroker } from "../core/broker.js";
import { loadCoreConfig, type CoreConfig } from "../core/config.js";
import { isAppError, PluginLoadError } from "../core/errors.js";
import { createEventBus, type EventBus } from "../core/events.js";
import {
  introspectKernel,
  introspectKernelWithHealth,
  type KernelIntrospectionReport,
} from "../core/introspect.js";
import {
  loadPlugins,
  type PluginDefinition,
  type PluginLoadResult,
  type PluginModule,
} from "../core/loader.js";
import { createLogger, type Logger } from "../core/logger.js";
import { validateManifest, type PluginManifest } from "../core/manifest.js";
import { createPluginStatusTracker, type PluginStatusTracker } from "../core/plugin-status.js";
import { scanPluginDirectories, type PluginScanEntry } from "../core/registry.js";
import {
  disablePlugin as disablePluginRuntime,
  enablePlugin as enablePluginRuntime,
} from "../core/runtime-control.js";
import { isErr, type Result } from "../core/types.js";
// Type-only: erased at compile time, so this does not create a runtime
// dependency from the kernel on a specific plugin's module — the kernel
// still only ever *reaches* api-gateway's Fastify instance dynamically,
// through the `http:route` capability a `LoadedPlugin`'s `module.provides`
// already carries (see `getHttpApp` below). This mirrors how a *consuming*
// plugin type-imports another plugin's capability interface purely for
// `capabilities.obtain<T>()`'s type parameter (see e.g.
// `database-mysql/src/query-capability.ts`'s `DbQueryCapability`) — spec.md's
// "no plugin imports another plugin's internals directly" is about runtime
// coupling, which a type-only import never creates.
import type { ApiGatewayApp, HttpRouteCapability } from "../plugins/api-gateway/index.js";

/** Every shared kernel primitive, wired together and ready to hand to the HTTP layer. */
export interface Kernel {
  readonly config: CoreConfig;
  readonly logger: Logger;
  readonly broker: CapabilityBroker;
  readonly auditSink: InMemoryAuditSink;
  readonly eventBus: EventBus;
  /** The result of discovering and loading every valid plugin — see loader.ts's `PluginLoadResult`. */
  readonly plugins: PluginLoadResult;
  /**
   * Tracks which plugins are administratively disabled (feature #13's seam
   * for feature #16's `kernel.disablePlugin()`/`enablePlugin()`) — see
   * plugin-status.ts. Starts empty at boot; nothing in this feature disables
   * a plugin on its own.
   */
  readonly pluginStatus: PluginStatusTracker;
  /**
   * Kernel introspection API (feature #13, spec.md: "report loaded plugins,
   * their capabilities, and load status"): every plugin's id, version,
   * status (`loaded`/`failed`/`disabled`), and currently-granted
   * capabilities, read live from `broker`/`plugins`/`pluginStatus` — see
   * introspect.ts's `introspectKernel()`.
   */
  introspect(): KernelIntrospectionReport;
  /**
   * Same report as {@link introspect}, augmented with a per-plugin `health`
   * field (feature #24) sourced from any provided capability whose
   * implementation exposes a `healthCheck()` method — e.g. database-mysql's
   * `db:query` capability's trivial `SELECT 1` probe. Async (an actual live
   * network probe, unlike the rest of the report) — see introspect.ts's
   * `introspectKernelWithHealth()` for the exact contract.
   */
  introspectWithHealth(): Promise<KernelIntrospectionReport>;
  /**
   * Disable a loaded plugin at runtime — no full process restart (feature
   * #16). Runs the plugin's `onDisable` hook, then flips `pluginStatus` so
   * `introspect()` reports it as `"disabled"` from here on. Rejected
   * (`Err(PluginLoadError)`) if `pluginId` is not currently loaded, or if
   * another loaded plugin still depends on it — see runtime-control.ts's
   * `disablePlugin()` for the exact contract (including idempotency).
   */
  disablePlugin(pluginId: string): Promise<Result<void, PluginLoadError>>;
  /**
   * Re-enable a plugin previously paused via {@link disablePlugin}. Runs its
   * `onEnable` hook, then clears its disabled marker so `introspect()`
   * reports it as `"loaded"` again — see runtime-control.ts's
   * `enablePlugin()` for the exact contract (including idempotency).
   */
  enablePlugin(pluginId: string): Promise<Result<void, PluginLoadError>>;
  /**
   * The Fastify instance the `api-gateway` plugin constructed in its own
   * `onEnable` hook (feature #58), reached only through its `http:route`
   * capability registration — never constructed by the kernel itself.
   * `undefined` when `api-gateway` is absent or failed to load, in which case
   * there is no HTTP server to mount/listen on for this boot.
   */
  readonly httpApp: ApiGatewayApp | undefined;
}

export interface BootstrapKernelOptions {
  /** Env map for `loadCoreConfig()`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Absolute path to the plugins root to scan. Defaults to `src/plugins` next to this module. */
  pluginsRoot?: string;
  /** Logger shared by every kernel component. Defaults to a fresh logger built from the resolved config's `LOG_LEVEL`. */
  logger?: Logger;
}

const DEFAULT_PLUGINS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins",
);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render any fatal startup error as a single, human-readable line with no
 * stack trace — see the module docs' "Fatal vs. isolated failures". AppErrors
 * (`ConfigError`, `PluginLoadError`, ...) use their own code + already
 * safe/aggregated `message` (never `stack`); anything else falls back to its
 * own `message`, or `String(error)` for a non-`Error` throw.
 */
export function formatFatalStartupError(error: unknown): string {
  const message = isAppError(error) ? `${error.code}: ${error.message}` : describeError(error);
  // Defensive: collapse any embedded newline into a space so this is always
  // exactly one line on stderr, regardless of what a message happens to contain.
  return message.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * Resolve one scanned, already-validated plugin manifest to a
 * {@link PluginDefinition} by dynamically importing its `entry_point`. A
 * plugin whose entry point cannot be imported (the common case today — no
 * shipped plugin has a lifecycle module yet) still becomes a real graph node
 * with a "poison" module that fails immediately in `onInstall`, so
 * `loadPlugins()`'s own per-plugin isolation (and dependency cascade) takes
 * over instead of this function silently dropping the plugin from the
 * dependency graph — see the module docs.
 */
async function resolvePluginDefinition(
  entry: PluginScanEntry,
  manifest: PluginManifest,
  logger: Logger,
): Promise<PluginDefinition> {
  const entryPointPath = path.join(entry.directoryPath, manifest.entry_point);

  let pluginModule: PluginModule;
  try {
    pluginModule = (await import(pathToFileURL(entryPointPath).href)) as PluginModule;
  } catch (cause) {
    const message =
      `Plugin "${manifest.id}" could not load its entry point "${manifest.entry_point}": ` +
      describeError(cause);
    logger.warn({ plugin: manifest.id, entryPoint: entryPointPath, err: cause }, message);
    pluginModule = {
      onInstall: () => {
        throw new PluginLoadError(message, { details: { pluginId: manifest.id }, cause });
      },
    };
  }

  return { manifest, module: pluginModule };
}

/**
 * Scan `pluginsRoot`, validate every discovered manifest, and resolve each
 * valid one to a {@link PluginDefinition} (see {@link resolvePluginDefinition}).
 * A manifest that fails schema validation is skipped and logged here — it is
 * never added to the dependency graph at all (see module docs).
 */
async function discoverPluginDefinitions(
  pluginsRoot: string,
  logger: Logger,
): Promise<PluginDefinition[]> {
  const { entries } = await scanPluginDirectories(pluginsRoot, { logger });

  const definitions: PluginDefinition[] = [];
  for (const entry of entries) {
    const manifestResult = validateManifest(entry.manifest);
    if (isErr(manifestResult)) {
      logger.warn(
        { plugin: entry.name, err: manifestResult.error },
        `Skipping plugin "${entry.name}": invalid plugin.json (${manifestResult.error.message}).`,
      );
      continue;
    }
    definitions.push(await resolvePluginDefinition(entry, manifestResult.value, logger));
  }
  return definitions;
}

/** The plugin id spec.md designates as "the single place HTTP routes come into existence." */
const API_GATEWAY_PLUGIN_ID = "api-gateway";

/** Narrow, structural check — no runtime dependency on api-gateway's module, just its documented shape. */
function isHttpRouteCapability(value: unknown): value is HttpRouteCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    "getApp" in value &&
    typeof (value as { getApp: unknown }).getApp === "function"
  );
}

/**
 * Reach the Fastify instance `api-gateway` constructed in its own `onEnable`
 * (see `src/plugins/api-gateway/index.ts`) via the `http:route` capability it
 * registered with the broker — read directly off the already-loaded plugin's
 * `module.provides`, the same way `introspect.ts` reads plugin state
 * directly rather than through `broker.forPlugin()`'s identity-gated
 * `obtain()` (which is for *other plugins*, not the kernel itself). Returns
 * `undefined` — never throws — when `api-gateway` did not load successfully
 * or its `http:route` provider doesn't have the expected shape, so a missing
 * or broken api-gateway is just "no HTTP server this boot" rather than a
 * kernel-crashing error; the caller decides whether that's fatal.
 */
function getHttpApp(plugins: PluginLoadResult, logger: Logger): ApiGatewayApp | undefined {
  const apiGateway = plugins.loaded.find((plugin) => plugin.id === API_GATEWAY_PLUGIN_ID);
  if (!apiGateway) {
    return undefined;
  }

  const httpRoute = apiGateway.module.provides?.["http:route"];
  if (!isHttpRouteCapability(httpRoute)) {
    logger.warn(
      { plugin: API_GATEWAY_PLUGIN_ID },
      `Plugin "${API_GATEWAY_PLUGIN_ID}" loaded but its "http:route" capability does not have the ` +
        `expected shape; no HTTP server will be mounted for this boot.`,
    );
    return undefined;
  }

  return httpRoute.getApp();
}

/**
 * Construct the whole kernel: load config, build the logger, wire the
 * broker/audit sink/event bus together, discover plugins, and load them in
 * dependency order. Throws — never calls `process.exit` itself, that is
 * `main()`'s job — on either fatal class of error described in the module
 * docs, so callers/tests can inspect the raised error directly.
 */
export async function bootstrapKernel(options: BootstrapKernelOptions = {}): Promise<Kernel> {
  const config = loadCoreConfig({ ...(options.env !== undefined ? { env: options.env } : {}) });
  const logger =
    options.logger ?? createLogger({ level: config.LOG_LEVEL, context: { module: "kernel" } });
  const pluginsRoot = options.pluginsRoot ?? DEFAULT_PLUGINS_ROOT;

  const auditSink = createInMemoryAuditSink();
  const broker = createCapabilityBroker({ auditSink });
  const eventBus = createEventBus();
  const pluginStatus = createPluginStatusTracker();

  const definitions = await discoverPluginDefinitions(pluginsRoot, logger);

  const loadResult = await loadPlugins(definitions, broker, { logger, auditSink });
  if (isErr(loadResult)) {
    throw loadResult.error;
  }
  const plugins = loadResult.value;

  logger.info(
    {
      pluginsRoot,
      loaded: plugins.loaded.map((plugin) => plugin.id),
      failed: plugins.failed.map((plugin) => ({
        id: plugin.id,
        skipped: plugin.skipped,
      })),
    },
    "Kernel bootstrap complete.",
  );

  const httpApp = getHttpApp(plugins, logger);

  return {
    config,
    logger,
    broker,
    auditSink,
    eventBus,
    plugins,
    pluginStatus,
    introspect: () => introspectKernel(plugins, broker, pluginStatus),
    introspectWithHealth: () => introspectKernelWithHealth(plugins, broker, pluginStatus),
    disablePlugin: (pluginId: string) => disablePluginRuntime(plugins, pluginStatus, pluginId),
    enablePlugin: (pluginId: string) => enablePluginRuntime(plugins, pluginStatus, pluginId),
    httpApp,
  };
}

/**
 * Start listening on the kernel's api-gateway-owned Fastify instance. Only
 * ever called after `bootstrapKernel()` has resolved — i.e. after every
 * plugin has finished its load attempt (loaded or isolated-failed) — so
 * listening always happens strictly after the full plugin-load pass, never
 * mid-load (feature #58's step 2). A missing `httpApp` (api-gateway absent
 * or failed to load) is fatal here: with no HTTP server constructed, there
 * is nothing to listen on. Exported so tests can exercise this guarantee
 * directly against a real `bootstrapKernel()`-produced `Kernel`, without
 * spawning the process-exiting `main()`.
 */
export async function listen(kernel: Kernel): Promise<void> {
  if (!kernel.httpApp) {
    throw new PluginLoadError(
      `Plugin "${API_GATEWAY_PLUGIN_ID}" did not load successfully; no HTTP server available to start.`,
      { details: { pluginId: API_GATEWAY_PLUGIN_ID } },
    );
  }
  await kernel.httpApp.listen({ port: kernel.config.PORT, host: "0.0.0.0" });
}

async function main(): Promise<void> {
  const kernel = await bootstrapKernel();
  await listen(kernel);
}

// Only auto-start when this module is run directly (not when imported by
// tests) — compares resolved URLs rather than matching a hard-coded
// ".ts"/".js" suffix, so this works the same way whether `tsx` is running
// this very .ts file (dev) or a compiled build is running the emitted .js.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((cause: unknown) => {
    // Deliberately console.error a single formatted line, never the raw
    // error/stack trace — see this module's "Fatal vs. isolated failures".
    console.error(`Fatal startup error: ${formatFatalStartupError(cause)}`);
    process.exit(1);
  });
}
