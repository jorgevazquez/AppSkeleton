/**
 * api-gateway plugin lifecycle module (feature #58 — "Fastify instance owned
 * by api-gateway, mounted into kernel bootstrap").
 *
 * spec.md: "The single place HTTP routes come into existence. Wraps
 * Fastify..." — this module is where that wrapping actually happens. Nothing
 * outside this plugin ever calls `Fastify(...)` directly; the kernel
 * bootstrap (`src/server/index.ts`) only ever reaches the resulting instance
 * through the `http:route` capability this plugin registers, which is how
 * spec.md's "no plugin imports another plugin's internals directly — only
 * via kernel-brokered capabilities" holds for the HTTP layer too.
 *
 * ## Why the Fastify instance is constructed in `onEnable`, not at module scope
 *
 * The loader (`loader.ts`) registers a plugin's `capabilities.provides`
 * implementations with the broker *before* calling `onInstall`/`onEnable` —
 * so `provides["http:route"]` must already be a stable object reference by
 * the time this module is first imported. To still honor this feature's
 * step 1 ("move Fastify construction ... into the api-gateway plugin's
 * `onEnable` hook"), `provides["http:route"]` is a small, stable facade
 * ({@link HttpRouteCapability}) whose `getApp()` method closes over a
 * module-level `app` variable that is only assigned once `onEnable` actually
 * runs `Fastify(...)` — the facade object itself never changes identity, but
 * it has nothing live to hand back until `onEnable` has run.
 *
 * ## Scope of this feature
 *
 * This module only owns constructing the instance and a `/health` route —
 * proving the kernel can mount and listen on a plugin-owned Fastify
 * instance. The typed route-registration surface other plugins use to
 * register their own routes through `http:route` is feature #59's job (see
 * feature_list.json), not this one.
 */
import Fastify from "fastify";
import { createLogger } from "../../core/logger.js";
import type { PluginLifecycleContext } from "../../core/loader.js";

/**
 * Construct the Fastify instance this plugin owns, with the given lifecycle
 * context's logger level. A standalone function — rather than inlining this
 * in `onEnable` — purely so {@link ApiGatewayApp} can be derived from its
 * actual return type: `Fastify(...)`'s generic `LoggerType` parameter is
 * inferred from the `loggerInstance` passed here (pino's `Logger`, not
 * Fastify's own default `FastifyBaseLogger`), and those two are not
 * interchangeable in Fastify's own types (`route()`'s options are typed
 * contravariantly in `LoggerType`) — so anything holding onto this instance
 * elsewhere in this module must use this exact inferred type, not a
 * default-generic `FastifyInstance`.
 */
function buildApp(context: PluginLifecycleContext) {
  const built = Fastify({
    loggerInstance: createLogger({
      level: context.logger.level,
      context: { module: "http" },
    }),
  });

  built.get("/health", async () => ({ status: "ok" }));

  return built;
}

/** The exact Fastify instance type {@link buildApp} produces — see its docs. */
export type ApiGatewayApp = ReturnType<typeof buildApp>;

/**
 * What api-gateway registers with the broker under the `http:route`
 * capability id. Deliberately minimal for this feature — just enough for the
 * kernel bootstrap to reach the live Fastify instance once it exists; see
 * this module's docs.
 */
export interface HttpRouteCapability {
  /**
   * The live Fastify instance constructed in `onEnable`. Throws if called
   * before `onEnable` has run (which should never happen for a caller
   * reading this off an already-`loaded` plugin, since `onInstall` +
   * `onEnable` always complete before a plugin is recorded as loaded — see
   * `loader.ts`).
   */
  getApp(): ApiGatewayApp;
}

/** The Fastify instance this plugin owns, constructed by `onEnable`. `undefined` before enable / after disable. */
let app: ApiGatewayApp | undefined;

function getApp(): ApiGatewayApp {
  if (!app) {
    throw new Error(
      "api-gateway: the Fastify instance was requested before onEnable constructed it.",
    );
  }
  return app;
}

/**
 * Registered with the broker before this module's lifecycle hooks run — see
 * module docs. Typed as always-present (`Readonly<Record<string, unknown>>`,
 * not `PluginModule["provides"]`'s `| undefined`) since this module always
 * has an `http:route` implementation to offer, regardless of lifecycle
 * state; `PluginModule["provides"]` is optional only for plugins that
 * provide nothing at all.
 */
export const provides: Readonly<Record<string, unknown>> = {
  "http:route": { getApp } satisfies HttpRouteCapability,
};

/**
 * Construct the Fastify instance this plugin owns (see {@link buildApp}),
 * registering its one built-in route (`/health`, matching the pre-existing
 * toolchain smoke test's shape). `buildApp` uses a fresh `createLogger()` —
 * not `context.logger` directly — for the same reason the former placeholder
 * bootstrap did: pino `child()` bindings append alongside a parent's `base`
 * fields rather than replacing them, so reusing `context.logger` (already
 * scoped with `plugin: "api-gateway"`) as Fastify's request logger would end
 * up duplicating `module`-shaped fields instead of cleanly setting `module:
 * "http"`. The child logger's `level` is carried over so HTTP logs match the
 * rest of the kernel's configured verbosity.
 */
export function onEnable(context: PluginLifecycleContext): void {
  app = buildApp(context);
}

/** Release the Fastify instance's own resources and clear the module-level reference. */
export async function onDisable(): Promise<void> {
  await app?.close();
  app = undefined;
}
