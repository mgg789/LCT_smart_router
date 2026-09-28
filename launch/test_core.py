"""Launcher contract tests: no Docker containers are mutated."""

import argparse
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from launch import cli, core, update_manifest


class CoreTests(unittest.TestCase):
    def test_manifest_excludes_local_tool_ledgers_from_portable_packages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in (
                "launch/entry.py",
                "apps/api/app.ts",
                "apps/api/.mimosa/ledger.json",
                "infra/docker-compose.yml",
                "package.json",
                "pnpm-lock.yaml",
                "pnpm-workspace.yaml",
            ):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture\n")
            with (
                patch.object(update_manifest, "root", root),
                patch("sys.argv", ["update_manifest"]),
            ):
                update_manifest.main()
            manifest = json.loads((root / "launch/manifest.json").read_text())
            self.assertIn("apps/api/app.ts", manifest)
            self.assertNotIn("apps/api/.mimosa/ledger.json", manifest)

    def test_missing_or_unresponsive_docker_has_a_concise_diagnostic(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired(["docker"], 20)):
            with patch.object(core.subprocess, "run", side_effect=error):
                ready, message = core.check_docker()
            self.assertFalse(ready)
            self.assertIn("Docker", message)

    def test_image_identity_changes_with_app_code_but_not_launcher_dialogs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "launch").mkdir()
            (root / "app.py").write_text("version=1\n")
            (root / "launch/gui.py").write_text("caption='first'\n")
            (root / "launch/manifest.json").write_text(
                json.dumps({"app.py": "unused", "launch/gui.py": "unused"})
            )
            with patch.object(core, "ROOT", root):
                original = core.package_fingerprint()
                (root / "launch/gui.py").write_text("caption='second'\n")
                self.assertEqual(original, core.package_fingerprint())
                (root / "app.py").write_text("version=2\n")
                self.assertNotEqual(original, core.package_fingerprint())

    def test_integrity_accepts_windows_line_endings_but_rejects_content_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "launch").mkdir()
            text = b"print('Navix')\n"
            (root / "launch/entry.py").write_bytes(text.replace(b"\n", b"\r\n"))
            (root / "launch/manifest.json").write_text(
                json.dumps(
                    {
                        "launch/entry.py": hashlib.sha256(text).hexdigest(),
                    }
                )
            )
            with patch.object(core, "ROOT", root):
                self.assertEqual(core.check_integrity(), [])
                (root / "launch/entry.py").write_text("changed\n")
                self.assertEqual(core.check_integrity(), ["launch/entry.py"])

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
        self.assertEqual(core.parse_env("speed_up_work_stub=1800"), {"speed_up_work_stub": "1800"})
        self.assertEqual(
            core.parse_env("PASSWORD=it's$literal\n# ignore\n"),
            {"PASSWORD": "it's$literal"},
        )
        for text in ("INVALID", "TOKEN=$(echo nope)", "TOKEN=${OTHER}", "TOKEN=`x`"):
            with self.assertRaises(ValueError):
                core.parse_env(text)

    def test_corrupt_manifest_is_a_recoverable_diagnostic(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "launch").mkdir()
            for text in ("{broken", "[]", '{"../private-file": "' + "a" * 64 + '"}'):
                (root / "launch/manifest.json").write_text(text)
                with patch.object(core, "ROOT", root):
                    self.assertEqual(core.check_integrity(), ["launch/manifest.json"])

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
            redis_beta=False,
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

    def test_configuration_can_enable_online_after_an_offline_installation(self):
        args = cli.build_parser().parse_args(
            [
                "--action",
                "configure",
                "--mode",
                "full",
                "--api-port",
                "19087",
                "--ui-port",
                "5195",
                "--no-osrm",
                "--no-autostart",
                "--no-redis-beta",
                "--env",
                "fixture.env",
            ]
        )
        saved = "DISPATCHER_EMAIL=operator@example.test\nDISPATCHER_PASSWORD=saved-password\n"
        version = {
            "status": "unavailable",
            "current": "1.7.0",
            "latest": None,
            "source": "none",
            "checked_at": None,
        }
        with (
            patch.object(cli.sys.stdin, "isatty", return_value=True),
            patch.object(core, "check_integrity", return_value=[]),
            patch.object(core, "check_docker", return_value=(True, "ready")),
            patch.object(core, "check_network", return_value=False),
            patch.object(core, "check_version", return_value=version),
            patch.object(
                core,
                "installation_status",
                return_value={"record": {"project": "fixture"}, "options": {"online": False}},
            ),
            patch.object(core, "saved_environment", return_value=saved),
            patch.object(core, "read_env", return_value=saved),
            patch("builtins.input", side_effect=["yes", ""]),
            patch("getpass.getpass", return_value=""),
            patch.object(core, "launch", return_value={}) as launched,
        ):
            self.assertEqual(cli.run(args), 0)
        self.assertTrue(launched.call_args.args[0]["online"])
        self.assertEqual(
            core.parse_env(launched.call_args.args[1])["DISPATCHER_PASSWORD"], "saved-password"
        )

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
            return subprocess.CompletedProcess(args, 0, stdout="")

        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(core, "STATE", Path(temp)),
            patch.object(core.subprocess, "run", side_effect=run),
            patch.object(core.urllib.request, "build_opener") as opener,
        ):
            opener.return_value.open.return_value.__enter__.return_value.status = 200
            result = core.launch(
                options,
                "DISPATCHER_EMAIL=test@example.test\nDISPATCHER_PASSWORD=it's$буквы\nLLM_TOKEN=private\n",
                lambda _: None,
            )
            config = json.loads((Path(temp) / "compose.json").read_text())
            self.assertEqual(result["api"], "http://127.0.0.1:19081")
            self.assertNotIn("web", config["services"])
            self.assertNotIn("osrm", config["services"])
            self.assertNotIn("route-engine3", config["services"])
            self.assertEqual(config["services"]["router"]["environment"]["ROUTER_HYBRID"], "false")
            self.assertNotIn("redis", config["services"])
            self.assertEqual(
                config["services"]["router"]["environment"]["ROUTER_REDIS_BETA"], "false"
            )
            api = config["services"]["api"]
            self.assertEqual(api["environment"]["DISPATCHER_PASSWORD"], "it's$$буквы")
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
                "it's$$буквы",
            )

    def test_redis_failure_is_optional_and_credentials_survive_switching_modes(self):
        real_run = subprocess.run
        calls, messages = [], []
        options = dict(
            mode="headless",
            api_port=19081,
            ui_port=None,
            online=True,
            osrm=False,
            autostart=False,
            redis_beta=True,
        )

        def run(args, **kwargs):
            calls.append(args)
            if "config" in args:
                return real_run(args, **kwargs)
            failed = "up" in args and args[-1] == "redis"
            return subprocess.CompletedProcess(args, 1 if failed else 0, stdout="")

        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(core, "STATE", Path(temp)),
            patch.object(core.subprocess, "run", side_effect=run),
            patch.object(core.urllib.request, "build_opener") as opener,
        ):
            opener.return_value.open.return_value.__enter__.return_value.status = 200
            env = "DISPATCHER_EMAIL=test@example.test\nDISPATCHER_PASSWORD=fixture-password\n"
            core.launch(options, env, messages.append)
            config = json.loads((Path(temp) / "compose.json").read_text())
            identity = json.loads((Path(temp) / "identity.json").read_text())
            redis = config["services"]["redis"]
            self.assertNotIn("ports", redis)
            self.assertEqual(redis["environment"]["REDIS_PASSWORD"], identity["REDIS_PASSWORD"])
            router = config["services"]["router"]
            self.assertEqual(router["environment"]["ROUTER_REDIS_BETA"], "true")
            self.assertIn(identity["REDIS_PASSWORD"], router["environment"]["ROUTER_REDIS_URL"])
            self.assertNotIn("redis", router.get("depends_on", {}))
            self.assertFalse(
                any(
                    key.startswith("ROUTER_REDIS") or key == "REDIS_PASSWORD"
                    for key in config["services"]["api"]["environment"]
                )
            )
            self.assertTrue(any("Redis-beta недоступен" in message for message in messages))
            self.assertTrue(
                all(
                    "redis" not in args[args.index("up") + 1 :]
                    for args in calls
                    if "up" in args and "--wait" in args
                )
            )
            namespace = router["environment"]["ROUTER_REDIS_NAMESPACE"]
            core.launch({**options, "redis_beta": False}, env, messages.append)
            self.assertNotIn(
                "redis", json.loads((Path(temp) / "compose.json").read_text())["services"]
            )
            core.launch(options, env, messages.append)
            self.assertEqual(identity, json.loads((Path(temp) / "identity.json").read_text()))
            self.assertEqual(
                namespace,
                json.loads((Path(temp) / "compose.json").read_text())["services"]["router"][
                    "environment"
                ]["ROUTER_REDIS_NAMESPACE"],
            )


if __name__ == "__main__":
    unittest.main()
