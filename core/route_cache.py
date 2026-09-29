"""Redis cache for route-engine3 responses, with a growth check against a learned normal rate.

The catalog cache stays separate. This store keeps ``/route3`` and ``/matrix3`` bodies so a
replan does not repeat the same engine call. Keys are hashes: coordinates never appear in the
key. Payloads are HMAC-bound to the key. A miss, a bad signature or a Redis outage falls
through to the live call.

Growth is judged from Redis itself, so worker processes and the API process share one history.
The normal rate is the median stored body size times how many new keys appeared in the window,
plus a small overhead. Memory that keeps climbing after the key count has settled is reported
as a leak. The check does not delete data.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import statistics
import time
from pathlib import Path
from typing import Protocol
from urllib.parse import unquote, urlparse

LOGGER = logging.getLogger(__name__)
MAX_ENTRY_BYTES = 10 * 1024 * 1024
SAMPLE_GAP_SEC = 15
SAMPLE_LIMIT = 32
MIN_SAMPLES = 4
MIN_ENTRY_OBSERVATIONS = 4
OVERHEAD = 1.25
LEAK_ABS_BYTES = 2_000_000
LEAK_RATE_FACTOR = 3
LEAK_MIN_RATE = 20_000

_UNCONFIGURED = object()
_CACHE: RouteResponseCache | None | object = _UNCONFIGURED


class RouteCacheStore(Protocol):
    """The Redis surface the route cache uses. Failures are the caller's to catch."""

    def get(self, name: str) -> bytes | None: ...

    def set(self, name: str, value: bytes, *, ex: int | None = None) -> object: ...

    def delete(self, *names: str) -> int: ...

    def sadd(self, name: str, *values: str) -> int: ...

    def srem(self, name: str, *values: str) -> int: ...

    def smembers(self, name: str) -> set[bytes] | set[str]: ...

    def scard(self, name: str) -> int: ...

    def incrby(self, name: str, amount: int) -> int: ...

    def expire(self, name: str, seconds: int) -> object: ...

    def lpush(self, name: str, value: str) -> int: ...

    def ltrim(self, name: str, start: int, end: int) -> object: ...

    def lrange(self, name: str, start: int, end: int) -> list[bytes] | list[str]: ...

    def memory(self) -> dict: ...


def control_path() -> Path:
    """Durable on/off switch beside the route3 disk cache, shared by every worker."""
    return Path(os.environ.get("ROUTE3_CACHE", ".route3-cache")).parent / "route-cache-control.json"


def _read_enabled(path: Path) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return bool(payload.get("enabled", True))


def assess_growth(samples: list[dict], entry_sizes: list[int]) -> dict:
    """Compare observed Redis growth with the size of the new route-cache entries.

    ``samples`` are oldest-first ``{t, used, keys}`` points. ``entry_sizes`` are the
    bodies stored in the same period. Until both series are long enough the rates stay
    unknown and no leak is declared.
    """
    unknown = {"normal_bytes_per_sec": None, "observed_bytes_per_sec": None, "leak": None}
    if len(samples) < MIN_SAMPLES or len(entry_sizes) < MIN_ENTRY_OBSERVATIONS:
        return unknown
    start, end = samples[-MIN_SAMPLES], samples[-1]
    elapsed = float(end["t"]) - float(start["t"])
    if elapsed <= 0:
        return unknown
    normal_per_key = statistics.median(entry_sizes)
    new_keys = max(0, int(end["keys"]) - int(start["keys"]))
    expected = new_keys * normal_per_key * OVERHEAD
    observed = int(end["used"]) - int(start["used"])
    normal_rate = expected / elapsed
    observed_rate = observed / elapsed
    leak = observed > expected + LEAK_ABS_BYTES and observed_rate > max(normal_rate * LEAK_RATE_FACTOR, LEAK_MIN_RATE)
    return {
        "normal_bytes_per_sec": round(normal_rate, 1),
        "observed_bytes_per_sec": round(observed_rate, 1),
        "leak": (
            {
                "code": "CACHE_MEMORY_LEAK",
                "normal_bytes_per_sec": round(normal_rate, 1),
                "observed_bytes_per_sec": round(observed_rate, 1),
                "window_sec": round(elapsed, 1),
            }
            if leak
            else None
        ),
    }


