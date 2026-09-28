"""Resolve real Compose token precedence without private env files or running services."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class MetricsConfigurationTests(unittest.TestCase):
    """The scraper and protected service must use the same credential source."""

    def test_file_and_shell_tokens_are_shared_with_each_scraper(self):
        """Cover normal .env loading and a conflicting shell override for both services."""
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            env_file = folder / "public-test.env"
            env_file.write_text(
                "METRICS_ENABLED=true\nROUTER_METRICS_ENABLED=true\n"
                f"METRICS_TOKEN={'api-file-test-' * 4}\n"
                f"ROUTER_METRICS_TOKEN={'router-file-test-' * 4}\n",
                encoding="utf-8",
            )
            overlay = folder / "overlay.yml"
            overlay.write_text(
                "services:\n  api:\n    env_file: !override\n      - "
                + json.dumps(env_file.as_posix())
                + "\n",
                encoding="utf-8",
            )
            for override in (False, True):
                with self.subTest(shell_override=override):
                    environment = dict(os.environ)
                    for name in ("METRICS_TOKEN", "ROUTER_METRICS_TOKEN"):
                        environment.pop(name, None)
                        if override:
                            environment[name] = "shell-test-" * 4
                    result = subprocess.run(
                        [
                            "docker",
                            "compose",
                            "--project-name",
                            "metrics-config-test",
                            "--env-file",
                            str(ROOT / "tests/e2e/contour.env"),
                            "--env-file",
                            str(env_file),
                            "-f",
                            str(ROOT / "infra/docker-compose.yml"),
                            "-f",
                            str(ROOT / "infra/docker-compose.regression.yml"),
                            "-f",
                            str(overlay),
                            "--profile",
                            "observability",
                            "config",
                            "--format",
                            "json",
                        ],
                        env=environment,
                        capture_output=True,
                        text=True,
                        check=True,
                        timeout=30,
                    )
                    services = json.loads(result.stdout)["services"]
                    for service, key in (
                        ("api", "METRICS_TOKEN"),
                        ("router", "ROUTER_METRICS_TOKEN"),
                    ):
                        token = services[service]["environment"][key]
                        self.assertEqual(
                            token, services["prometheus"]["environment"][key]
                        )
                        expected = (
                            "shell-test-" * 4
                            if override
                            else f"{service}-file-test-" * 4
                        )
                        self.assertEqual(token, expected)


if __name__ == "__main__":
    unittest.main()
