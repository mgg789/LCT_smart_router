"""Stamp a published version and regenerate portable integrity hashes for build inputs."""

import argparse
import json
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))


def main() -> None:
    """Preserve development version unless an operator explicitly stamps a published release."""
    from launch.core import file_digest
    from launch.versions import parse_version

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="Published release version, for example 1.7.0")
    args = parser.parse_args()
    if args.version:
        parse_version(args.version)
        (root / "launch/release.json").write_text(
            json.dumps({"version": args.version, "channel": "release"}, indent=2) + "\n",
            encoding="utf-8",
        )
    paths = []
    excluded = {
        "node_modules",
        ".venv",
        "__pycache__",
        "dist",
        "dist-test",
        "generated",
        ".pytest_cache",
        ".ruff_cache",
        ".mimosa",
        "osrm",
        "state",
        "payload",
    }
    for name in (
        "launch",
        "apps/api",
        "apps/web",
        "core",
        "packages",
        "services/sys1",
        "services/road-api",
        "services/route-engine3",
        "docs/knowledge",
        "infra/postgres",
    ):
        for parent, directories, files in os.walk(root / name):
            directories[:] = [directory for directory in directories if directory not in excluded]
            for filename in files:
                path = Path(parent) / filename
                if (
                    path == root / "launch/manifest.json"
                    or path.suffix in {".pyc", ".tsbuildinfo", ".log"}
                    or filename.startswith(".env")
                ):
                    continue
                paths.append(path)
    paths += [
        root / name
        for name in (
            "infra/docker-compose.yml",
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
        )
    ]
    manifest = {path.relative_to(root).as_posix(): file_digest(path) for path in sorted(set(paths))}
    (root / "launch/manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"Updated integrity manifest: {len(manifest)} files")


if __name__ == "__main__":
    main()