class RouteResponseCache:
    """Process-wide handle on the shared Redis route cache."""

    def __init__(self, store: RouteCacheStore, namespace: str, secret: bytes, ttl_sec: int, state_path: Path):
        if not 1 <= ttl_sec <= 86400 or len(secret) < 16:
            raise ValueError("ROUTE_CACHE_IDENTITY_INVALID")
        self.store = store
        self.namespace = namespace
        self.secret = secret
        self.ttl_sec = ttl_sec
        self.state_path = state_path
        self._enabled = _read_enabled(state_path)
        self._state_mtime = self._mtime()
        self._last_sample = 0.0
        self.hits = 0
        self.misses = 0

    def _mtime(self) -> float | None:
        try:
            return self.state_path.stat().st_mtime
        except OSError:
            return None

    def _prefix(self, suffix: str) -> str:
        return f"navix:{self.namespace}:route3:{suffix}"

    def refresh_enabled(self) -> bool:
        """Re-read the switch when another process changed it."""
        mtime = self._mtime()
        if mtime != self._state_mtime:
            self._state_mtime = mtime
            self._enabled = _read_enabled(self.state_path)
        return self._enabled

    def _key(self, kind: str, identity: str) -> str:
        return self._prefix(f"{kind}:{identity}")

    def _signature(self, key: str, payload: bytes) -> bytes:
        return hmac.new(self.secret, key.encode() + b"\0" + payload, hashlib.sha256).hexdigest().encode()

    def _expire(self, name: str) -> None:
        """Refresh metadata TTL when the backing store supports expiry."""
        expire = getattr(self.store, "expire", None)
        if callable(expire):
            expire(name, self.ttl_sec)

    def _prune_index(self, limit: int | None = None) -> tuple[int, int]:
        """Remove expired members; optionally bound work for write-time pruning."""
        index = self._prefix("index")
        try:
            members = list(self.store.smembers(index))
        except Exception:  # noqa: BLE001
            return 0, 0
        live = 0
        total = 0
        stale = []
        if limit is not None and len(members) > limit:
            # Rotate the bounded window so a long-lived index is eventually
            # inspected in full even when traffic never reaches status().
            cursor = getattr(self, "_prune_cursor", 0) % len(members)
            members = (members + members)[cursor : cursor + limit]
            self._prune_cursor = cursor + limit
        for member in members:
            key = member.decode() if isinstance(member, bytes) else member
            try:
                raw = self.store.get(key)
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(raw, (bytes, str)):
                stale.append(member)
                continue
            payload = raw.encode() if isinstance(raw, str) else raw
            _signature, separator, body = payload.partition(b"\n")
            if not separator:
                stale.append(member)
                continue
            live += 1
            total += len(body)
        if stale:
            try:
                self.store.srem(index, *stale)
            except Exception:  # noqa: BLE001
                pass
        if limit is None:
            try:
                self.store.set(self._prefix("payload-bytes"), str(total).encode(), ex=self.ttl_sec)
                self._expire(index)
            except Exception:  # noqa: BLE001
                pass
        return live, total

    def lookup(self, kind: str, identity: str) -> dict | None:
        """Return a verified body, or None on a miss, a disabled cache or any Redis error."""
        if not self.refresh_enabled():
            return None
        key = self._key(kind, identity)
        try:
            value = self.store.get(key)
        except Exception:  # noqa: BLE001 — a cache outage must not fail the route call
            LOGGER.warning("ROUTE_CACHE_UNAVAILABLE; calling route3")
            return None
        if not isinstance(value, (bytes, str)):
            self.misses += 1
            return None
        raw = value.encode() if isinstance(value, str) else value
        signature, _, payload = raw.partition(b"\n")
        if not hmac.compare_digest(signature, self._signature(key, payload)):
            self.misses += 1
            return None
        try:
            body = json.loads(payload)
        except ValueError:
            self.misses += 1
            return None
        self.hits += 1
        return body if isinstance(body, dict) else None

    def store_body(self, kind: str, identity: str, body: dict) -> None:
        """Remember one complete engine body. Oversized and failed writes are skipped."""
        if not self.refresh_enabled():
            return
        key = self._key(kind, identity)
        payload = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        if len(payload) > MAX_ENTRY_BYTES:
            return
        value = self._signature(key, payload) + b"\n" + payload
        try:
            self._prune_index(limit=32)
            previous = self.store.get(key)
            self.store.set(key, value, ex=self.ttl_sec)
            self.store.sadd(self._prefix("index"), key)
            previous_payload = previous.partition(b"\n")[2] if isinstance(previous, bytes) else b""
            self.store.incrby(self._prefix("payload-bytes"), len(payload) - len(previous_payload))
            self._expire(self._prefix("index"))
            self._sample(len(payload))
        except Exception:  # noqa: BLE001
            LOGGER.warning("ROUTE_CACHE_WRITE_FAILED; continuing without this entry")

    def _sample(self, entry_bytes: int | None) -> None:
        now = time.time()
        if now - self._last_sample < SAMPLE_GAP_SEC:
            return
        self._last_sample = now
        try:
            self._prune_index(limit=64)
            memory = self.store.memory()
            used = int(memory.get("used_memory") or 0)
            if used <= 0:
                stored = self.store.get(self._prefix("payload-bytes"))
                used = int(stored or 0)
            point = {"t": now, "used": used, "keys": int(self.store.scard(self._prefix("index")))}
            if entry_bytes:
                point["entry"] = entry_bytes
            point = json.dumps(point)
            self.store.lpush(self._prefix("samples"), point)
            self.store.ltrim(self._prefix("samples"), 0, SAMPLE_LIMIT - 1)
        except Exception:  # noqa: BLE001
            return

    def status(self) -> dict:
        """Size, where that memory lives, the learned rate and a leak notice."""
        self._sample(None)
        enabled = self.refresh_enabled()
        try:
            memory = self.store.memory()
            used = int(memory.get("used_memory") or 0)
            payload = self.store.get(self._prefix("payload-bytes"))
            payload_bytes = int(payload or 0)
            keys, payload_bytes = self._prune_index()
            raw_samples = self.store.lrange(self._prefix("samples"), 0, SAMPLE_LIMIT - 1)
        except Exception:  # noqa: BLE001
            return _status(enabled, "redis", 0, 0, 0, assess_growth([], []), unavailable=True)
        samples = []
        sizes = []
        for item in reversed(list(raw_samples)):
            text = item.decode() if isinstance(item, bytes) else item
            try:
                point = json.loads(text)
            except ValueError:
                continue
            samples.append(point)
            if isinstance(point.get("entry"), int):
                sizes.append(point["entry"])
        if used <= 0:
            used = payload_bytes
        return _status(enabled, "redis", used, payload_bytes, keys, assess_growth(samples, sizes))

    def clear(self) -> int:
        """Drop every route-cache entry. The policy catalog is left untouched."""
        index = self._prefix("index")
        try:
            members = list(self.store.smembers(index))
            names = [item.decode() if isinstance(item, bytes) else item for item in members]
            if names:
                self.store.delete(*names)
            self.store.delete(index, self._prefix("payload-bytes"), self._prefix("samples"))
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError("ROUTE_CACHE_CLEAR_FAILED") from exc
        self._last_sample = 0.0
        return len(names)

    def set_enabled(self, enabled: bool) -> None:
        """Persist the switch for every worker and stop serving cached bodies immediately."""
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"enabled": enabled}), encoding="utf-8")
        temporary.replace(self.state_path)
        self._enabled = enabled
        self._state_mtime = self._mtime()


