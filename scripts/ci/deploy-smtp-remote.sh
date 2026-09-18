#!/usr/bin/env bash
# Remote half of the SMTP apply. Runs as deploy and sudoes the apply script.
set -euo pipefail

app_dir="${SMTP_APP_DIR:-/home/deploy/smtp}"
if [ ! -f "$app_dir/apply.sh" ]; then
  echo "missing $app_dir/apply.sh" >&2
  exit 30
fi

sudo /usr/local/sbin/navix-smtp-apply "$app_dir" || sudo bash "$app_dir/apply.sh" "$app_dir"

if ! curl -fsS --retry 5 --retry-delay 2 http://127.0.0.1:8587/health >/tmp/navix-smtp-health.json; then
  echo "watchdog health failed" >&2
  exit 32
fi
echo "healthcheck smtp watchdog OK"
cat /tmp/navix-smtp-health.json
echo
printf 'DEPLOY_RESULT mode=smtp host=mail.droidje.com\n'
