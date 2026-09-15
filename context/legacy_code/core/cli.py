"""Shared CLI helpers for the computation-core entrypoints (``core.gen``, ``core.solve``)."""

from __future__ import annotations

import sys
from pathlib import Path


def resolve_output_path(raw: str) -> Path:
    """Canonicalize a CLI output path and confine it to the working directory.

    The core CLIs are documented to run from the repository root and write
    repo-relative artifacts (context/14 §5.3). A resolved path that escapes
    the current working directory is rejected (CWE-22 path traversal), as is
    an existing directory target; symbolic links are resolved before the
    containment check.

    Args:
        raw: output path as given on the command line (relative, absolute
            or ``~``-prefixed).

    Returns:
        Absolute, symlink-resolved path safe to open for writing.

    Raises:
        SystemExit: with code 2 when the path escapes the working directory
            or points at a directory.
    """
    path = Path(raw).expanduser().resolve()
    base = Path.cwd().resolve()
    if path == base or base not in path.parents:
        print(f"error: output path must stay inside the working directory ({base}): {raw}", file=sys.stderr)
        raise SystemExit(2)
    if path.is_dir():
        print(f"error: output path is a directory: {raw}", file=sys.stderr)
        raise SystemExit(2)
    return path
