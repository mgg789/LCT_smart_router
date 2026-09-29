"""Time and size of the Redis route-response cache against a live route-engine3.

The script does not start containers. Point it at a running engine and a Redis that
this process can flush a private namespace on. It prints cold HTTP time, warm cache
time and the bytes Redis kept. Passwords stay in the environment and are not printed.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from core.contracts import GeoPoint
from core.route3 import Route3Client
from core.route_cache import configured_route_cache, install_route_cache

PAIRS = (
    (GeoPoint(lat=55.6997977, lon=37.7725762), GeoPoint(lat=55.7173273, lon=37.7266148), "car"),
    (GeoPoint(lat=55.7173273, lon=37.7266148), GeoPoint(lat=55.7144711, lon=37.7695221), "car"),
    (GeoPoint(lat=55.7118436, lon=37.7708367), GeoPoint(lat=55.7397743, lon=37.6599082), "walk"),
    (GeoPoint(lat=55.7397743, lon=37.6599082), GeoPoint(lat=55.6981178, lon=37.7786035), "transit"),
    (GeoPoint(lat=55.6981178, lon=37.7786035), GeoPoint(lat=55.7431752, lon=37.6878434), "transit"),
    (GeoPoint(lat=55.7431752, lon=37.6878434), GeoPoint(lat=55.7217574, lon=37.7907198), "walk"),
)


def _elapsed(client: Route3Client) -> float:
    started = time.perf_counter()
    for origin, destination, profile in PAIRS:
        client.route(
            origin,
            destination,
            profile,
            traffic=profile == "car",
            metro=profile == "transit",
            departure=1_790_663_400,
        )
    return time.perf_counter() - started


def main() -> None:
    base = os.environ["ROUTE3_URL"]
    cache = configured_route_cache()
    if cache is None:
        raise SystemExit("Redis route cache is not configured")
    before = int(cache.store.memory().get("used_memory") or 0)
    client = Route3Client(base, cache_dir=Path(os.environ.get("ROUTE3_CACHE", ".route3-cache")))
    cache.set_enabled(False)
    cold = _elapsed(client)
    cache.set_enabled(True)
    filled = _elapsed(client)
    warm = _elapsed(client)
    after = int(cache.store.memory().get("used_memory") or 0)
    status = cache.status()
    saved = cold - warm
    print(f"pairs {len(PAIRS)}")
    print(f"cold_http_sec {cold:.3f}")
    print(f"fill_sec {filled:.3f}")
    print(f"warm_redis_sec {warm:.3f}")
    print(f"saved_sec {saved:.3f}")
    print(f"saved_ratio {cold / warm if warm else 0:.1f}")
    print(f"used_memory_before {before}")
    print(f"used_memory_after {after}")
    print(f"used_memory_delta {after - before}")
    print(f"route_payload_bytes {status['route_payload_bytes']}")
    print(f"keys {status['keys']}")
    install_route_cache(None)


if __name__ == "__main__":
    main()
