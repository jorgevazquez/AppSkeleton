#!/usr/bin/env bash
#
# mysqldump-based restore helper (feature #28 — "Backup and restore helper
# scripts"). Loads a dump produced by scripts/backup.sh (or any plain/
# gzip-compressed mysqldump output) back into the configured database.
#
# Config is layered exactly like backup.sh (see that file's header and
# src/plugins/database-mysql/src/config.ts): real environment variables
# win, `.env` (repo root) fills in anything still unset, DB_HOST/DB_PORT
# default to docker-compose.yml's local MySQL, and DB_USER/DB_PASSWORD/
# DB_NAME are required with no default.
#
# This is destructive: every table present in the backup is dropped and
# recreated (mysqldump's default --add-drop-table behavior), overwriting
# its current contents in DB_NAME. It prompts for confirmation unless
# --force is passed or DB_RESTORE_SKIP_CONFIRM=true is set — the latter
# exists so scripted/CI/test usage (see
# tests/core/backup-restore.integration.test.ts) doesn't need a tty.
#
# Usage:
#   scripts/restore.sh <backup-file> [--force]
#
#   scripts/restore.sh ./backups/appskeleton-20260101T000000Z.sql.gz
#   scripts/restore.sh ./backups/appskeleton-20260101T000000Z.sql.gz --force
#
# See docs/backup-restore.md for full usage and the matching backup.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib/env.sh
source "$SCRIPT_DIR/lib/env.sh"

INPUT_FILE=""
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) INPUT_FILE="$arg" ;;
  esac
done

if [ -z "$INPUT_FILE" ]; then
  echo "Usage: scripts/restore.sh <backup-file> [--force]" >&2
  exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
  echo "Error: backup file not found: $INPUT_FILE" >&2
  exit 1
fi

load_dotenv "$REPO_ROOT/.env"
require_db_env

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"

if [ "$FORCE" != true ] && [ "${DB_RESTORE_SKIP_CONFIRM:-false}" != true ]; then
  if [ ! -t 0 ]; then
    echo "Error: refusing to restore non-interactively without --force or DB_RESTORE_SKIP_CONFIRM=true." >&2
    exit 1
  fi
  read -r -p "This will overwrite data in '$DB_NAME' at $DB_HOST:$DB_PORT from $INPUT_FILE. Continue? [y/N] " confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *)
      echo "Aborted."
      exit 1
      ;;
  esac
fi

echo "-> Restoring database '$DB_NAME' at $DB_HOST:$DB_PORT from $INPUT_FILE"

# Detect gzip vs. plain SQL by magic bytes rather than trusting the file
# extension, so a caller who renamed a .sql.gz file (or, e.g., piped a raw
# dump through backup.sh's naming convention differently) still works.
if [ "$(head -c2 "$INPUT_FILE" | od -An -tx1 | tr -d ' \n')" = "1f8b" ]; then
  CAT_CMD=(gunzip -c "$INPUT_FILE")
else
  CAT_CMD=(cat "$INPUT_FILE")
fi

"${CAT_CMD[@]}" | MYSQL_PWD="$DB_PASSWORD" mysql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  "$DB_NAME"

echo "-> Restore complete."
