"""Native Tk integration tests for preflight, saved settings and confirmation boundaries."""

import gc
import threading
import time
import tkinter as tk
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from launch import core
from launch.gui import Launcher


class GuiTests(unittest.TestCase):
    def setUp(self):
        self.patches = ExitStack()
        self.patches.enter_context(patch.object(core, "check_integrity", return_value=[]))
        self.patches.enter_context(patch.object(core, "check_docker", return_value=(True, "ready")))
        self.patches.enter_context(patch.object(core, "check_network", return_value=False))
        self.patches.enter_context(
            patch.object(
                core,
                "installation_status",
                return_value={"status": "new", "record": None, "ports": [], "options": {}},
            )
        )
        self.patches.enter_context(patch.object(core, "saved_environment", return_value=""))
        self.patches.enter_context(
            patch.object(
                core,
                "check_version",
                return_value={
                    "status": "update_available",
                    "current": "1.6.0",
                    "latest": "1.7.0",
                    "download_url": "https://example.test/navix.zip",
                    "source": "network",
                    "checked_at": 1,
                },
            )
        )
        try:
            self.app = Launcher()
            self.app.withdraw()
        except tk.TclError as exc:
            self.patches.close()
            self.skipTest(f"A native Tk display is required: {exc}")
        self.pump(lambda: self.app._preflight_ready)

    def tearDown(self):
        if hasattr(self, "app"):
            self.app.destroy()
            del self.app
            gc.collect()
        self.patches.close()

    def pump(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate() and time.monotonic() < deadline:
            self.app.update()
            time.sleep(0.01)
        self.assertTrue(predicate(), "GUI event queue did not reach the expected state")

    def test_failed_distribution_does_not_disable_online_mode_or_hide_version_link(self):
        self.assertFalse(self.app.redis_beta.get())
        self.assertTrue(self.app.online.get())
        self.assertEqual(self.app.online_checkbox["state"], "normal")
        self.assertEqual(self.app.pin["state"], "disabled")
        self.assertEqual(str(self.app.mode["state"]), "readonly")
        self.assertIn("Доступна 1.7.0", self.app.version_var.get())
        self.assertTrue(self.app.download_button.winfo_manager())
        with patch("launch.gui.webbrowser.open") as opened:
            self.app.download_button.invoke()
            opened.assert_called_once_with("https://example.test/navix.zip")

    def test_saved_restart_and_configuration_preserve_credentials_without_displaying_password(self):
        options = dict(
            online=False, osrm=False, mode="headless", ui_port=None, api_port=19087, autostart=False,
            redis_beta=True,
        )
        env = (
            'DISPATCHER_EMAIL="operator@example.test"\nDISPATCHER_PASSWORD="saved-local-password"\n'
        )
        self.app._apply_installation(
            {"status": "stopped", "record": {"project": "navix-launch-a"}, "options": options}, env
        )
        self.assertEqual(self.app.email.get(), "operator@example.test")
        self.assertEqual(self.app.password.get(), "")
        self.assertEqual(self.app.api_port.get(), "19087")
        self.assertTrue(self.app.redis_beta.get())
        release = threading.Event()

        def launch(*args, **kwargs):
            release.wait(2)
            return {"api": "http://127.0.0.1:19087"}

        with patch.object(core, "launch", side_effect=launch) as started:
            self.app.restart_button.invoke()
            self.assertTrue(self.app._busy)
            self.assertEqual(str(self.app.start_button["state"]), "disabled")
            release.set()
            self.pump(lambda: not self.app._busy)
            self.assertEqual(started.call_args.args[0], options)
            self.assertEqual(started.call_args.args[1], env)
        self.assertNotIn("saved-local-password", self.app.log.get("1.0", "end"))

    def test_purge_cancel_never_calls_backend_and_keeps_controls_usable(self):
        preview = {"project": "navix-launch-123", "volumes": ["own-data"], "root": "fixture"}
        self.app._busy = True
        self.app._events.put(("remove_confirm", (True, preview)))
        with (
            patch("launch.gui.simpledialog.askstring", return_value="wrong"),
            patch.object(core, "remove_installation") as removed,
        ):
            self.pump(lambda: not self.app._busy)
            removed.assert_not_called()
        self.assertEqual(str(self.app.start_button["state"]), "normal")

    def test_apply_collects_changed_ports_and_keeps_stored_identity(self):
        options = dict(
            online=False, osrm=False, mode="headless", ui_port=None, api_port=19087, autostart=False
        )
        env = (
            'DISPATCHER_EMAIL="operator@example.test"\nDISPATCHER_PASSWORD="saved-local-password"\n'
        )
        self.app._apply_installation(
            {"status": "stopped", "record": {"project": "fixture"}, "options": options}, env
        )
        self.app.mode.set("full")
        self.app.redis_beta.set(True)
        self.app.ui_port.insert(0, "5195")
        self.app.api_port.delete(0, "end")
        with patch.object(core, "launch", return_value={"web": "http://127.0.0.1:5195"}) as started:
            self.app.start_button.invoke()
            self.pump(lambda: not self.app._busy)
        self.assertEqual(started.call_args.args[0]["mode"], "full")
        self.assertTrue(started.call_args.args[0]["redis_beta"])
        self.assertEqual(started.call_args.args[0]["ui_port"], 5195)
        self.assertIsNone(started.call_args.args[0]["api_port"])
        self.assertEqual(
            core.parse_env(started.call_args.args[1])["DISPATCHER_PASSWORD"], "saved-local-password"
        )


if __name__ == "__main__":
    unittest.main()
