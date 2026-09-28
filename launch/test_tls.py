"""Windows stale cross-sign regression without changing trust or weakening peer verification."""

import ssl
import unittest
from unittest.mock import Mock, call, patch

from launch import tls


class TlsTests(unittest.TestCase):
    def test_actual_context_always_requires_peer_certificate_and_hostname(self):
        context = tls.https_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        standard = ssl.create_default_context()
        self.assertEqual(context.minimum_version, standard.minimum_version)
        self.assertEqual(context.verify_flags, standard.verify_flags)

    def test_expired_windows_cross_sign_is_excluded_but_no_new_trust_is_added(self):
        original, rebuilt = Mock(), Mock()
        original.get_ca_certs.return_value = [b"valid-root", b"expired-cross-sign"]
        valid, expired = Mock(), Mock()
        valid.get_ca_certs.return_value = [
            {"notBefore": "Jan  1 00:00:00 2020 GMT", "notAfter": "Jan  1 00:00:00 2035 GMT"}
        ]
        expired.get_ca_certs.return_value = [
            {"notBefore": "Jan  1 00:00:00 2020 GMT", "notAfter": "Jan  1 00:00:00 2025 GMT"}
        ]
        with (
            patch.object(tls.sys, "platform", "win32"),
            patch.dict(tls.os.environ, {}, clear=True),
            patch.object(tls.time, "time", return_value=1_790_596_800),
            patch.object(
                tls.ssl, "create_default_context", side_effect=[original, rebuilt]
            ) as factory,
            patch.object(tls.ssl, "SSLContext", side_effect=[valid, expired]),
        ):
            self.assertIs(tls.https_context(), rebuilt)
        self.assertEqual(factory.call_args_list, [call(), call(cadata=b"valid-root")])
        original.get_ca_certs.assert_called_once_with(binary_form=True)

    def test_explicit_operator_trust_bundle_is_preserved(self):
        with (
            patch.object(tls.sys, "platform", "win32"),
            patch.dict(tls.os.environ, {"SSL_CERT_FILE": "operator-bundle.pem"}),
            patch.object(tls.ssl, "create_default_context") as factory,
        ):
            self.assertIs(tls.https_context(), factory.return_value)
            factory.return_value.get_ca_certs.assert_not_called()

    def test_all_expired_trust_fails_closed(self):
        original, expired = Mock(), Mock()
        original.get_ca_certs.return_value = [b"expired"]
        expired.get_ca_certs.return_value = [
            {"notBefore": "Jan  1 00:00:00 2020 GMT", "notAfter": "Jan  1 00:00:00 2025 GMT"}
        ]
        with (
            patch.object(tls.sys, "platform", "win32"),
            patch.dict(tls.os.environ, {}, clear=True),
            patch.object(tls.time, "time", return_value=1_790_596_800),
            patch.object(tls.ssl, "create_default_context", return_value=original),
            patch.object(tls.ssl, "SSLContext", return_value=expired),
        ):
            with self.assertRaises(ssl.SSLError):
                tls.https_context()


if __name__ == "__main__":
    unittest.main()
