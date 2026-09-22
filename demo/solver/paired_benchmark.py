"""Alternate an archived baseline with current core code, without changing the checkout."""

import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    """Measure the 205-job input with identical dependencies and alternating process order."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="a55e41c")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    baseline = subprocess.check_output(
        [
            "git",
            "rev-parse",
            "--verify",
            "--end-of-options",
            f"{args.baseline}^{{commit}}",
        ],
        cwd=ROOT,
        text=True,
    ).strip()
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    scratch = ROOT / "artifacts" / "solver-audit"
    scratch.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    runs = []
    with tempfile.TemporaryDirectory(
        prefix="paired-baseline-", dir=scratch
    ) as temporary:
        target = Path(temporary).resolve()
        # Only this freshly-created scratch directory can be cleaned up by the context manager.
        if not target.is_relative_to(scratch.resolve()):
            raise ValueError("Baseline scratch escaped the workspace")
        archive = subprocess.check_output(
            ["git", "archive", "--format=tar", baseline, "core"], cwd=ROOT
        )
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(target, filter="data")
        for traffic in (True, False):
            for repeat in range(args.repeat):
                for variant in ("before", "after"):
                    env = {
                        **os.environ,
                        "SOLVER_AUDIT_CORE_ROOT": str(
                            target if variant == "before" else ROOT
                        ),
                    }
                    result = subprocess.run(
                        [
                            sys.executable,
                            str(ROOT / "demo/solver/benchmark.py"),
                            "child",
                            "all",
                            str(int(traffic)),
                        ],
                        cwd=ROOT,
                        env=env,
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    row = json.loads(result.stdout)
                    row.update(variant=variant, repeat=repeat + 1)
                    runs.append(row)
                    args.output.write_text(
                        json.dumps(
                            {
                                "baseline": baseline,
                                "implementation": head,
                                "runs": runs,
                            },
                            indent=2,
                        )
                        + "\n",
                        encoding="utf-8",
                    )
                    print(
                        variant,
                        traffic,
                        repeat + 1,
                        round(row["elapsed_sec"], 3),
                        flush=True,
                    )


if __name__ == "__main__":
    main()
