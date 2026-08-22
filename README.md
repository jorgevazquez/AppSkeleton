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

## Final verification (canonical smoke test)

The exact sequence below is this repo's own canonical, fresh-clone-through-
running-wiki verification procedure — the same one a release, a new
contributor's first setup, or `docs/disaster-recovery.md`'s "smoke-test
before resuming writes" step should run:

```bash
./init.sh          # fresh checkout: installs deps, starts MySQL via Docker, migrates
npm test            # unit + integration suite (real MySQL, real plugins — see above)
npm run smoke-test  # boots the real server and proves the wiki works end-to-end
```

`npm run smoke-test` (`scripts/smoke-test.ts`) is the one thing in this repo
that exercises the _entire_ real boot path the way an operator actually
would — `bootstrapKernel()`'s real, dynamically-discovered `src/plugins/*`
tree, not the hand-wired plugin subsets `load-test.ts`/`capability-audit.ts`
use for their own narrower purposes — over a real TCP socket, not
`app.inject()`. It:

1. Boots the server for real and fetches the wiki's own "Home" starter page
   (creating it first, over real HTTP, if this is a genuinely fresh
   database) — proving real HTTP → routing → RBAC → the wiki plugin →
   MySQL → Markdown rendering all work together end-to-end.
2. Confirms every shipped plugin — `rbac`, `database-mysql`,
   `html-renderer`, `api-gateway`, `plugin-builder`, and `wiki` — reports
   `"loaded"` (and, where a health check exists, `"healthy"`) in
   `kernel.introspectWithHealth()`, printing the same human-readable report
   `npm run introspect` does.
3. Shuts the server back down gracefully and exits non-zero, with an
   itemized list of what went wrong, if any of the above didn't hold.

Requires a reachable, migrated MySQL — the same `./init.sh` (or
`docker compose up -d mysql`) prerequisite every `*.integration.test.ts`
suite already has.

## Production Docker image

`Dockerfile` builds a minimal, production-only image: a `build` stage
compiles TypeScript (`tsc`) with full dev+prod dependencies, then a
`runtime` stage starts fresh from `node:20-alpine` with only production
dependencies and the compiled `dist/` output — no compiler, no
`devDependencies`, no source `.ts` files ship in the final image. The
process runs as the image's built-in unprivileged `node` user, never root.

Build the image:

```bash
docker build -t appskeleton .
```

Run it (needs at least `SESSION_SECRET`; everything else falls back to a
safe default or, for `database-mysql`, degrades gracefully — see
"Graceful degradation" in [`spec.md`](./spec.md) — if unset):

```bash
docker run -d --name appskeleton -p 3000:3000 \
  -e SESSION_SECRET=<a long random string> \
  -e DB_HOST=<your-mysql-host> \
  -e DB_PASSWORD=<your-mysql-password> \
  appskeleton
```

Or pass a whole `.env` file instead of individual `-e` flags:

```bash
docker run -d --name appskeleton -p 3000:3000 --env-file .env appskeleton
```

The image declares a container `HEALTHCHECK` against `GET /health`
(api-gateway's built-in, DB-free route — feature #58), polled every 30s;
`docker ps` and `docker inspect --format '{{.State.Health.Status}}'
appskeleton` reflect it directly. Verify manually:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

To run against a real MySQL instance for local testing, start
`docker compose up -d mysql` first (see [Quick start](#quick-start) above)
and point `DB_HOST` at it — from inside another container on the same
Docker network that's the `mysql` service name; from the host it's
`127.0.0.1`.

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

## Operating a deployment

See [`docs/operator-guide.md`](./docs/operator-guide.md) for environment
configuration, how to add a new plugin to a running deployment, and how
capability grants (the kernel's inter-plugin permission mechanism) are
actually managed. See [`docs/disaster-recovery.md`](./docs/disaster-recovery.md)
for the backup schedule expectations, the restore procedure, and the
recovery-time checklist to work through during an actual incident.

## Project state

- `feature_list.json` — the build backlog, source of truth for what's done.
- `claude-progress.txt` — running development log.
- `python3 dev-agent.py status` — see current progress at a glance.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch/commit conventions,
the feature workflow, lint/test requirements, and PR expectations.
