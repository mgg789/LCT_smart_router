"""Cached Nominatim address candidates, with explicit ambiguity and offline failure."""

import json
import os
import threading
import time
from pathlib import Path

import httpx

from core.contracts import GeoPoint
from core.geo import AddressCandidate, content_hash, normalize_address


class NominatimGeocoder:
    """Use an explicitly configured provider; no public API or paid key by default.

    Preparation returns candidates, never silently chooses an ambiguous address.
    One instance serializes network calls at no more than one per second. Deployments
    with several processes must enforce the provider's global rate limit themselves.
    """

    def __init__(
        self,
        endpoint: str,
        cache: Path,
        user_agent: str,
        *,
        dataset_version: str,
        offline: bool = True,
    ):
        """Namespace cache by source/version so changed geographic data cannot mix."""
        if not endpoint.startswith(("https://", "http://")) or not user_agent.strip():
            raise ValueError("explicit HTTP endpoint and identifying User-Agent required")
        self.endpoint = endpoint.rstrip("/")
        self.cache = cache / content_hash(f"{endpoint}:{dataset_version}".encode())
        self.user_agent = user_agent
        self.offline = offline
        self._lock = threading.Lock()
        self._last_call = 0.0

    def lookup(self, address: str) -> list[AddressCandidate]:
        """Return validated candidates; cache miss differs from a cached empty result."""
        normalized = normalize_address(address)
        if not normalized:
            raise ValueError("address must not be empty")
        key = content_hash(normalized.encode("utf-8"))
        path = self.cache / f"{key}.json"
        with self._lock:
            if path.exists():
                return [
                    AddressCandidate.model_validate(item)
                    for item in json.loads(path.read_text(encoding="utf-8"))
                ]
            if self.offline:
                raise ValueError("GEOCODE_CACHE_MISS")
            wait = 1.0 - (time.monotonic() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.monotonic()
            response = httpx.get(
                f"{self.endpoint}/search",
                params={"q": normalized, "format": "jsonv2", "limit": 5},
                headers={"User-Agent": self.user_agent},
                timeout=10.0,
            )
            response.raise_for_status()
            candidates = [
                AddressCandidate(
                    address=item["display_name"],
                    location=GeoPoint(lat=float(item["lat"]), lon=float(item["lon"])),
                    source=self.endpoint,
                )
                for item in response.json()
            ]
            self.cache.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(
                json.dumps([c.model_dump() for c in candidates], ensure_ascii=False),
                encoding="utf-8",
            )
            temporary.replace(path)
            return candidates
