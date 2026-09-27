"""Launcher contract tests: no Docker containers are mutated."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from launch import core


class CoreTests(unittest.TestCase):
    def test_modes_and_ports(self):
        for options in (
            {"mode": "headless"},
            {"mode": "full"},
            {"mode": "full", "ui_port": 80, "api_port": 80},
            {"mode": "full", "ui_port": 70000},
        ):
            with self.assertRaises(ValueError):
                core.validate_options(options)
        core.validate_options({"mode": "headless", "api_port": 8000})

    def test_env_is_data(self):
        self.assertEqual(
            core.parse_env("PASSWORD=it's$literal\n# ignore\n"),
            {"PASSWORD": "it's$literal"},
        )
        for text in ("INVALID", "TOKEN=$(echo nope)", "TOKEN=${OTHER}", "TOKEN=`x`"):
            with self.assertRaises(ValueError):
                core.parse_env(text)

    def test_real_compose_resolution_without_starting(self):
        real_run = subprocess.run
        options = {
            "mode": "headless",
            "api_port": 19081,
            "ui_port": None,
            "online": False,
            "osrm": False,
            "autostart": False,
        }
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if "config" in args:
                return real_run(args, **kwargs)
            return subprocess.CompletedProcess(args, 0)

        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(core, "STATE", Path(temp)),
            patch.object(core.subprocess, "run", side_effect=run),
            patch.object(core.urllib.request, "urlopen") as urlopen,
        ):
            urlopen.return_value.__enter__.return_value.status = 200
            result = core.launch(
                options,
                "DISPATCHER_EMAIL=test@example.test\nDISPATCHER_PASSWORD=it's$literal\nLLM_TOKEN=private\n",
                lambda _: None,
            )
            config = json.loads((Path(temp) / "compose.json").read_text())
            self.assertEqual(result["api"], "http://localhost:19081")
            self.assertNotIn("web", config["services"])
            self.assertNotIn("osrm", config["services"])
            api = config["services"]["api"]
            self.assertEqual(api["environment"]["DISPATCHER_PASSWORD"], "it's$$literal")
            self.assertNotIn("LLM_TOKEN", api["environment"])
            self.assertNotIn("API_ROAD_API_URL", api["environment"])
            self.assertTrue(config["networks"]["default"]["internal"])
            self.assertNotIn("ports", config["services"]["postgres"])
            self.assertEqual(config["services"]["migrate"]["restart"], "no")
            resolved = real_run(
                [
                    "docker",
                    "compose",
                    "-f",
                    str(Path(temp) / "compose.json"),
                    "config",
                    "--format",
                    "json",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(resolved.returncode, 0, resolved.stderr)
            self.assertEqual(
                json.loads(resolved.stdout)["services"]["api"]["environment"][
                    "DISPATCHER_PASSWORD"
                ],
                "it's$$literal",
            )


if __name__ == "__main__":
    unittest.main()
