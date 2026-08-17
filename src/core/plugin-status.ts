/**
 * Tracks which plugins are administratively *disabled* at runtime,
 * independent of loader.ts's `PluginLoadResult` (which only ever records
 * `loaded`/`failed` — the outcome of one load *attempt*, not an ongoing
 * operator decision).
 *
 * This module's own scope is deliberately just the tracking primitive:
 * {@link PluginStatusTracker.disable}/{@link PluginStatusTracker.enable}
 * here only flip a marker bit. A future feature (#16, "Runtime plugin
 * enable/disable without a full process restart") owns running the
 * plugin's `onDisable`/`onEnable` lifecycle hooks and rejecting a disable
 * that other plugins still depend on — it calls into this tracker only
 * once that work has already succeeded. introspect.ts (feature #13) is
 * this tracker's first consumer: it folds `isDisabled(id)` into a loaded
 * plugin's reported `status`, so `kernel.introspect()` already has a real
 * seam to report `"disabled"` today, in the shape #16 will populate later.
 *
 * A factory, not a singleton — matching broker.ts/audit.ts's "no ambient
 * authority" convention: each caller (kernel bootstrap in production,
 * individual tests in isolation) gets its own private, independent tracker.
 */

export interface PluginStatusTracker {
  /** Mark `pluginId` as administratively disabled. Idempotent. */
  disable(pluginId: string): void;
  /** Clear `pluginId`'s disabled marker, if any. Idempotent. */
  enable(pluginId: string): void;
  /** Is `pluginId` currently marked disabled? */
  isDisabled(pluginId: string): boolean;
  /** A snapshot of every currently-disabled plugin id. */
  disabledIds(): ReadonlySet<string>;
}

/** Create a fresh, isolated plugin status tracker with nothing disabled. */
export function createPluginStatusTracker(): PluginStatusTracker {
  const disabled = new Set<string>();

  return Object.freeze({
    disable(pluginId: string): void {
      disabled.add(pluginId);
    },
    enable(pluginId: string): void {
      disabled.delete(pluginId);
    },
    isDisabled(pluginId: string): boolean {
      return disabled.has(pluginId);
    },
    disabledIds(): ReadonlySet<string> {
      return new Set(disabled);
    },
  });
}
