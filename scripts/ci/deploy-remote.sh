#!/usr/bin/env bash
# Remote half of the MGG compose deploy (same steps as mgg-server-deploy).
#
# Expected environment (set by the SourceCraft CD cube or the local skill):
#   MGG_APP_DIR            — clone on the server, default /home/mgg/navix
#   MGG_BRANCH             — git ref to fast-forward, default main
#   MGG_HEALTHCHECK_URL    — public gate, default https://navix.droidje.com/
#   MGG_HEALTHCHECK_API_URL — loopback API live probe, optional
set -euo pipefail

app_dir="${MGG_APP_DIR:-/home/mgg/navix}"
branch_or_ref="${MGG_BRANCH:-main}"
healthcheck_url="${MGG_HEALTHCHECK_URL:-https://navix.droidje.com/}"
healthcheck_api_url="${MGG_HEALTHCHECK_API_URL:-http://127.0.0.1:18080/health/live}"

cd "$app_dir"

before_sha=""
after_sha=""

if [ -d .git ]; then
  before_sha="$(git rev-parse HEAD 2>/dev/null || true)"
  git fetch --all --prune
  if git show-ref --verify --quiet "refs/heads/${branch_or_ref}"; then
    git checkout "${branch_or_ref}"
  elif git show-ref --verify --quiet "refs/remotes/origin/${branch_or_ref}"; then
    git checkout -B "${branch_or_ref}" "origin/${branch_or_ref}"
  else
    git checkout "${branch_or_ref}"
  fi
  if git show-ref --verify --quiet "refs/remotes/origin/${branch_or_ref}"; then
    git pull --ff-only origin "${branch_or_ref}"
  fi
  after_sha="$(git rev-parse HEAD 2>/dev/null || true)"
fi

compose_file=""
for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml infra/docker-compose.yml; do
  if [ -f "$f" ]; then
    compose_file="$f"
    break
  fi
done

if [ -z "$compose_file" ]; then
  echo "No compose file in $app_dir" >&2
  exit 30
fi

if docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose -f "$compose_file")
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose -f "$compose_file")
else
  echo "Docker Compose is not available on the server" >&2
  exit 31
fi

"${compose_cmd[@]}" pull || true
"${compose_cmd[@]}" up -d --build --remove-orphans
# API reaches host Hysteria via host.docker.internal. UFW INPUT is DROP, so
# Docker-bridge packets to :2525/:8587 must be accepted explicitly.
if docker image inspect alpine:3.21 >/dev/null 2>&1 || docker pull alpine:3.21 >/dev/null 2>&1; then
  docker rm -f navix-smtp-host-allow >/dev/null 2>&1 || true
  docker run -d --name navix-smtp-host-allow --restart unless-stopped \
    --privileged --network host alpine:3.21 \
    sh -c 'apk add --no-cache iptables iproute2 >/dev/null
      while true; do
        for br in $(ip -br addr | awk "/^br-/{print \$1}"); do
          iptables -C INPUT -i "$br" -p tcp --dport 2525 -j ACCEPT 2>/dev/null \
            || iptables -I INPUT -i "$br" -p tcp --dport 2525 -j ACCEPT
          iptables -C INPUT -i "$br" -p tcp --dport 8587 -j ACCEPT 2>/dev/null \
            || iptables -I INPUT -i "$br" -p tcp --dport 8587 -j ACCEPT
        done
        sleep 60
      done'
fi
echo 'COMPOSE_PS_BEGIN'
"${compose_cmd[@]}" ps
echo 'COMPOSE_PS_END'

if [ -n "$healthcheck_url" ]; then
  curl -fsS --retry 8 --retry-delay 5 "$healthcheck_url" >/dev/null
  echo "healthcheck public: $healthcheck_url OK"
fi

if [ -n "$healthcheck_api_url" ]; then
  curl -fsS --retry 8 --retry-delay 5 "$healthcheck_api_url" >/dev/null
  echo "healthcheck api: $healthcheck_api_url OK"
fi

printf 'DEPLOY_RESULT mode=compose before=%s after=%s\n' "$before_sha" "$after_sha"
