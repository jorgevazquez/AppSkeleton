# Security: Dependency Vulnerability Scanning

This document describes how AppSkeleton's CI catches known-vulnerable
dependencies, and what to do when it flags one. It exists for the same
reason `docs/api-versioning.md` and `docs/plugin-conventions.md` do: so a
human _or an AI coding agent_ handling a failed CI run knows the process
without having to reverse-engineer it from the workflow file.

**Source of truth.** The check described below is not a hand-copied
description — it is the "Dependency vulnerability scan" step in
`.github/workflows/ci.yml`, which runs `npm audit --audit-level=high`
against the exact dependency tree `npm ci` just installed from
`package-lock.json`. If that step changes, update this document in the
same change.

## 1. What the CI check does

Every push and pull request (the same `lint-typecheck-build-test` job
described by feature #103) runs:

```
npm audit --audit-level=high
```

immediately after `npm ci` and before lint/build/test. `npm audit` reads
the installed dependency tree and compares it against the public
advisory database, then exits non-zero if any advisory at severity
`high` or `critical` applies to a package actually in the tree —
`--audit-level=high` is what makes `moderate`/`low` findings advisory-only
(they print but don't fail the job) while `high`/`critical` fail the
build outright, blocking merge until addressed.

Running the audit against `npm ci`'s output (rather than, say, auditing
`package.json` in isolation) means the check reflects exactly what would
actually be installed in production, including transitive dependencies
pinned by `package-lock.json`.

## 2. Remediating a flagged vulnerability

When the "Dependency vulnerability scan" step fails a run:

1. **Read the finding.** Re-run `npm audit --audit-level=high` locally
   (or `npm audit` with no flag, to also see lower-severity advisories)
   from a checkout of the failing branch. The output names the
   vulnerable package, the affected version range, the severity, the
   advisory ID/URL, and — critically — whether it's a direct or
   transitive dependency (`npm audit`'s dependency path / `via` field).

2. **Prefer an upgrade.** Most findings are fixed by moving to a patched
   version:
   - `npm audit fix` resolves findings that are fixable within the
     existing semver ranges in `package.json` (safe, non-breaking).
   - If the fix requires a breaking major-version bump, `npm audit fix
--force` will apply it, but treat that as a manual decision, not a
     blind command to run: bump the dependency yourself in `package.json`
     (or override the transitive dependency's resolved version — npm's
     `overrides` field is preferred over patching `package-lock.json` by
     hand), re-run the full local suite (`npm run lint && npm run build
&& npm test`), and confirm nothing broke before committing.

3. **If no fixed version exists yet:**
   - Check whether the vulnerable code path is actually reachable from
     this codebase (e.g. a vulnerable feature of a transitive dependency
     that AppSkeleton never invokes). If so, this is still worth a
     one-line note in the PR description, but is not a reason to bypass
     the gate silently.
   - Look for an alternative package that provides the same
     functionality without the advisory.
   - As a last resort, and only with an explicit, reviewed justification,
     use `npm audit` config in `package.json` to acknowledge a specific
     advisory ID as accepted risk. Do not lower `--audit-level` in the CI
     workflow to work around a single finding — that would silently stop
     catching every future finding at that severity, not just this one.

4. **Verify the fix closes the finding**, not just that CI happens to
   pass: run `npm audit --audit-level=high` locally again after the
   change and confirm the specific advisory ID is gone from the output,
   then let CI re-run in full (lint, build, test all still gate the
   merge same as before this feature).

5. **Never merge past a red dependency-scan step.** If a fix genuinely
   can't land immediately, that is an explicit, tracked decision (an
   issue, a PR comment, or a note in `claude-progress.txt` for this
   codebase's agent workflow) — not something to route around by editing
   the CI step itself.

## 3. Verifying the gate actually blocks a build

Because `npm audit` depends on the live public advisory database, this
gate isn't unit-testable in the normal sense. It was instead verified
manually against a known-vulnerable fixture:

1. On a scratch branch, temporarily add a dependency with a well-known,
   long-published high/critical advisory (for example, an old
   `minimatch` or `lodash` version pinned below its patched version) to
   `package.json`, then run `npm install` to regenerate the lockfile
   entry.
2. Run `npm audit --audit-level=high` locally and confirm it exits
   non-zero and names the advisory — this is the same command the CI
   step runs, so a local failure here is exactly what would fail the
   "Dependency vulnerability scan" job step in GitHub Actions.
3. Revert the fixture change (`git checkout -- package.json
package-lock.json` or discard the scratch branch) so the vulnerable
   dependency never actually merges anywhere.

This confirms the step fails closed on a real high/critical finding,
without ever landing a genuinely vulnerable dependency in `main`.
