#!/usr/bin/env bash
# One-shot host nginx install for navix.droidje.com. Requires sudo.
# Usage (on the MGG host, from the clone): sudo bash scripts/ci/install-navix-nginx.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
src="$repo_root/infra/nginx/navix.droidje.com.conf"
dest_available="/etc/nginx/sites-available/navix.droidje.com"
dest_enabled="/etc/nginx/sites-enabled/navix.droidje.com"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

install -m 0644 "$src" "$dest_available"
ln -sfn "$dest_available" "$dest_enabled"
nginx -t
systemctl reload nginx

if command -v certbot >/dev/null 2>&1; then
  certbot --nginx -d navix.droidje.com --non-interactive --agree-tos --redirect \
    --register-unsafely-without-email || \
    echo "certbot failed — obtain a certificate for navix.droidje.com and reload nginx" >&2
else
  echo "certbot is not installed; HTTP-only site is active on port 80" >&2
fi
