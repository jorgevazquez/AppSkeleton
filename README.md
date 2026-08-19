# AppSkeleton

A plugin-based, security-first web application platform. Everything the
application does is encapsulated in a plugin — see [`spec.md`](./spec.md)
for the full architecture and [`AGENTS.md`](./AGENTS.md) for how this
project is built (it's driven by the `infinite-dev` autonomous workflow).

Ships with: `rbac`, `database-mysql`, `html-renderer`, `api-gateway`,
`plugin-builder` (lets AI agents scaffold new plugins), and a `wiki` app
plugin proving the platform end-to-end.

## Quick start

```bash
cp .env.example .env        # then edit secrets
./init.sh                   # installs deps, starts MySQL via Docker, migrates
npm run dev                 # start the dev server
npm test                    # run the test suite
```

## Code style

Linting and formatting run automatically on staged files before every
commit via [husky](https://typicode.github.io/husky/) +
[lint-staged](https://github.com/lint-staged/lint-staged) — no extra setup
needed beyond the one-time `npm install`, which installs the git hook via
the `prepare` script. Staged `.ts` files are auto-fixed with
`eslint --fix` and formatted with `prettier --write`; other staged files
(`.js`, `.json`, `.md`, `.yml`/`.yaml`) are formatted with `prettier --write`.
Fixes are re-staged automatically, so a commit with fixable lint/format
issues just succeeds with the corrected code. Commits are blocked only if
eslint reports errors it can't auto-fix.

You can also run these manually:

```bash
npm run lint          # eslint check
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
npm run format:check  # prettier --check
```

## Project state

- `feature_list.json` — the build backlog, source of truth for what's done.
- `claude-progress.txt` — running development log.
- `python3 dev-agent.py status` — see current progress at a glance.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch/commit conventions,
the feature workflow, lint/test requirements, and PR expectations.
