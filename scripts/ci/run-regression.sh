#!/usr/bin/env bash
# Run the complete app in a unique Compose project, retaining failure evidence.
# Only this invocation's project and volumes are removed; no external URL is accepted.
set -euo pipefail

cd "$(dirname "$0")/../.."
case "$(uname -s)" in
  MINGW*|MSYS*) root="$(pwd -W)" ;;
  *) root="$(pwd -P)" ;;
esac
# Never inherit an operator's database credentials into the disposable contour.
set -a
source "$root/tests/e2e/contour.env"
set +a
export MSYS_NO_PATHCONV=1
run_id="$(date -u +%Y%m%dT%H%M%S)-$$-${RANDOM}"
project="lct-regression-${run_id,,}"
output="$root/artifacts/regression/$run_id"
mkdir -p "$output"

compose() {
  docker compose --project-name "$project" \
    --env-file "$root/tests/e2e/contour.env" \
    -f "$root/infra/docker-compose.yml" \
    -f "$root/infra/docker-compose.regression.yml" "$@"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  compose logs --no-color >"$output/services.log" 2>&1
  compose ps -a >"$output/containers.txt" 2>&1
  if compose exec -T regression test -d /app/artifacts 2>/dev/null; then
    compose cp regression:/app/artifacts/. "$output/" >>"$output/collection.log" 2>&1
    if [[ $? -ne 0 && $status -eq 0 ]]; then status=1; fi
  fi
  compose down --volumes --remove-orphans --timeout 10 >"$output/cleanup.log" 2>&1
  if [[ $? -ne 0 && $status -eq 0 ]]; then status=1; fi
  printf '\nRegression exit=%s; artifacts: %s\n' "$status" "$output"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Regression project: %s\n' "$project"
compose up -d --build --wait --wait-timeout 180 2>&1 | tee "$output/startup.log"
compose exec -T regression pnpm test:e2e:types 2>&1 | tee "$output/typecheck.log"
compose exec -T postgres createdb -U lct lct_api_checks
compose exec -T regression bash -ec '
  export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/lct_api_checks"
  pnpm --filter api exec prisma migrate deploy
  pnpm --filter api exec node --test dist-test/test/integration/engineers.test.js
' 2>&1 | tee "$output/api-engineers.log"
compose exec -T regression pnpm smoke 2>&1 | tee "$output/smoke.log"
compose exec -T regression pnpm test:e2e 2>&1 | tee "$output/browser.log"
compose stop router 2>&1 | tee "$output/router-stop.log"
compose exec -T -e E2E_PHASE=router-down regression pnpm test:e2e 2>&1 | tee "$output/router-down.log"
compose start --wait --wait-timeout 90 router 2>&1 | tee "$output/router-start.log"
compose exec -T -e E2E_PHASE=router-recovery regression pnpm test:e2e 2>&1 | tee "$output/router-recovery.log"
