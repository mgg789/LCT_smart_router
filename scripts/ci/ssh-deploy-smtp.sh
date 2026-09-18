#!/usr/bin/env bash
# SourceCraft CD cube: stream infra/smtp to the mail host and run apply.
set -euo pipefail

: "${SMTP_DEPLOY_SSH_KEY:?SMTP_DEPLOY_SSH_KEY is required}"
host="${SMTP_DEPLOY_HOST:-194.87.202.172}"
user="${SMTP_DEPLOY_USER:-deploy}"
port="${SMTP_DEPLOY_PORT:-22}"
ssh_opts=()

key_file="$(mktemp)"
remote_tmp=""
cleanup() {
  rm -f "$key_file"
  if [ -n "${remote_tmp:-}" ] && [ "${#ssh_opts[@]}" -gt 0 ]; then
    ssh "${ssh_opts[@]}" "${user}@${host}" "rm -rf $(printf %q "$remote_tmp")" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

python3 - "$key_file" <<'PY'
import base64
import os
import re
import sys
from pathlib import Path

raw = os.environ["SMTP_DEPLOY_SSH_KEY"]
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
        "SMTP_DEPLOY_SSH_KEY is set but is not a PEM/OpenSSH private key "
        f"(bytes={len(raw.encode('utf-8'))} lines={raw.count(chr(10)) + 1}).\n"
    )
    sys.exit(2)

match = re.search(
    r"-----BEGIN ([A-Z0-9 ]+)-----\s*(.*?)\s*-----END \1-----",
    raw,
    re.S,
)
if match is None:
    sys.stderr.write("SMTP_DEPLOY_SSH_KEY headers are malformed.\n")
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
  echo "SMTP_DEPLOY_SSH_KEY materialised but ssh-keygen cannot read it (libcrypto)." >&2
  exit 2
fi

ssh_opts=(
  -p "$port"
  -i "$key_file"
  -o BatchMode=yes
  -o PreferredAuthentications=publickey
  -o StrictHostKeyChecking=accept-new
  -o IdentitiesOnly=yes
)

# Alpine cubes have OpenSSH but not rsync. Stream into a fresh /tmp tree so a
# previous root-owned /home/deploy/smtp cannot fail the extract with EEXIST.
remote_tmp="$(
  ssh "${ssh_opts[@]}" "${user}@${host}" \
    'mktemp -d /tmp/navix-smtp.XXXXXX'
)"
remote_tmp="${remote_tmp//$'\r'/}"
if [ -z "$remote_tmp" ] || [ "$remote_tmp" = "${remote_tmp#/tmp/navix-smtp.}" ]; then
  echo "SMTP host did not return a /tmp/navix-smtp.XXXXXX directory" >&2
  exit 2
fi

tar -C infra/smtp -cf - . | ssh "${ssh_opts[@]}" "${user}@${host}" \
  "tar -C $(printf %q "$remote_tmp") --no-same-owner --overwrite -xf -"

ssh "${ssh_opts[@]}" "${user}@${host}" \
  "SMTP_APP_DIR=$(printf %q "$remote_tmp") bash -s" \
  < scripts/ci/deploy-smtp-remote.sh
