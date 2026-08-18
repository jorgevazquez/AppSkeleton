#!/usr/bin/env bash
# Idempotent environment setup for AppSkeleton. Safe to run repeatedly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "== AppSkeleton init =="

# Dev-only seed data (feature #25) is opt-in via an explicit --seed flag —
# never run automatically, so a production invocation of this script (which
# should never pass --seed in the first place) never seeds. The seed
# runner itself (src/core/seed.ts) also independently refuses to run when
# NODE_ENV=production, as a second, redundant guard.
SEED_LOCAL_DATA=false
for arg in "$@"; do
  case "$arg" in
    --seed) SEED_LOCAL_DATA=true ;;
  esac
done

# 1. Env file
if [ ! -f .env ]; then
  cp .env.example .env
  echo "-> Created .env from .env.example (edit secrets before deploying anywhere real)."
else
  echo "-> .env already present."
fi

# 2. Node dependencies
if [ -f package.json ]; then
  echo "-> Installing npm dependencies..."
  npm install
else
  echo "-> No package.json yet, skipping npm install."
fi

# 3. MySQL via Docker Compose (best-effort — dev-agent sessions in sandboxes
#    without Docker access should not hard-fail here).
if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  echo "-> Starting MySQL (docker compose)..."
  if docker compose up -d mysql 2>/tmp/appskeleton-docker.log; then
    echo "-> Waiting for MySQL to be healthy..."
    for _ in $(seq 1 30); do
      status="$(docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q mysql)" 2>/dev/null || echo unknown)"
      if [ "$status" = "healthy" ]; then
        echo "-> MySQL is healthy."
        break
      fi
      sleep 2
    done
  else
    echo "-> WARNING: could not start MySQL via Docker (see /tmp/appskeleton-docker.log). Continuing without it."
  fi
else
  echo "-> Docker not available or no docker-compose.yml — skipping MySQL bootstrap."
fi

# 4. Run migrations, if the migration runner has been built yet.
if [ -f src/plugins/database-mysql/src/migrate.ts ]; then
  echo "-> Running database migrations..."
  npm run migrate || echo "-> WARNING: migrations failed, continuing (fix before marking DB features passing)."
else
  echo "-> Migration runner not implemented yet — skipping."
fi

# 4b. Seed local dev fixtures (feature #25) — dev-only, opt-in via --seed.
#     Never run without the flag, so a plain `./init.sh` (including any
#     production bootstrap) never seeds automatically.
if [ "$SEED_LOCAL_DATA" = true ]; then
  if [ -f src/cli/seed.ts ]; then
    echo "-> Seeding local dev fixtures (--seed passed)..."
    npm run seed || echo "-> WARNING: seeding failed, continuing."
  else
    echo "-> Seed runner not implemented yet — skipping despite --seed."
  fi
else
  echo "-> Skipping dev seed data (pass --seed to populate local fixtures)."
fi

# 5. Verify the toolchain builds & tests run.
if [ -f package.json ]; then
  echo "-> Type-checking / build..."
  npm run build || echo "-> WARNING: build failed."
  echo "-> Running test suite..."
  npm test || echo "-> WARNING: tests failed."
fi

echo "== init.sh complete =="
