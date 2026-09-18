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

# SourceCraft UI / env injection often flattens PEM newlines or stores the
# file as base64. Rebuild a parseable OpenSSH/PEM key without printing it.
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

ssh -p "$port" \
  -i "$key_file" \
  -o BatchMode=yes \
  -o PreferredAuthentications=publickey \
  -o StrictHostKeyChecking=accept-new \
  -o IdentitiesOnly=yes \
  "${user}@${host}" \
  "MGG_APP_DIR=$(printf %q "$app_dir") MGG_BRANCH=$(printf %q "$branch") MGG_HEALTHCHECK_URL=$(printf %q "$healthcheck_url") MGG_HEALTHCHECK_API_URL=$(printf %q "$healthcheck_api_url") bash -s" \
  < scripts/ci/deploy-remote.sh
