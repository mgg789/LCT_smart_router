#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Install Python 3.10+: https://www.python.org/downloads/"
  exit 1
fi
exec python3 -m launch.cli "$@"
