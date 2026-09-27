"""Regenerate basic release integrity hashes after intentional source changes."""

import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
paths = (
    list((root / "launch").glob("*.py"))
    + list((root / "launch").glob("*.sh"))
    + list((root / "launch").glob("*.cmd"))
    + list((root / "launch").glob("*.cjs"))
)
paths += [
    root / name
    for name in (
        "infra/docker-compose.yml",
        "infra/postgres/enable-router-login.sql",
        "pnpm-lock.yaml",
        "apps/api/Dockerfile",
        "apps/web/Dockerfile",
        "core/Dockerfile",
        "apps/web/nginx.conf",
    )
]
manifest = {
    str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted(paths)
}
(root / "launch/manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
