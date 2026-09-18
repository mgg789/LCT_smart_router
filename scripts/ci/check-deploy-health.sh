#!/usr/bin/env bash
# Remote half of the post-deploy health job. Prints one JSON bundle
# {live, ready, services} from the loopback System Layer. Evaluation stays
# on the SourceCraft cube so this host does not need the repo module.
#
# Expected environment:
#   MGG_HEALTHCHECK_API_URL — liveness URL, default http://127.0.0.1:18080/health/live
set -euo pipefail

live_url="${MGG_HEALTHCHECK_API_URL:-http://127.0.0.1:18080/health/live}"
base="${live_url%/live}"

python3 - "$base" <<'PY'
import json
import sys
import urllib.request

base = sys.argv[1].rstrip("/")


def fetch(url: str) -> object:
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.load(response)


bundle = {
    "live": fetch(f"{base}/live"),
    "ready": fetch(f"{base}/ready"),
    "services": fetch(f"{base}/services"),
}
print(json.dumps(bundle, ensure_ascii=False))
PY
