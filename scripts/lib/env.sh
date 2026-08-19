#!/usr/bin/env bash
#
# Shared helpers for scripts/backup.sh and scripts/restore.sh. Not meant to
# be executed directly — sourced by both.

# load_dotenv <path-to-env-file>
#
# Exports simple KEY=VALUE lines from the given file into the environment,
# skipping blank lines and lines starting with '#'. Mirrors the "dotenv/config"
# convention already used by migrate.ts/seed.ts (src/plugins/database-mysql/
# src/migrate.ts, src/cli/seed.ts) with one important difference reimplemented
# here to match dotenv's own default behavior: a variable ALREADY set in the
# environment is never overwritten by the file — real env vars (e.g. ones a
# test or CI job exports explicitly) always win over `.env`.
load_dotenv() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0

  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comments.
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Trim surrounding whitespace from the key.
    key="$(echo "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$key" ] && continue
    # Strip optional matching single/double quotes around the value. Uses
    # front/back parameter-expansion trims (rather than a negative-index
    # substring) so this also works under macOS's stock bash 3.2, not just
    # bash 4+.
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    # Only fill in the value if this key isn't already set in the environment.
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$env_file"
}

# require_db_env
#
# Fails fast with a single clear message (no raw stack trace) when any of
# the required DB_* credentials are missing, the same "never boot with an
# incomplete config" contract src/core/config.ts's loadConfig() enforces
# for the application itself.
require_db_env() {
  local missing=()
  [ -z "${DB_USER:-}" ] && missing+=("DB_USER")
  [ -z "${DB_PASSWORD:-}" ] && missing+=("DB_PASSWORD")
  [ -z "${DB_NAME:-}" ] && missing+=("DB_NAME")

  if [ "${#missing[@]}" -gt 0 ]; then
    local joined
    joined="$(IFS=', '; echo "${missing[*]}")"
    echo "Error: missing required environment variable(s): $joined (set them directly or via .env — see .env.example)." >&2
    exit 1
  fi
}
