"""Verified HTTPS contexts without expired Windows cross-signs shadowing valid chains."""

import os
import ssl
import sys
import time


def https_context() -> ssl.SSLContext:
    """Keep normal TLS verification; filter only out-of-date CAs already trusted by Windows.

    Python loads both Windows ROOT and CA stores. An expired cached cross-sign
    can take precedence over the server's valid renewed certificate with the same
    subject/key. Rebuild the per-request trust set from its currently valid subset;
    never change the system store or add trust. Explicit CA overrides stay intact.
    """
    original = ssl.create_default_context()
    if sys.platform != "win32" or os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR"):
        return original
    valid = []
    excluded = False
    now = time.time()
    for der in original.get_ca_certs(binary_form=True):
        # The stdlib can decode a CA by loading it into an isolated, unused context.
        probe = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        probe.load_verify_locations(cadata=der)
        certificate = probe.get_ca_certs()[0]
        if (
            ssl.cert_time_to_seconds(certificate["notBefore"])
            <= now
            <= ssl.cert_time_to_seconds(certificate["notAfter"])
        ):
            valid.append(der)
        else:
            excluded = True
    if not excluded:
        return original
    if not valid:
        raise ssl.SSLError("No currently valid Windows CA certificates are available")
    # create_default_context retains CERT_REQUIRED, hostname checks and secure
    # protocol/cipher/verification defaults; only the existing CA subset differs.
    return ssl.create_default_context(cadata=b"".join(valid))
