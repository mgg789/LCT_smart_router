"""Version checks distinguish release precedence, stale cache and unavailable services."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from launch import versions


class VersionTests(unittest.TestCase):
    def test_development_checkout_is_not_mislabeled_as_a_stable_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "launch").mkdir()
            (root / "launch/release.json").write_text('{"version":"1.7.0","channel":"development"}')
            with patch.object(versions.urllib.request, "urlopen") as opened:
                opened.return_value.__enter__.return_value.read.return_value = json.dumps(
                    {
                        "schema_version": 1,
                        "version": "1.7.0",
                        "download_url": "https://example.test/release.zip",
                    }
                ).encode()
                result = versions.check(root, root / ".launch", "https://distribution.test")
            self.assertEqual(result["status"], "development")
            self.assertNotIn("актуальный релиз", versions.message(result))
            self.assertIn("Сборка разработки", versions.message(result))

    def test_version_precedence(self):
        for older, newer in (
            ("v1.7", "1.8.0"),
            ("1.9.0", "1.10.0"),
            ("1.7.0-dev", "1.7.0"),
            ("1.7.0-rc.2", "1.7.0-rc.10"),
        ):
            self.assertLess(versions.compare(older, newer), 0)
            self.assertGreater(versions.compare(newer, older), 0)
        self.assertEqual(versions.compare("v1.7", "1.7.0+build.3"), 0)
        for invalid in ("1.7.0-rc..2", "1.7.0-rc.02", "1.7.0-", "release"):
            with self.assertRaises(ValueError):
                versions.parse_version(invalid)

    def test_public_check_caches_a_release_and_labels_failed_reads_as_old_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "launch").mkdir()
            (root / "launch/release.json").write_text('{"version":"1.6.0"}')
            release = {
                "schema_version": 1,
                "version": "1.7.0",
                "download_url": "https://example.test/navix.zip",
            }
            with patch.object(versions.urllib.request, "urlopen") as opened:
                opened.return_value.__enter__.return_value.read.return_value = json.dumps(
                    release
                ).encode()
                result = versions.check(root, root / ".launch", "https://distribution.test")
                self.assertEqual(result["status"], "update_available")
                self.assertEqual(result["source"], "network")
                request = opened.call_args.args[0]
                self.assertTrue(request.full_url.endswith("/navix/version"))
                self.assertIsNone(request.data)
            with patch.object(versions.urllib.request, "urlopen", side_effect=OSError):
                stale = versions.check(root, root / ".launch", "https://distribution.test")
            self.assertEqual(stale["source"], "cache")
            self.assertIn("сведения из проверки", versions.message(stale))
            with patch.object(versions.urllib.request, "urlopen") as opened:
                offline = versions.check(
                    root, root / ".launch", "https://distribution.test", online=False
                )
                opened.assert_not_called()
            self.assertEqual(offline["latest"], "1.7.0")
            self.assertEqual(
                versions.check(root, root / ".launch", "https://another.test", online=False)[
                    "status"
                ],
                "unavailable",
            )

    def test_malformed_or_unsafe_metadata_does_not_block_launch_or_replace_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "launch").mkdir()
            for raw in (
                b"not-json",
                b"x" * 8193,
                json.dumps(
                    {"schema_version": 1, "version": "1.7", "download_url": "javascript:alert(1)"}
                ).encode(),
            ):
                with patch.object(versions.urllib.request, "urlopen") as opened:
                    opened.return_value.__enter__.return_value.read.return_value = raw
                    result = versions.check(root, root / ".launch", "https://distribution.test")
                self.assertEqual(result["status"], "unavailable")
                self.assertIn("запуск можно продолжить", versions.message(result))
                self.assertFalse((root / ".launch/version-cache.json").exists())


if __name__ == "__main__":
    unittest.main()
