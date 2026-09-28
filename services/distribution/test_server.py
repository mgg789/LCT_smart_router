import hashlib
import http.client
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from services.distribution.server import App, configured_release, create_server


class TestApp(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        p = Path(self.d.name) / "x"
        p.write_bytes(b"x")
        os.environ.update(
            NAVIX_PIN_SHA256=hashlib.sha256(b"123456").hexdigest(),
            NAVIX_IP_HMAC_KEY="test-key-at-least-16-bytes",
            NAVIX_PAYLOAD_PATH=str(p),
            NAVIX_STATS_DB=str(Path(self.d.name) / "s"),
            NAVIX_DISTRIBUTION_OPEN="true",
        )
        self.a = App()

    def tearDown(self):
        self.d.cleanup()

    def test_rate_limit(self):
        ip = self.a.ip("127.0.0.1")
        for _ in range(self.a.limit):
            self.assertTrue(self.a.reserve_attempt(ip))
        self.assertFalse(self.a.reserve_attempt(ip))

    def test_public_version_is_available_when_private_distribution_is_closed(self):
        self.a.open = False
        self.a.release = {
            "schema_version": 1,
            "version": "1.7.0",
            "download_url": "https://example.test/navix.zip",
        }
        server = create_server(self.a, ("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            connection = http.client.HTTPConnection(*server.server_address, timeout=2)
            connection.request("GET", "/navix/version")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), self.a.release)
            connection.close()
            self.a.release = None
            connection = http.client.HTTPConnection(*server.server_address, timeout=2)
            connection.request("GET", "/navix/version")
            response = connection.getresponse()
            self.assertEqual(response.status, 503)
            self.assertEqual(json.loads(response.read()), {"error": "release_not_configured"})
            connection.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_release_config_does_not_accept_credentials_or_executable_urls(self):
        for url in ("javascript:run()", "https://user:secret@example.test/file"):
            with patch.dict(os.environ, {"NAVIX_LATEST_VERSION": "1.7", "NAVIX_DOWNLOAD_URL": url}):
                with self.assertRaises(ValueError):
                    configured_release()

    def test_invalid_release_metadata_does_not_disable_the_private_service(self):
        with patch.dict(
            os.environ,
            {
                "NAVIX_LATEST_VERSION": "invalid",
                "NAVIX_DOWNLOAD_URL": "https://example.test/release.zip",
            },
        ):
            app = App()
        self.assertIsNone(app.release)
        self.assertTrue(app.open)
        self.assertTrue(app.payload.is_file())

    def test_http_runtime(self):
        server = create_server(self.a, ("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:

            def post(value):
                c = http.client.HTTPConnection(*server.server_address, timeout=2)
                raw = json.dumps(value).encode()
                c.request(
                    "POST",
                    "/navix/data",
                    raw,
                    {
                        "Content-Type": "application/json",
                        "Content-Length": str(len(raw)),
                    },
                )
                r = c.getresponse()
                body = r.read()
                c.close()
                return r.status, body

            self.assertEqual(post([])[0], 401)
            self.assertEqual(post({"pin": "000000"})[0], 401)
            status, body = post({"pin": "123456"})
            self.assertEqual(status, 200)
            self.assertEqual(body, b"x")
            self.a.open = False
            self.assertEqual(post({"pin": "123456"})[0], 403)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
