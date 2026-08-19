# Security: CI Scanning Gates

This document describes the automated security gates in AppSkeleton's CI
pipeline, and what to do when one of them flags something. It exists for
the same reason `docs/api-versioning.md` and `docs/plugin-conventions.md`
do: so a human _or an AI coding agent_ handling a failed CI run knows the
process without having to reverse-engineer it from the workflow file.

Two independent gates are covered here:

- [Dependency vulnerability scanning](#1-dependency-vulnerability-scanning-npm-audit)
  (`npm audit`, feature #104) — catches known-vulnerable packages.
- [Secrets-in-code scanning](#2-secrets-in-code-scanning-gitleaks) (gitleaks,
  feature #106) — catches committed API keys, tokens, and other secrets.

**Source of truth.** Neither section below is a hand-copied description —
each is the corresponding named step in `.github/workflows/ci.yml`. If
either step changes, update this document in the same change.

## 1. Dependency vulnerability scanning (`npm audit`)

### 1.1 What the CI check does

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

### 1.2 Remediating a flagged vulnerability

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

### 1.3 Verifying the gate actually blocks a build

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

## 2. Secrets-in-code scanning (gitleaks)

### 2.1 What the CI check does

The "Secrets scan (gitleaks)" step runs right after the dependency
vulnerability scan, before lint/build/test:

```
gitleaks detect --source . --redact --no-banner -v
```

`gitleaks` is installed as a pinned static binary downloaded directly
from its GitHub releases (rather than via a Marketplace Action), so the
check has no dependency on a third-party action's licensing terms and
its version is explicit and reproducible in the workflow file.

The checkout step uses `fetch-depth: 0` so the full commit history is
present in the runner's working copy — `gitleaks detect` walks every
commit reachable from `HEAD`, not just the current snapshot, using its
built-in ruleset of regex/entropy detectors for API keys, access tokens,
private keys, and similar credential formats. That means a secret that
was committed and later deleted in a subsequent commit still fails this
step, exactly as if it were still present in the working tree today —
"scanning the diff/history," not just the latest file contents. `--redact`
keeps the actual secret value out of the CI log (only the rule ID, file,
and commit are shown); `gitleaks detect` exits non-zero the moment any
finding exists, which fails the job and blocks merge.

### 2.2 Remediating a flagged secret

When the "Secrets scan (gitleaks)" step fails a run:

1. **Read the finding.** The output names the rule that matched
   (`RuleID`), the file and line, and the commit that introduced it —
   re-run `gitleaks detect --source . --redact -v` locally against the
   failing branch to see the same output.

2. **Treat the secret as compromised.** If it's a real credential (not a
   test fixture), rotate/revoke it at the provider immediately — removing
   it from the branch does not undo the fact that it was pushed to a
   remote and is present in git history.

3. **Remove it from history, not just the working tree.** Deleting the
   line in a new commit is not sufficient — the secret is still readable
   in the earlier commit and this gate scans full history, so it will
   keep failing. Rewrite history on the offending branch (e.g.
   `git rebase -i` to edit/drop the introducing commit, or `git filter-repo`
   for anything already shared) before the branch merges. This is much
   cheaper before merge than after — never merge a branch containing a
   real secret and plan to "clean it up later."

4. **False positives:** if gitleaks flags something that is not actually
   a secret (a high-entropy test fixture, a hash, a placeholder), add a
   scoped allowlist entry in a `.gitleaks.toml` at the repo root (path or
   regex-scoped) with a comment explaining why — do not delete or weaken
   the CI step itself to silence it.

5. **Never merge past a red secrets-scan step.** Same rule as the
   dependency scan: if remediation can't land immediately, that's an
   explicit, tracked decision, not something to route around by editing
   the CI step.

### 2.3 Verifying the gate actually blocks a build

Verified manually against a deliberately committed fake secret, mirroring
how the dependency-scan gate above was verified:

1. On a scratch branch (based on the same commit as this feature, no
   other changes), add a fake credential with a realistic format — e.g.
   `GITHUB_TOKEN=ghp_<36 random alphanumeric characters>` — to a scratch
   file, and commit it. (A well-known documentation placeholder such as
   AWS's `AKIAIOSFODNN7EXAMPLE` does _not_ work for this: gitleaks' default
   ruleset allowlists that specific example value, so a genuinely random
   fake token is needed to exercise the detector honestly.)
2. Run `gitleaks detect --source . --redact --no-banner -v` locally and
   confirm it exits non-zero, reporting the finding (rule `github-pat`)
   with the file, line, and commit — this is the same command the CI step
   runs, so a local failure here is exactly what would fail the "Secrets
   scan (gitleaks)" job step in GitHub Actions.
3. Delete the scratch branch entirely (`git branch -D`) so the fake
   secret's commit never merges anywhere and the target branch's history
   stays clean — confirmed afterwards with another `gitleaks detect` run
   showing "no leaks found."

This confirms the step fails closed on a real finding, without ever
landing a secret — even a fake one — in `main`.
