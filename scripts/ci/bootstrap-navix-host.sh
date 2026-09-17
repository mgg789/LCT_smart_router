#!/usr/bin/env bash
# First-time host bootstrap for /home/mgg/navix. Safe to re-run.
# Does not install nginx (needs interactive sudo) and does not print secrets.
set -euo pipefail

app_dir="${MGG_APP_DIR:-/home/mgg/navix}"
example_src="${NAVIX_ENV_EXAMPLE:-/tmp/navix.env.example}"

if [ ! -f "$HOME/.ssh/navix_sourcecraft" ]; then
  ssh-keygen -t ed25519 -N "" -C "navix-mgg-to-sourcecraft" -f "$HOME/.ssh/navix_sourcecraft"
fi
chmod 600 "$HOME/.ssh/navix_sourcecraft"
touch "$HOME/.ssh/known_hosts"
ssh-keyscan -T 10 ssh.sourcecraft.dev >> "$HOME/.ssh/known_hosts" 2>/dev/null || true

if [ ! -f "$HOME/.ssh/config" ] || ! grep -q "Host ssh.sourcecraft.dev" "$HOME/.ssh/config"; then
  cat >> "$HOME/.ssh/config" <<'EOF'
Host ssh.sourcecraft.dev
  User git
  IdentityFile ~/.ssh/navix_sourcecraft
  IdentitiesOnly yes
EOF
  chmod 600 "$HOME/.ssh/config"
fi

if [ ! -f "$app_dir/.env" ]; then
  if [ ! -f "$example_src" ] && [ -f "$app_dir/.env.example" ]; then
    example_src="$app_dir/.env.example"
  fi
  if [ ! -f "$example_src" ]; then
    echo "missing env template at $example_src" >&2
    exit 1
  fi
  cp "$example_src" "$app_dir/.env"
  pg_pw="$(openssl rand -hex 16)"
  router_pw="$(openssl rand -hex 16)"
  disp_pw="$(openssl rand -hex 12)"
  python3 - "$app_dir/.env" "$pg_pw" "$router_pw" "$disp_pw" <<'PY'
from pathlib import Path
import sys
path, pg_pw, router_pw, disp_pw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = Path(path).read_text()
text = text.replace("lct_dev_password", pg_pw)
text = text.replace("router_dev_password", router_pw)
text = text.replace("change-me-before-deploying", disp_pw)
        text = text.replace("API_PORT=8000", "API_PORT=127.0.0.1:18080")
        text = text.replace("ROUTER_PORT=8100", "ROUTER_PORT=18100")
Path(path).write_text(text)
PY
  chmod 600 "$app_dir/.env"
fi

echo "SOURCECRAFT_DEPLOY_PUB_BEGIN"
cat "$HOME/.ssh/navix_sourcecraft.pub"
echo "SOURCECRAFT_DEPLOY_PUB_END"
echo "ENV_KEYS_BEGIN"
grep -E '^[A-Z_]+=' "$app_dir/.env" | cut -d= -f1
echo "ENV_KEYS_END"