def _status(enabled, source, used, payload, keys, growth, unavailable=False) -> dict:
    return {
        "beta": True,
        "enabled": enabled,
        "available": not unavailable,
        "memory_source": source,
        "used_bytes": used,
        "route_payload_bytes": payload,
        "keys": keys,
        "normal_bytes_per_sec": growth["normal_bytes_per_sec"],
        "observed_bytes_per_sec": growth["observed_bytes_per_sec"],
        "leak": growth["leak"],
    }


def disk_cache_bytes() -> int:
    """Sum of the on-disk matrix cache, the fallback when Redis is not in use."""
    root = Path(os.environ.get("ROUTE3_CACHE", ".route3-cache"))
    if not root.is_dir():
        return 0
    return sum(item.stat().st_size for item in root.rglob("*.json") if item.is_file())


def install_route_cache(cache: RouteResponseCache | None) -> None:
    """Replace the process cache. Tests use this; production calls ``configured_route_cache``."""
    global _CACHE
    _CACHE = cache


def current_route_cache() -> RouteResponseCache | None:
    """The installed cache, configuring it from the environment on first use."""
    global _CACHE
    if _CACHE is _UNCONFIGURED:
        if os.environ.get("ROUTER_REDIS_BETA", "false").strip().lower() == "true":
            configured_route_cache()
        if _CACHE is _UNCONFIGURED:
            _CACHE = None
    return _CACHE if isinstance(_CACHE, RouteResponseCache) else None


