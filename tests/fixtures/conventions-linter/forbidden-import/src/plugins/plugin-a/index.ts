/**
 * Fixture plugin for `tests/plugins/plugin-builder/conventions-linter.test.ts`
 * (feature #77): the "forbidden cross-plugin import" failing case. This
 * reaches directly into a sibling plugin's `src/` internals via a relative
 * import — exactly what `docs/plugin-conventions.md` section 5 forbids
 * ("no plugin imports another plugin's internals directly — only via
 * kernel-brokered capabilities").
 */
import { secret } from "../plugin-b/internal.js";

export function useSecret(): string {
  return secret();
}
