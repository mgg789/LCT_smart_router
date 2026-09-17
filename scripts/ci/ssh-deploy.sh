#!/usr/bin/env bash
# SourceCraft CD cube: open an SSH session to the MGG host and run deploy-remote.sh.
#
# Requires MGG_DEPLOY_SSH_KEY in the environment (SourceCraft secret). The key
# is written to a temporary file and removed before the cube exits.
set -euo pipefail

: "${MGG_DEPLOY_SSH_KEY:?MGG_DEPLOY_SSH_KEY is required}"
host="${MGG_DEPLOY_HOST:-178.140.207.217}"
user="${MGG_DEPLOY_USER:-mgg}"
port="${MGG_DEPLOY_PORT:-2222}"
app_dir="${MGG_APP_DIR:-/home/mgg/navix}"
branch="${MGG_BRANCH:-main}"
healthcheck_url="${MGG_HEALTHCHECK_URL:-https://navix.droidje.com/}"
healthcheck_api_url="${MGG_HEALTHCHECK_API_URL:-http://127.0.0.1:18080/health/live}"

key_file="$(mktemp)"
cleanup() {
  rm -f "$key_file"
}
trap cleanup EXIT

printf '%s\n' "$MGG_DEPLOY_SSH_KEY" > "$key_file"
chmod 600 "$key_file"

# Normalise Windows / copied keys that arrive without a trailing newline.
if [ "$(tail -c 1 "$key_file" | wc -l)" -eq 0 ]; then
  printf '\n' >> "$key_file"
fi

ssh -p "$port" \
  -i "$key_file" \
  -o StrictHostKeyChecking=accept-new \
  -o IdentitiesOnly=yes \
  "${user}@${host}" \
  "MGG_APP_DIR=$(printf %q "$app_dir") MGG_BRANCH=$(printf %q "$branch") MGG_HEALTHCHECK_URL=$(printf %q "$healthcheck_url") MGG_HEALTHCHECK_API_URL=$(printf %q "$healthcheck_api_url") bash -s" \
  < scripts/ci/deploy-remote.sh
