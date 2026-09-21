"""Regression tests for public NAVIX environment preparation."""

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main

from prepare_navix_env import prepare_env


class PrepareNavixEnvTest(TestCase):
    """Protect fresh bootstrap and upgrade behavior."""

    def test_migrates_legacy_host_bound_api_port(self) -> None:
        """Compose receives a numeric port after upgrading the old bootstrap format."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "NODE_ENV=production\nAUTH_DEV_EXPOSE_CODES=false\n"
                "API_PORT=127.0.0.1:18080\nROUTER_PORT=18100\n",
                encoding="utf-8",
            )
            prepare_env(path)
            text = path.read_text(encoding="utf-8")
            self.assertIn("API_PORT=18080\n", text)
            self.assertNotIn("API_PORT=127.0.0.1:18080", text)

    def test_prepares_fresh_public_environment(self) -> None:
        """Fresh copies replace placeholders and disable development authentication output."""
        with TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "NODE_ENV=development\nAUTH_DEV_EXPOSE_CODES=true\nAPI_PORT=8000\n"
                "ROUTER_PORT=8100\nPOSTGRES_PASSWORD=lct_dev_password\n"
                "ROUTER_DATABASE_PASSWORD=router_dev_password\n"
                "DISPATCHER_PASSWORD=change-me-before-deploying\n",
                encoding="utf-8",
            )
            prepare_env(
                path,
                postgres_password="postgres-secret",
                router_password="router-secret",
                dispatcher_password="dispatcher-secret",
            )
            text = path.read_text(encoding="utf-8")
            self.assertIn("NODE_ENV=production", text)
            self.assertIn("AUTH_DEV_EXPOSE_CODES=false", text)
            self.assertIn("API_PORT=18080", text)
            self.assertIn("ROUTER_PORT=18100", text)
            self.assertNotIn("dev_password", text)
            self.assertNotIn("change-me-before-deploying", text)
            self.assertIn("DEMO_STAND=true\n", text)
            self.assertIn("speed_up_work_stub=1800\n", text)


if __name__ == "__main__":
    main()
