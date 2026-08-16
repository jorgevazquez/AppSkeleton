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

## Project state

- `feature_list.json` — the build backlog, source of truth for what's done.
- `claude-progress.txt` — running development log.
- `python3 dev-agent.py status` — see current progress at a glance.
