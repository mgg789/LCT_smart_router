#!/usr/bin/env bash
# JS/TS test cube helper: Postgres sidecar + frozen pnpm install + web/api tests.
#
# Requires Docker on the worker (native SourceCraft cube). The node image uses
# host networking so it can reach the published Postgres port.
set -euo pipefail

pg_name="lct-ci-pg-$$"
# Comes from the LCT_CI_PG_PASSWORD repository secret injected by ci.yaml
# (the default branch has carried the env mapping since !44).
pg_password="${LCT_CI_PG_PASSWORD:?LCT_CI_PG_PASSWORD missing (CI secret not injected?)}"
# A per-run loopback port: a shared worker host may already bind 5432 (the MGG
# box runs the demo stand's Postgres there) and the sidecar must not be
# reachable from outside. $$ keeps concurrent runs apart; the rare collision
# surfaces as an immediate docker bind error, not a flaky test.
pg_port=$((21000 + $$ % 20000))
database_url="postgresql://lct:${pg_password}@127.0.0.1:${pg_port}/lct?schema=public"

cleanup() {
  docker rm -f "$pg_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$pg_name" \
  -e POSTGRES_USER=lct \
  -e POSTGRES_PASSWORD="$pg_password" \
  -e POSTGRES_DB=lct \
  -p 127.0.0.1:"${pg_port}":5432 \
  pgvector/pgvector:pg17

for _ in $(seq 1 40); do
  if docker exec "$pg_name" pg_isready -U lct -d lct >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$pg_name" pg_isready -U lct -d lct

docker run --rm --network host \
  -v "$PWD:/app" \
  -w /app \
  -e DATABASE_URL="$database_url" \
  -e TEST_DATABASE_URL="$database_url" \
  -e MIGRATE_DATABASE_URL="$database_url" \
  -e NODE_ENV=test \
  -e AUTH_DEV_EXPOSE_CODES=true \
  docker.io/library/node:24-bookworm \
  bash -lc '
    set -euo pipefail
    corepack enable
    corepack prepare pnpm@10.28.2 --activate
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends openssl ca-certificates >/dev/null
    pnpm install --frozen-lockfile
    pnpm --filter web test
    pnpm --filter web typecheck
    test -f .env || cp .env.example .env
    # NODE_ENV=test makes ConfigModule ignore the file copied above, while a unit test
    # that boots no app still validates the whole environment as soon as its import
    # graph reaches ConfigModule.forRoot. Integration tests read .env by hand (see
    # test/support/env.ts); exporting the dispatcher pair covers the rest of the suite.
    eval "$(grep -E "^DISPATCHER_(EMAIL|PASSWORD)=" .env | sed "s/^/export /")"
    pnpm --filter api exec prisma generate
    pnpm --filter api exec prisma migrate deploy
    pnpm --filter api test
  '
