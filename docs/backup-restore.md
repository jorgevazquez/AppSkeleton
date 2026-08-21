# Database Backup & Restore

This document describes AppSkeleton's `mysqldump`-based backup and restore
helper scripts (feature #28). It exists for the same reason
`docs/security.md` and `docs/api-versioning.md` do: so a human _or an AI
coding agent_ needing to back up or restore the database knows the
process without having to reverse-engineer it from the scripts.

For the incident-response version of this document — when to restore,
in what order, and a recovery-time checklist to work through during an
actual outage — see [`docs/disaster-recovery.md`](./disaster-recovery.md).

**Source of truth.** Nothing below is a hand-copied description — it
documents `scripts/backup.sh` and `scripts/restore.sh` (and their shared
helper, `scripts/lib/env.sh`) exactly as implemented. If either script
changes, update this document in the same change.

## 1. Prerequisites

Both scripts shell out to the MySQL client tools, so a `mysqldump` and
`mysql` binary (MySQL 8.x/9.x client, matching `docker-compose.yml`'s
`mysql:8.4` server) must be on `$PATH`. They need no Node.js dependencies
and can run outside the app (e.g. from a cron job or CI step) as long as
the database is reachable.

## 2. Configuration

Both scripts read the same `DB_*` variables the rest of the app's database
tooling uses (see `src/plugins/database-mysql/src/config.ts`,
`src/plugins/database-mysql/src/migrate.ts`):

| Variable      | Required | Default     | Meaning                                                                        |
| ------------- | -------- | ----------- | ------------------------------------------------------------------------------ |
| `DB_HOST`     | no       | `127.0.0.1` | MySQL host                                                                     |
| `DB_PORT`     | no       | `3306`      | MySQL port                                                                     |
| `DB_USER`     | **yes**  | —           | MySQL user                                                                     |
| `DB_PASSWORD` | **yes**  | —           | MySQL password                                                                 |
| `DB_NAME`     | **yes**  | —           | Database to back up / restore into                                             |
| `BACKUP_DIR`  | no       | `./backups` | Default output directory (`backup.sh` only, used when no output path is given) |

Precedence matches `dotenv`'s own default behavior (the same one
`migrate.ts`/`seed.ts` rely on via `import "dotenv/config"`): a real
environment variable, if set, always wins; the repo-root `.env` file
(see `.env.example`) only fills in values that aren't already set. A
missing required variable (`DB_USER`/`DB_PASSWORD`/`DB_NAME`) fails fast
with a single clear message — the scripts never run against a guessed or
partial config, matching the app's own `loadConfig()`/`DbConfigSchema`
contract.

## 3. Backing up

```sh
npm run backup                              # ./backups/<DB_NAME>-<UTC timestamp>.sql.gz
npm run backup -- /path/to/dump.sql.gz      # explicit output path
scripts/backup.sh                           # equivalent, called directly
```

`backup.sh` runs `mysqldump --single-transaction --routines --triggers
--events --set-gtid-purged=OFF <DB_NAME>` and gzip-compresses the output.
`--single-transaction` takes a consistent snapshot of InnoDB tables
without locking them for the duration of the dump; `--routines`/
`--triggers`/`--events` capture stored program objects, not just table
data and schema. The credential is passed via the `MYSQL_PWD` environment
variable (not `--password=...`), keeping it out of the process list and
shell history.

The parent directory of the output path is created automatically if it
doesn't exist. The default output directory, `./backups/`, is gitignored
— dumps are never meant to be committed.

## 4. Restoring

```sh
scripts/restore.sh ./backups/appskeleton-20260101T000000Z.sql.gz
scripts/restore.sh ./backups/appskeleton-20260101T000000Z.sql.gz --force
npm run restore -- ./backups/appskeleton-20260101T000000Z.sql.gz --force
```

`restore.sh` accepts either a plain `.sql` file or a gzip-compressed one
(detected by magic bytes, not file extension) and pipes it into `mysql
<DB_NAME>`. Because `mysqldump` emits `DROP TABLE IF EXISTS` /
`CREATE TABLE` for every table by default, restoring **drops and
recreates each table the backup contains**, discarding whatever that
table currently holds in `DB_NAME` — this is a destructive operation.

By default, `restore.sh` prompts for confirmation (`y`/`N`) before
proceeding. Two ways to skip the prompt for scripted/non-interactive use:

- pass `--force` on the command line, or
- set `DB_RESTORE_SKIP_CONFIRM=true` in the environment.

Running it non-interactively (no tty) without either of those set is a
hard error — the script refuses to guess.

## 5. Testing

`tests/core/backup-restore.integration.test.ts` exercises both scripts
end-to-end against the real docker-compose MySQL instance (same
`describe.runIf(mysqlReachable)` skip-when-no-Docker convention every
other `*.integration.test.ts` suite in this repo follows — see, e.g.,
`tests/plugins/database-mysql/migrator.integration.test.ts`): it seeds a
small fixture table, runs `backup.sh`, mutates the table, runs
`restore.sh --force`, and asserts the restored rows are identical
(row-for-row) to what was originally seeded.

## 6. Typical workflow

```sh
# Take a backup before a risky migration or deploy.
npm run backup

# ...something went wrong...

# Restore the most recent backup.
scripts/restore.sh "$(ls -t backups/*.sql.gz | head -1)" --force
```
