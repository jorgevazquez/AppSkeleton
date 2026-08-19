/**
 * Fixture plugin for `tests/plugins/plugin-builder/conventions-linter.test.ts`
 * (feature #77): the "undeclared capability use" failing case. This module
 * obtains `some:capability` from the broker (via a local `const` binding,
 * exactly like the real `api-gateway` plugin's own `.obtain()` call sites),
 * but `plugin.json`'s `capabilities.requires` is empty — the broker itself
 * would refuse this exact call at runtime with `reason: "not_declared"`
 * (see `core/broker.ts`), but only once this code path actually executes;
 * this linter catches the same defect statically, before that ever happens.
 */
interface Capabilities {
  obtain<T>(capabilityId: string): T;
}

const SOME_CAPABILITY_ID = "some:capability";

export function useSomeCapability(capabilities: Capabilities): unknown {
  return capabilities.obtain<unknown>(SOME_CAPABILITY_ID);
}
