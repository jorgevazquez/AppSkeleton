# Contributing to AppSkeleton

AppSkeleton is built feature-by-feature by the `infinite-dev` autonomous
workflow described in [`AGENTS.md`](./AGENTS.md). This document covers the
conventions that workflow (and any human contributor) follows: branches and
commits, how a feature moves from backlog to done, lint/test requirements,
and what a PR is expected to contain. It exists for the same reason
`docs/plugin-conventions.md` and `docs/security.md` do — so a human _or an
AI coding agent_ can follow the process without reverse-engineering it from
`dev-agent.py`'s source.

## Before you start

1. Run `./init.sh` — installs dependencies, brings up MySQL via Docker, and
   runs migrations. See the [Quick start](./README.md#quick-start) section
   of the README.
2. Read [`spec.md`](./spec.md) for the architecture and
   [`docs/plugin-conventions.md`](./docs/plugin-conventions.md) if your
   change touches a plugin.
3. Check current progress:

   ```bash
   python3 dev-agent.py status
   python3 dev-agent.py next
   ```

`feature_list.json` is the backlog and source of truth for what's done;
`claude-progress.txt` is the running development log. Never delete, edit
the description/steps of, or otherwise remove an entry from
`feature_list.json` — only its `passes` flag changes, and only via
`dev-agent.py complete` / `dev-agent.py skip`.

## Branch conventions

Each feature is implemented on its own branch named `feature-<id>`, cut
from an up-to-date `main` (or, for parallel batches, rebased onto `main`'s
tip before merging — see `dev-agent.py`'s `merge_feature_branch`). When
using worktree-based isolation, the branch lives at
`.worktrees/feature-<id>` and is deleted along with its worktree once
merged.

If you're contributing by hand rather than through the automated loop, use
the same pattern (`feature-<short-description>` is fine for non-tracked
work) so history stays consistent.

## Commit conventions

Commit subjects follow a `<type>: <description>` shape, optionally suffixed
with the passing-feature count. This repo's own history is the reference:

```
feat: Contribution guide and coding standards [82/120 passing]
docs: log feature #115 progress notes
merge: feature #115 from parallel run
```

- `feat: <description> [<passing>/<total> passing]` — a feature from
  `feature_list.json` is implemented and its tests pass. The count comes
  from `dev-agent.py status` immediately before committing.
- `docs: log feature #<id> progress notes` — the `dev-agent.py log` entry
  appended to `claude-progress.txt` for that feature, committed separately
  from the `feat:` commit that implements it.
- `merge: feature #<id> from parallel run` — the merge commit
  `dev-agent.py`'s parallel runner produces when folding a completed
  feature branch back into `main`. Not something you write by hand; a
  `git merge --no-ff` with this message is what `run --parallel` does.
- `fix:`, `refactor:`, `chore:`, `test:` — use these for work outside the
  feature loop (bug fixes, cleanup, tooling) with a plain, descriptive
  summary; they don't get a passing-count suffix since they aren't tied to
  a `feature_list.json` entry.

Keep commits scoped to one logical change. Don't bundle an unrelated fix
into a feature commit — open a separate `fix:` commit instead.

## The infinite-dev feature workflow

Every feature-implementing session — human or agent — follows the same
loop; see [`AGENTS.md`](./AGENTS.md) for the full two-mode (Interactive /
Autopilot) description. In short, per feature:

1. **Orient**: `python3 dev-agent.py next` to see the next feature's id,
   description, and steps.
2. **Implement**: satisfy every step listed for that feature, following
   existing patterns (in particular `docs/plugin-conventions.md` for
   anything under `src/plugins/`).
3. **Test**: write/extend unit tests, run the browser for UI-facing
   changes, and run lint + build (see below). Fix all failures — never
   mark a feature passing with a known-failing check.
4. **Record & commit**, in this exact order:

   ```bash
   python3 dev-agent.py complete <feature_id>
   git add -A && git commit -m "feat: <description> [<passing>/<total> passing]"
   python3 dev-agent.py log --feature-id <id> \
     --done "- list of specific changes made" \
     --testing "- how it was tested, what was verified" \
     --notes "- decisions, gotchas, or tips for future agents"
   ```

5. If blocked after 2-3 attempts, skip instead of leaving a half-finished
   change: `python3 dev-agent.py skip <id> "reason"`, then
   `git checkout -- . && git clean -fd` to leave a clean tree.

A feature is only marked `passes: true` once **every** step in its
`feature_list.json` entry is verified — partial credit isn't a thing.

## Lint and test requirements

These must all be clean before a feature (or any change) is considered
done — they are exactly what CI (`.github/workflows/ci.yml`) enforces on
every push and PR:

```bash
npm run lint          # eslint check
npm run build          # tsc -p tsconfig.json (typecheck)
npm test               # vitest run
npm run format:check   # prettier --check .
```

A few notes:

- `husky` + `lint-staged` auto-fix and re-stage staged `.ts`/`.js`/`.json`/
  `.md`/`.yml` files on commit (see the README's [Code
  style](./README.md#code-style) section) — a commit only fails if eslint
  reports an error it can't auto-fix.
- CI also runs `npm audit --audit-level=high` and a `gitleaks` secrets scan
  across full git history (see [`docs/security.md`](./docs/security.md)).
  Don't introduce a high/critical-severity dependency or commit a secret;
  both fail the build.
- Docker-gated integration tests self-skip locally without
  `docker compose up -d mysql`, but run for real in CI against a MySQL
  service container — don't rely on a green local run alone if your change
  touches `database-mysql` or another Docker-dependent plugin.

## PR expectations

Whether opened by the automated loop or by hand, a PR should:

- Correspond to one feature (or one clearly-scoped fix/refactor) — not a
  grab-bag of unrelated changes.
- Have a clean `git status` before merge: no stray untracked files, no
  uncommitted lint/format fixes.
- Show lint, build, and test all green (paste the local results or point
  at the CI run — CI itself is the authoritative gate before merge).
- Include the `feat:` commit and its paired `docs: log feature #<id>` commit
  (the progress-notes entry), so the merged history explains both _what_
  changed and _why_/_how it was verified_, matching every prior entry in
  `claude-progress.txt`.
- Not modify `feature_list.json` descriptions or steps — only the
  `passes` flag, via `dev-agent.py complete`/`skip`.
- Reference the feature id in the title or description (e.g. "feat #115:
  Contribution guide and coding standards") so it's traceable back to
  `feature_list.json`.
