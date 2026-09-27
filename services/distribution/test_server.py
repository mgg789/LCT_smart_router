import hashlib
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from server import App, create_server


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
