/**
 * Fixture plugin for `tests/plugins/plugin-builder/conventions-linter.test.ts`
 * (feature #81): the "capability cross-check" failing case. `plugin.json`
 * declares `capabilities.requires: ["ghost:capability"]`, but no plugin in
 * this fixture's sibling `other-plugin` — or anywhere else under this
 * fixture's `src/plugins` — declares `ghost:capability` in its own
 * `capabilities.provides`. That combination is exactly what feature #81's
 * cross-check warns about: this plugin can obtain() every capability it
 * declares (check 2 is satisfied — see the local const binding below), but
 * one of those declared capabilities has no live provider anywhere in the
 * plugin set being linted, so `capabilities.obtain("ghost:capability")`
 * could never actually succeed against it.
 */
interface Capabilities {
  obtain<T>(capabilityId: string): T;
}

const GHOST_CAPABILITY_ID = "ghost:capability";

export function useGhostCapability(capabilities: Capabilities): unknown {
  return capabilities.obtain<unknown>(GHOST_CAPABILITY_ID);
}
