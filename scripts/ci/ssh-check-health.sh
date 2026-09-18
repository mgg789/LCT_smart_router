#!/usr/bin/env bash
# SourceCraft CD cube: wait after both deploys, then probe public gate +
# /health/services on the MGG loopback. Fails the pipeline if database,
# router, or smtp is not ok.
set -euo pipefail

: "${MGG_DEPLOY_SSH_KEY:?MGG_DEPLOY_SSH_KEY is required}"
host="${MGG_DEPLOY_HOST:-178.140.207.217}"
user="${MGG_DEPLOY_USER:-mgg}"
port="${MGG_DEPLOY_PORT:-2222}"
healthcheck_url="${MGG_HEALTHCHECK_URL:-https://navix.droidje.com/}"
healthcheck_api_url="${MGG_HEALTHCHECK_API_URL:-http://127.0.0.1:18080/health/live}"
settle_sec="${HEALTH_SETTLE_SEC:-20}"
retries="${HEALTH_RETRIES:-12}"
delay_sec="${HEALTH_RETRY_DELAY_SEC:-5}"

here="$(cd "$(dirname "$0")" && pwd)"

key_file="$(mktemp)"
cleanup() {
  rm -f "$key_file"
}
trap cleanup EXIT

python3 - "$key_file" <<'PY'
import base64
import os
import re
import sys
from pathlib import Path

raw = os.environ["MGG_DEPLOY_SSH_KEY"]
raw = raw.lstrip("\ufeff").strip()
if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
    raw = raw[1:-1].strip()
raw = raw.replace("\r\n", "\n").replace("\r", "\n")


def looks_like_key(text: str) -> bool:
    return "-----BEGIN " in text and "-----END " in text


if (not looks_like_key(raw) or raw.count("\n") < 2) and "\\n" in raw:
    expanded = raw.replace("\\n", "\n")
    if looks_like_key(expanded):
        raw = expanded

if not looks_like_key(raw):
    compact = re.sub(r"\s+", "", raw)
    try:
        decoded = base64.b64decode(compact, validate=False).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        decoded = ""
    if looks_like_key(decoded):
        raw = decoded.replace("\r\n", "\n").replace("\r", "\n")

if not looks_like_key(raw):
    sys.stderr.write(
        "MGG_DEPLOY_SSH_KEY is set but is not a PEM/OpenSSH private key "
        f"(bytes={len(raw.encode('utf-8'))} lines={raw.count(chr(10)) + 1}). "
        "Re-set the secret to the full private key file, including BEGIN/END lines.\n"
    )
    sys.exit(2)

match = re.search(
    r"-----BEGIN ([A-Z0-9 ]+)-----\s*(.*?)\s*-----END \1-----",
    raw,
    re.S,
)
if match is None:
    sys.stderr.write("MGG_DEPLOY_SSH_KEY headers are malformed.\n")
    sys.exit(2)

label = match.group(1)
body = re.sub(r"\s+", "", match.group(2))
width = 70 if "OPENSSH" in label else 64
chunks = [body[index : index + width] for index in range(0, len(body), width)]
Path(sys.argv[1]).write_text(
    f"-----BEGIN {label}-----\n" + "\n".join(chunks) + f"\n-----END {label}-----\n",
    encoding="ascii",
)
PY
chmod 600 "$key_file"

if ! ssh-keygen -y -P "" -f "$key_file" >/dev/null 2>&1; then
  echo "MGG_DEPLOY_SSH_KEY materialised but ssh-keygen cannot read it (libcrypto)." >&2
  echo "diag: bytes=$(wc -c < "$key_file") lines=$(wc -l < "$key_file")" >&2
  exit 2
fi

echo "health settle ${settle_sec}s (public ${healthcheck_url})"
sleep "$settle_sec"

if [ -n "$healthcheck_url" ]; then
  curl -fsS --retry 5 --retry-delay 3 --max-time 20 "$healthcheck_url" >/dev/null
  echo "healthcheck public: $healthcheck_url OK"
fi

attempt=1
while [ "$attempt" -le "$retries" ]; do
  echo "health services attempt ${attempt}/${retries}"
  if bundle="$(
    ssh -p "$port" \
      -i "$key_file" \
      -o BatchMode=yes \
      -o PreferredAuthentications=publickey \
      -o StrictHostKeyChecking=accept-new \
      -o IdentitiesOnly=yes \
      "${user}@${host}" \
      "MGG_HEALTHCHECK_API_URL=$(printf %q "$healthcheck_api_url") bash -s" \
      < "$here/check-deploy-health.sh"
  )" && printf '%s\n' "$bundle" | python3 "$here/evaluate_health_services.py"; then
    echo "HEALTH_RESULT status=ok attempts=${attempt}"
    exit 0
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -le "$retries" ]; then
    sleep "$delay_sec"
  fi
done

echo "health services still failing after ${retries} attempts" >&2
exit 33
