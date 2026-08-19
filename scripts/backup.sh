#!/usr/bin/env bash
#
# mysqldump-based backup helper (feature #28 — "Backup and restore helper
# scripts"). Dumps the configured database to a gzip-compressed SQL file.
#
# Config is layered the same way the rest of this repo's DB tooling is
# (see src/plugins/database-mysql/src/config.ts, migrate.ts, seed.ts):
# real environment variables win, `.env` (repo root) fills in anything
# still unset, and DB_HOST/DB_PORT default to docker-compose.yml's local
# MySQL (127.0.0.1:3306) when neither supplies a value. DB_USER,
# DB_PASSWORD, and DB_NAME have no default — same "fail fast on a missing
# credential" rule loadConfig()/DbConfigSchema enforce for the app itself.
#
# Usage:
#   scripts/backup.sh [output-file]
#
#   scripts/backup.sh                       # writes ./backups/<DB_NAME>-<timestamp>.sql.gz
#   scripts/backup.sh /path/to/dump.sql.gz  # writes to an explicit path
#
# See docs/backup-restore.md for full usage, env var reference, and the
# matching restore.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

load_dotenv "$REPO_ROOT/.env"
require_db_env

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"

OUTPUT_FILE="${1:-}"
if [ -z "$OUTPUT_FILE" ]; then
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUTPUT_FILE="$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"
else
  mkdir -p "$(dirname "$OUTPUT_FILE")"
fi

echo "-> Backing up database '$DB_NAME' from $DB_HOST:$DB_PORT to $OUTPUT_FILE"

# --single-transaction takes a consistent snapshot of InnoDB tables without
# locking them for the duration of the dump. --routines/--triggers/--events
# capture stored program objects, not just table data/schema.
# --set-gtid-purged=OFF avoids emitting GTID state that only makes sense on
# a server with GTIDs enabled, keeping the dump portable across MySQL
# instances. MYSQL_PWD (rather than --password=...) keeps the credential
# out of the process list (`ps`) and shell history.
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  "$DB_NAME" | gzip > "$OUTPUT_FILE"

SIZE="$(du -h "$OUTPUT_FILE" | cut -f1)"
echo "-> Backup complete: $OUTPUT_FILE ($SIZE)"
