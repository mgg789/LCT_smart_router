"""Launcher contract tests: no Docker containers are mutated."""

import argparse
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from launch import cli, core


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

    def test_launch_credentials_override_packaged_values(self):
        env = core.override_dispatcher_credentials(
            'DISPATCHER_EMAIL="bundled@example.test"\n'
            'DISPATCHER_PASSWORD="bundled-password"\n'
            'LLM_PROVIDER="off"\n',
            "operator@example.test",
            "launch-password",
        )
        parsed = core.parse_env(env)
        self.assertEqual(parsed["DISPATCHER_EMAIL"], "operator@example.test")
        self.assertEqual(parsed["DISPATCHER_PASSWORD"], "launch-password")
        self.assertEqual(parsed["LLM_PROVIDER"], "off")
        with self.assertRaises(ValueError):
            core.override_dispatcher_credentials(env, "operator@example.test", "short")
        with self.assertRaises(ValueError):
            core.override_dispatcher_credentials(env, "not-an-email", "launch-password")

    def test_cli_always_prompts_credentials_after_env_source(self):
        args = argparse.Namespace(
            offline=True,
            osrm=False,
            mode="full",
            api_port=8000,
            ui_port=5173,
            autostart=False,
            env="/tmp/bundled.env",
        )
        with (
            patch.object(cli.sys.stdin, "isatty", return_value=True),
            patch("builtins.input", return_value="operator@example.test"),
            patch("getpass.getpass", return_value="launch-password"),
            patch.object(core, "check_integrity", return_value=[]),
            patch.object(core, "check_docker", return_value=(True, "Docker готов")),
            patch.object(core, "check_network", return_value=False),
            patch.object(
                core,
                "read_env",
                return_value="DISPATCHER_EMAIL=bundled@example.test\nDISPATCHER_PASSWORD=bundled-password\n",
            ),
            patch.object(core, "launch", return_value={}) as launch,
        ):
            self.assertEqual(cli.run(args), 0)
        parsed = core.parse_env(launch.call_args.args[1])
        self.assertEqual(parsed["DISPATCHER_EMAIL"], "operator@example.test")
        self.assertEqual(parsed["DISPATCHER_PASSWORD"], "launch-password")

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
