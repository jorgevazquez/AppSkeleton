/**
 * Fixture plugin for `tests/plugins/plugin-builder/conventions-linter.test.ts`
 * (feature #81): sits alongside `needs-ghost-capability` in this fixture's
 * `src/plugins`, providing `other:thing` — a real, declared, implemented
 * capability — so the cross-check test proves the linter actually scans
 * every sibling plugin for a match rather than trivially failing because a
 * fixture directory only ever contains one plugin. `other:thing` is
 * unrelated to `ghost:capability`, so it must not satisfy
 * `needs-ghost-capability`'s requirement.
 */
export const provides: Readonly<Record<string, unknown>> = {
  "other:thing": { value: 42 },
};