def route_cache_status() -> dict:
    """Status for the settings screen, including the disk fallback when Redis is off."""
    cache = current_route_cache()
    if cache is None:
        disk = disk_cache_bytes()
        return _status(False, "disk" if disk else "none", disk, disk, 0, assess_growth([], []))
    return cache.status()


def clear_route_cache() -> dict:
    cache = current_route_cache()
    if cache is None:
        raise RuntimeError("ROUTE_CACHE_DISABLED")
    cache.clear()
    return cache.status()


def set_route_cache_enabled(enabled: bool) -> dict:
    cache = current_route_cache()
    if cache is None:
        raise RuntimeError("ROUTE_CACHE_DISABLED")
    cache.set_enabled(enabled)
    return cache.status()


def configured_route_cache() -> RouteResponseCache | None:
    """Build the cache when Redis-beta is on. A bad configuration disables it, not planning."""
    if os.environ.get("ROUTER_REDIS_BETA", "false").strip().lower() != "true":
        return None
    try:
        from redis import Redis
        from redis.backoff import NoBackoff
        from redis.exceptions import RedisError
        from redis.retry import Retry
    except ImportError:
        LOGGER.warning("ROUTE_CACHE_CLIENT_UNAVAILABLE")
        return None
    try:
        url = os.environ.get("ROUTER_REDIS_URL", "")
        parsed = urlparse(url)
        if parsed.scheme not in ("redis", "rediss") or not parsed.hostname:
            raise ValueError("ROUTE_CACHE_URL_INVALID")
        secret = unquote(parsed.password or "").encode()
        namespace = os.environ.get("ROUTER_REDIS_NAMESPACE", "")
        ttl_sec = int(os.environ.get("ROUTER_REDIS_TTL_SEC", "900"))
        client = Redis.from_url(
            url,
            decode_responses=False,
            socket_connect_timeout=0.15,
            socket_timeout=0.25,
            retry=Retry(NoBackoff(), 0),
            health_check_interval=30,
            max_connections=8,
            protocol=2,
        )
        cache = RouteResponseCache(RedisRouteStore(client), namespace, secret, ttl_sec, control_path())
    except (ValueError, TypeError, RedisError):
        LOGGER.warning("ROUTE_CACHE_CONFIGURATION_INVALID")
        return None
    install_route_cache(cache)
    return cache


class RedisRouteStore:
    """Adapter from redis-py to ``RouteCacheStore``."""

    def __init__(self, client):
        self.client = client

    def get(self, name: str):
        return self.client.get(name)

    def set(self, name: str, value: bytes, *, ex: int | None = None):
        return self.client.set(name, value, ex=ex)

    def delete(self, *names: str) -> int:
        return int(self.client.delete(*names)) if names else 0

    def sadd(self, name: str, *values: str) -> int:
        return int(self.client.sadd(name, *values))

    def srem(self, name: str, *values: str) -> int:
        return int(self.client.srem(name, *values)) if values else 0

    def smembers(self, name: str):
        return self.client.smembers(name)

    def scard(self, name: str) -> int:
        return int(self.client.scard(name))

    def incrby(self, name: str, amount: int) -> int:
        return int(self.client.incrby(name, amount))

    def expire(self, name: str, seconds: int):
        return self.client.expire(name, seconds)

    def lpush(self, name: str, value: str) -> int:
        return int(self.client.lpush(name, value))

    def ltrim(self, name: str, start: int, end: int):
        return self.client.ltrim(name, start, end)

    def lrange(self, name: str, start: int, end: int):
        return self.client.lrange(name, start, end)

    def memory(self) -> dict:
        info = self.client.info("memory")
        return {
            "used_memory": int(info.get("used_memory", 0)),
            "used_memory_rss": int(info.get("used_memory_rss", 0)),
            "maxmemory": int(info.get("maxmemory", 0)),
        }
