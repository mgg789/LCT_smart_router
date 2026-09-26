"""Check that the CI helper keeps the complete JS suite inside its Node container."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class RunJsTestsTest(unittest.TestCase):
    """Catch shell quoting that accidentally executes package commands on the worker."""

    def test_api_commands_stay_in_node_container(self) -> None:
        """Web and API commands must reach Docker, never the host pnpm executable."""
        helper = Path(__file__).with_name("run-js-tests.sh")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / "docker"
            docker.write_text(
                '#!/bin/bash\ncase "$*" in\n'
                '  *node:24-bookworm*) cat > "$CAPTURE_SCRIPT" ;;\n'
                'esac\n',
                encoding="utf-8",
            )
            docker.chmod(0o755)
            pnpm = root / "pnpm"
            pnpm.write_text("#!/bin/bash\nexit 99\n", encoding="utf-8")
            pnpm.chmod(0o755)
            captured = root / "node-script.sh"
            result = subprocess.run(
                ["bash", str(helper)],
                cwd=root,
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "LCT_CI_PG_PASSWORD": "disposable-test-value",
                    "CAPTURE_SCRIPT": str(captured),
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            script = captured.read_text(encoding="utf-8")
            for command in (
                "pnpm --filter web test",
                "pnpm --filter web typecheck",
                "pnpm --filter api exec prisma generate",
                "pnpm --filter api exec prisma migrate deploy",
                "pnpm --filter api test",
            ):
                self.assertIn(command, script)
            subprocess.run(["bash", "-n", str(captured)], check=True)


if __name__ == "__main__":
    unittest.main()
