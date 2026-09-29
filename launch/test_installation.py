"""Data preservation, installation isolation, interruption and operation-lock regressions."""

import json
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from launch import core, installation


class InstallationTests(unittest.TestCase):
    def test_docker_nat_port_is_rejected_even_when_windows_socket_bind_succeeds(self):
        with (
            patch.object(core.socket, "socket"),
            patch.object(
                installation,
                "docker_read",
                return_value="0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\n127.0.0.1:9000-9001->9000-9001/tcp",
            ),
        ):
            for port in (5432, 9001):
                with self.assertRaisesRegex(ValueError, "другим контейнером"):
                    core.check_ports({"mode": "headless", "api_port": port}, [])
            core.check_ports({"mode": "headless", "api_port": 5432}, [5432])

    def test_two_clean_directories_get_different_persistent_projects(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            a = installation.ensure(root / "a/.launch", root / "a")
            b = installation.ensure(root / "b/.launch", root / "b")
            self.assertNotEqual(a["project"], b["project"])
            self.assertEqual(installation.ensure(root / "a/.launch", root / "a"), a)
            with self.assertRaisesRegex(ValueError, "другой папке"):
                installation.load(root / "a/.launch", root / "b")

    def test_lock_is_released_after_failure_but_rejects_a_second_operation(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            with installation.operation(state):
                with self.assertRaisesRegex(ValueError, "другой лаунчер"):
                    with installation.operation(state):
                        self.fail("Concurrent mutation acquired the lock")
            with installation.operation(state):
                pass

    def test_occupied_port_is_reported_before_creating_an_installation(self):
        with tempfile.TemporaryDirectory() as temp, socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            options = dict(
                mode="headless",
                api_port=occupied.getsockname()[1],
                ui_port=None,
                online=False,
                osrm=False,
                autostart=False,
            )
            with patch.object(core, "STATE", Path(temp) / ".launch"):
                with self.assertRaisesRegex(ValueError, "Порт .* занят"):
                    core.launch(
                        options,
                        "DISPATCHER_EMAIL=test@example.test\nDISPATCHER_PASSWORD=fixture-password",
                    )
                self.assertFalse((core.STATE / "installation.json").exists())

    def test_interrupted_preparation_keeps_identity_and_is_recoverable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / ".launch"
            installation.private_write(
                state / "identity.json", '{"POSTGRES_PASSWORD":"fixture-database-secret"}'
            )
            options = dict(
                mode="headless",
                api_port=19087,
                ui_port=None,
                online=False,
                osrm=False,
                autostart=False,
            )
            with (
                patch.object(core, "ROOT", root),
                patch.object(core, "STATE", state),
                patch.object(core, "check_ports"),
                patch.object(installation, "docker_read", return_value=""),
            ):
                with patch.object(core, "_launch", side_effect=KeyboardInterrupt):
                    with self.assertRaises(KeyboardInterrupt):
                        core.launch(
                            options,
                            "DISPATCHER_EMAIL=test@example.test\nDISPATCHER_PASSWORD=fixture-password",
                        )
                failed = installation.load(state, root)
                self.assertEqual(failed["phase"], "interrupted")
                self.assertEqual(core.installation_status()["status"], "partial")
                with patch.object(core, "_launch", return_value={"api": "http://127.0.0.1:19087"}):
                    core.launch(
                        options,
                        "DISPATCHER_EMAIL=test@example.test\nDISPATCHER_PASSWORD=fixture-password",
                    )
                self.assertEqual(installation.load(state, root)["id"], failed["id"])
                self.assertEqual(
                    installation.read_json(state / "identity.json")["POSTGRES_PASSWORD"],
                    "fixture-database-secret",
                )

    def test_legacy_adoption_recovers_choices_and_never_replaces_database_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / ".launch"
            installation.private_write(state / "identity.json", '{"POSTGRES_PASSWORD":"keep-this"}')
            config = {
                "name": "navix-launch",
                "services": {
                    "api": {"ports": [{"published": "19087"}]},
                    "router": {"restart": "no"},
                },
                "networks": {"default": {"internal": True}},
            }
            installation.private_write(state / "active.json", json.dumps(config))
            record = installation.ensure(state, root)
            self.assertEqual(record["project"], "navix-launch")
            self.assertEqual(record["options"]["api_port"], 19087)
            self.assertFalse(record["options"]["online"])
            self.assertEqual(
                installation.read_json(state / "identity.json")["POSTGRES_PASSWORD"], "keep-this"
            )

    def test_foreign_resource_prevents_any_removal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / ".launch"
            record = installation.ensure(state, root)
            foreign = {
                "labels": {
                    installation.PROJECT_LABEL: record["project"],
                    installation.OWNER_LABEL: "foreign",
                    installation.ROOT_LABEL: record["root"],
                },
                "state": {"Running": True},
                "ports": {},
            }
            with (
                patch.object(core, "ROOT", root),
                patch.object(core, "STATE", state),
                patch.object(
                    installation, "docker_read", side_effect=["container-id", json.dumps(foreign)]
                ),
                patch.object(core.subprocess, "run") as run,
            ):
                with self.assertRaisesRegex(ValueError, "другой установке"):
                    core.remove_installation()
                run.assert_not_called()

    def test_default_removal_keeps_data_and_purge_requires_project_specific_confirmation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / ".launch"
            record = installation.ensure(state, root)
            installation.private_write(state / "identity.json", '{"POSTGRES_PASSWORD":"keep-this"}')
            installation.private_write(
                state / "settings.env", 'DISPATCHER_EMAIL="test@example.test"\n'
            )
            installation.private_write(
                state / "active.json",
                json.dumps({"volumes": {"postgres-data": {"name": "own-volume"}}}),
            )
            status = {"record": record, "status": "stopped", "options": {}, "ports": []}
            with (
                patch.object(core, "ROOT", root),
                patch.object(core, "STATE", state),
                patch.object(core, "installation_status", return_value=status),
                patch.object(installation, "owned_volumes", return_value=["own-volume"]),
                patch.object(
                    core.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
                ) as run,
            ):
                core.remove_installation(log=lambda _: None)
                self.assertNotIn("--volumes", run.call_args.args[0])
                self.assertTrue((state / "identity.json").exists())
                self.assertEqual(installation.load(state, root)["phase"], "removed")
                run.reset_mock()
                with self.assertRaisesRegex(ValueError, "DELETE"):
                    core.remove_installation(purge_data=True, confirmation="yes")
                run.assert_not_called()
                core.remove_installation(
                    purge_data=True, confirmation=f"DELETE {record['project']}", log=lambda _: None
                )
                self.assertEqual(run.call_args.args[0], ["docker", "volume", "rm", "own-volume"])
                self.assertFalse((state / "identity.json").exists())
                self.assertFalse((state / "installation.json").exists())


if __name__ == "__main__":
    unittest.main()
