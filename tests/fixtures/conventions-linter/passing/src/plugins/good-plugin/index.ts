/**
 * Fixture plugin for `tests/plugins/plugin-builder/conventions-linter.test.ts`
 * (feature #77): the "everything is fine" case. It imports only from its
 * own `src/` subtree, obtains exactly the capability its manifest declares
 * under `capabilities.requires` (via a local `const` binding, mirroring the
 * real `api-gateway`/`rbac` plugins' own convention), and exports exactly
 * the capability its manifest declares under `capabilities.provides`.
 *
 * A doc-comment mention of a path that would otherwise look like a
 * forbidden cross-plugin import — `../other-plugin/index.ts` — is included
 * deliberately, to exercise the linter's comment-stripping: this sentence
 * must never register as a real import.
 */
import { helper } from "./src/helper.js";

interface Capabilities {
  obtain<T>(capabilityId: string): T;
}

const OTHER_THING_CAPABILITY_ID = "other:thing";

export function useOtherThing(capabilities: Capabilities): unknown {
  return capabilities.obtain<unknown>(OTHER_THING_CAPABILITY_ID);
}

export const provides: Readonly<Record<string, unknown>> = {
  "good:thing": { helper },
};
