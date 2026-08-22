/**
 * plugin-builder plugin lifecycle module.
 *
 * `plugin.json` has declared `entry_point: "index.ts"` since this plugin
 * was first scaffolded (feature #75's own `create-plugin` generator run),
 * but — per this plugin's own README ("Deliberately empty at scaffold
 * time") — no root lifecycle module was ever actually added to back it, so
 * every real kernel boot has silently reported `plugin-builder` as
 * `"failed"` (`Cannot find module ".../plugin-builder/index.ts"`) the
 * entire time. Nothing surfaced this until feature #120's smoke suite
 * actually asserted every shipped plugin loads successfully through the
 * real, dynamically-discovered `bootstrapKernel()` path — every prior
 * feature that exercises `plugin-builder` (the `create-plugin`/
 * `bump-version`/`generate:*` CLIs, `conventions-linter.ts`, ...) does so
 * by importing its `src/*.ts` modules directly as plain TypeScript
 * utilities, never by loading it as a kernel plugin.
 *
 * This plugin genuinely has no runtime capabilities to provide or
 * lifecycle state to manage — its entire value (manifest JSON Schema
 * generation, the `create-plugin` scaffolder, the static conventions
 * linter, capability-index/version-bump tooling) is exposed as standalone
 * CLI scripts (see package.json's `create-plugin`/`generate:manifest-
 * schema`/`generate:capability-index` scripts), run directly via `tsx`,
 * never through a capability another plugin obtains at runtime. So — like
 * `hello-world`'s own generated stub — this module exists purely to give
 * the kernel a real, loadable entry point matching the manifest's already-
 * empty `capabilities.provides`/`requires`: every hook just logs, and
 * `provides` stays empty, exactly like the manifest already declares.
 */
import type { PluginLifecycleContext } from "../../core/loader.js";

/**
 * Runs first, synchronously (or returning a Promise the loader awaits).
 * Use for fail-fast setup — reading/validating config, wiring
 * `context.auditSink` into local state — that should abort the load
 * loudly if misconfigured. See docs/ai-plugin-authoring.md §4.
 */
export function onInstall(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "plugin-builder installed");
}

/**
 * Runs second, after `onInstall`. Use for anything asynchronous: opening
 * a connection, running this plugin's own migrations, obtaining a
 * capability it requires at startup.
 */
export function onEnable(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "plugin-builder enabled");
}

/**
 * Runs on teardown (`kernel.disablePlugin(...)` or process shutdown),
 * before `onUninstall`. Release exactly what `onEnable` acquired.
 */
export function onDisable(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "plugin-builder disabled");
}

/** Runs last, after `onDisable`. */
export function onUninstall(context: PluginLifecycleContext): void {
  context.logger.info({ plugin: context.manifest.id }, "plugin-builder uninstalled");
}

/**
 * Capability implementations this plugin provides — empty, matching
 * `plugin.json`'s own `capabilities.provides: []` (see this module's own
 * doc comment for why: every real capability this plugin's tooling exposes
 * is a standalone CLI script, not a kernel-brokered runtime capability).
 */
export const provides: Readonly<Record<string, unknown>> = {};
