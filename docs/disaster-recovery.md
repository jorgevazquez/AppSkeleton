# Disaster Recovery Runbook

This is the runbook for recovering AppSkeleton's MySQL data after loss or
corruption — a full instance failure, a bad migration, an operator mistake,
or a compromised deployment that needs to be rolled back to a known-good
state. It builds directly on feature #28's backup/restore helper scripts;
see [`docs/backup-restore.md`](./backup-restore.md) first for what
`scripts/backup.sh` / `scripts/restore.sh` do and how they're configured —
this document does not repeat that reference material, it tells you when
and how to use it under pressure.

**Source of truth.** Section 4 below ("Verified dry run") is not a
hypothetical description — it's a transcript of an actual backup + restore
performed against a real docker-compose MySQL instance while writing this
document, kept here so the next person doesn't have to take the scripts on
faith. If `scripts/backup.sh`, `scripts/restore.sh`, or their behavior
changes, re-run the dry run in Section 6 and update Section 4.

## 1. Backup schedule expectations

AppSkeleton does not ship an automated backup scheduler — `scripts/backup.sh`
is a helper an operator or an external scheduler (cron, a CI scheduled job,
a managed database's own snapshot feature) invokes. This runbook documents
the _expectation_ a real deployment should meet, not a mechanism the app
enforces:

- **Frequency.** At minimum, a nightly full `mysqldump` (`npm run backup` /
  `scripts/backup.sh`) written to storage that is **not** the same disk/host
  as the MySQL instance (e.g. object storage, a separate backup host). If
  the deployment's write volume or RPO tolerance is tighter than 24h,
  increase frequency (hourly) or pair `mysqldump` snapshots with MySQL
  binary-log archiving (binlogs are out of scope for `scripts/backup.sh`,
  which only takes point-in-time logical dumps).
- **Retention.** Keep enough dated dumps to cover the deployment's
  compliance/business retention window (e.g. 7 daily + 4 weekly + 12
  monthly is a common baseline). `scripts/backup.sh` names output files
  `<DB_NAME>-<UTC timestamp>.sql.gz`, so pruning is a simple find-by-mtime
  or find-by-name-pattern job — no built-in retention/pruning exists yet
  and none should be assumed.
- **Verification.** A backup that has never been restored is not a verified
  backup. Section 6 of this document is the periodic drill an operator
  should re-run on a real schedule (e.g. monthly) against the _current_
  scripts and the _current_ schema — not just once when this doc was
  written.
- **Off-site copy.** `BACKUP_DIR` (default `./backups/`, gitignored) is
  local disk next to the app by default. Treat that as a staging location,
  not the backup — a real deployment must ship the resulting `.sql.gz`
  file off the host (object storage, another region/host) or a host-level
  disaster still takes the backup with it.

## 2. Restore procedure

This is `scripts/restore.sh` from [`docs/backup-restore.md`](./backup-restore.md#4-restoring),
sequenced as an incident procedure rather than a reference. Read
`docs/backup-restore.md` §2 first for the required `DB_*` env vars.

1. **Stop writes.** Take the application out of service (stop the API
   gateway process / scale the deployment to 0 / put it in maintenance
   mode) before restoring into a database anything is actively writing to.
   `restore.sh` does not coordinate with the running app — a concurrent
   writer can race a table that was just dropped-and-recreated by the
   restore.
2. **Locate the backup.** Confirm which dump you're restoring
   (`ls -t backups/*.sql.gz | head -1` for "most recent", or a specific
   dated file if you're recovering to a point before a known bad event —
   e.g. a bad migration or an accidental mass delete).
3. **Confirm the target.** Double-check `DB_HOST`/`DB_PORT`/`DB_NAME` in the
   environment `restore.sh` will run under. This is the single most
   dangerous mistake to make during an incident: restoring into the wrong
   database. `restore.sh` prints the target ("Restoring database 'X' at
   host:port from file") before touching anything — read it.
4. **Run the restore.**
   ```sh
   scripts/restore.sh <backup-file>          # interactive: prompts y/N
   scripts/restore.sh <backup-file> --force  # non-interactive/incident use
   ```
   Every table present in the dump is dropped and recreated — this is
   `mysqldump`'s own default (`DROP TABLE IF EXISTS` / `CREATE TABLE` per
   table), not something `restore.sh` adds. Tables that exist in the
   _target_ database but are **not** in the backup are left untouched, so
   a restore from an older dump can leave newer tables (created by
   migrations applied after that dump was taken) stranded alongside the
   restored ones — see Section 5, "run migrations forward after restoring
   from an older dump", before declaring recovery complete.
5. **Re-run migrations forward.** If the dump predates the current schema
   (see the migration gap noted in
   [`docs/operator-guide.md`](./operator-guide.md)), run `npm run migrate`
   after the restore so `schema_migrations` and the schema itself are
   caught back up to what the current app code expects.
6. **Smoke-test before resuming writes.** Bring the app back up pointed at
   the restored database, verify a read and a write path both work (e.g.
   the health check plus one real request through the app, not just a
   direct SQL query), _then_ resume normal traffic.
7. **Record the incident.** What was lost, which backup was restored, how
   much data (if any) between the backup's timestamp and the incident is
   permanently gone. That gap is real — `mysqldump` backups are only as
   fresh as the last backup run (Section 1); this is the deployment's
   actual RPO, not a theoretical one.

## 3. Recovery-time checklist

Work through this in order during an actual incident. Each box is something
to _do_, not just know:

- [ ] Application traffic stopped / deployment scaled down (Section 2 step 1).
- [ ] Incident cause identified well enough to know _which_ backup to
      restore (most recent vs. a specific pre-incident dated dump).
- [ ] Backup file located and its integrity spot-checked (`gunzip -t
    <file>.sql.gz`, or `head -c2 <file> | od -An -tx1` to confirm it's a
      real gzip member before trusting it — `restore.sh` will fail loudly
      on a corrupt file, but check before the incident is the wrong time
      to discover a bad backup).
- [ ] `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` for the
      _target_ environment confirmed correct (Section 2 step 3).
- [ ] Restore executed (`scripts/restore.sh <file> --force`), exit code
      checked (`set -euo pipefail` inside the script means a MySQL error
      aborts it non-zero — a silent partial restore is not possible from
      this script, but the caller must still check the exit code if
      scripting around it).
- [ ] `npm run migrate` re-run if the dump could predate the current schema.
- [ ] Row counts / a few known rows spot-checked against expectations
      (Section 4 shows the exact comparison used in the verified dry run).
- [ ] Application smoke-tested against the restored database.
- [ ] Traffic resumed.
- [ ] Incident recorded: backup timestamp used, data-loss window, root
      cause, and whether this runbook needs updating as a result.

There is no fixed numeric RTO/RPO target enforced by the app — those are a
deployment-specific SLA decision. What this runbook guarantees is that the
_mechanical_ part (backup → restore → verify) is fast and repeatable: the
dry run in Section 4 completed backup+restore of the (admittedly small)
current dataset in about a second end to end. Real recovery time is
dominated by `mysqldump`'s/`mysql`'s data-volume-proportional runtime, plus
however long steps 1–3 and 6–8 above take a human to execute — this
runbook's job is to make those human steps fast by not requiring anyone to
improvise them mid-incident.

## 4. Verified dry run (transcript)

Performed against a real `docker-compose.yml` MySQL 8.4 instance
(`appskeleton`/`change-me` credentials, matching `.env.example`), restoring
into a separate **scratch database** (`appskeleton_dr_scratch`) rather than
overwriting the real one — this is the safe way to rehearse a restore
without any risk to real data, and is the pattern this section documents
for future drills.

**Setup — grant the app user access to a scratch database.** The
`appskeleton` MySQL user only has privileges on the `appskeleton` database
by default (`GRANT ALL PRIVILEGES ON appskeleton.* TO 'appskeleton'@'%'`),
so a scratch database needs an explicit grant first (one-time, as
`root`/`change-me-root` from `docker-compose.yml`):

```sh
MYSQL_PWD=change-me-root mysql -h127.0.0.1 -P3306 -uroot -e "
  CREATE DATABASE IF NOT EXISTS appskeleton_dr_scratch;
  GRANT ALL PRIVILEGES ON appskeleton_dr_scratch.* TO 'appskeleton'@'%';
  FLUSH PRIVILEGES;
"
```

**Seed a small fixture dataset** in the real `appskeleton` database (same
shape `tests/core/backup-restore.integration.test.ts` uses), so the restore
has something concrete to reproduce:

```sh
mysql -h127.0.0.1 -P3306 -uappskeleton -pchange-me appskeleton -e "
  CREATE TABLE dr_dry_run_widgets (id INT PRIMARY KEY, name VARCHAR(255) NOT NULL);
  INSERT INTO dr_dry_run_widgets (id, name) VALUES (1,'Widget A'),(2,'Widget B'),(3,'Widget C');
"
```

**Back up the real database:**

```sh
$ DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=appskeleton DB_PASSWORD=change-me \
  DB_NAME=appskeleton scripts/backup.sh /tmp/dr-dry-run/appskeleton-dryrun.sql.gz

-> Backing up database 'appskeleton' from 127.0.0.1:3306 to /tmp/dr-dry-run/appskeleton-dryrun.sql.gz
mysqldump: Error: 'SELECT command denied to user 'appskeleton'@'...' for table 'column_masking_policy'' when trying to dump masking policies
mysqldump: Error: 'Access denied; you need (at least one of) the PROCESS privilege(s) for this operation' when trying to dump tablespaces
-> Backup complete: /tmp/dr-dry-run/appskeleton-dryrun.sql.gz (4.0K)
```

**What actually worked / what to expect:** the two `mysqldump: Error:`
lines above are expected noise on MySQL 8.4 with a non-`root` account —
`mysqldump` unconditionally _tries_ to dump `information_schema`'s
masking-policy and tablespace metadata regardless of `--databases`/default
target-DB scope, and the `appskeleton` user (correctly, per least
privilege) has neither `SELECT` on those system views nor the global
`PROCESS` privilege. `mysqldump` treats both as non-fatal and continues;
the script's own exit code was still `0` and the dump was complete and
valid (confirmed below). **Do not treat these two specific lines as a
failed backup** — but do treat _any other_ `mysqldump: Error:` line as one,
and do verify `backup.sh`'s own exit code (`$?`) in any automated caller,
since the shell noise alone doesn't distinguish "harmless permission
warning" from "the dump is missing tables."

**Restore into the scratch database:**

```sh
$ DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=appskeleton DB_PASSWORD=change-me \
  DB_NAME=appskeleton_dr_scratch DB_RESTORE_SKIP_CONFIRM=true \
  scripts/restore.sh /tmp/dr-dry-run/appskeleton-dryrun.sql.gz --force

-> Restoring database 'appskeleton_dr_scratch' at 127.0.0.1:3306 from /tmp/dr-dry-run/appskeleton-dryrun.sql.gz
-> Restore complete.
```

**Verification — row-for-row equality**, the same standard feature #28's
own integration test holds itself to:

```sh
$ mysql -h127.0.0.1 -P3306 -uappskeleton -pchange-me appskeleton \
    -N -e "SELECT * FROM dr_dry_run_widgets ORDER BY id;" | md5
cecf8ebf1ad563294e98dc5fab3fc2b8

$ mysql -h127.0.0.1 -P3306 -uappskeleton -pchange-me appskeleton_dr_scratch \
    -N -e "SELECT * FROM dr_dry_run_widgets ORDER BY id;" | md5
cecf8ebf1ad563294e98dc5fab3fc2b8
```

Identical checksums. `SHOW TABLES` on the scratch database also confirmed
every table from the source database was present
(`database_mysql_audit_log`, `dr_dry_run_widgets`, `schema_migrations`,
`schema_seeds`), and `schema_migrations`' single applied-migration row
round-tripped with its `checksum`/`applied_at` values intact.

**Timing.** A second, timed run (small dataset — a few rows, KB-scale dump)
completed backup in ~1s and restore in <1s; real timing on a production
dataset will scale with data volume and is not represented by this number
— re-time against a realistic data size before using this as an RTO input.

**Cleanup after the drill:** the fixture table and scratch database used
above were dropped immediately after this verification (`DROP TABLE
dr_dry_run_widgets` in `appskeleton`; `DROP DATABASE
appskeleton_dr_scratch`) — a dry run must not leave scratch artifacts
lying around a shared database instance.

## 5. Known gaps (read before relying on this runbook)

- **No binlog/point-in-time recovery.** `scripts/backup.sh` takes a logical
  snapshot (`mysqldump --single-transaction`) at a point in time; anything
  written after the most recent backup is unrecoverable through these
  scripts. If the deployment's RPO tolerance is tighter than the backup
  interval, this runbook's mechanism is insufficient on its own — pair it
  with MySQL binary-log archiving (out of scope here).
- **No automated scheduling, off-site shipping, or retention/pruning.**
  Section 1's expectations are not enforced by any code in this repo; an
  operator or external system must implement them.
- **Migrations aren't restored by `restore.sh`.** A restore from a dump
  older than the current schema needs an explicit `npm run migrate`
  afterward (Section 2 step 5) — `restore.sh` only loads what's in the
  dump file.
- **`scripts/backup.sh`/`restore.sh` cover the `database-mysql`-managed
  schema only.** Non-database state this deployment might depend on (e.g.
  `WIKI_ATTACHMENTS_DIR`'s on-disk attachment blobs, per
  `docs/operator-guide.md`) is not captured by a `mysqldump` and needs its
  own backup/restore procedure if the deployment uses it — out of scope
  for this document, called out here so it isn't assumed to be covered.

## 6. Re-running this drill

To re-verify this runbook after `scripts/backup.sh`/`restore.sh` change
(or periodically, per Section 1's "verification" expectation), repeat
Section 4 exactly — grant a scratch database, seed a small fixture table,
back up the real database, restore into the scratch database, diff the
result, then clean up both the fixture table and the scratch database. If
any step's actual output no longer matches what's transcribed here, update
Section 4 in the same change that changes the scripts' behavior.
