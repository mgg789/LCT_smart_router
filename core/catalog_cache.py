"""Optional Redis cache for immutable read-only policy catalogs, never active plans."""

import hashlib
import hmac
import json
import logging
import os
import platform
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Protocol
from urllib.parse import unquote, urlparse

from core.contracts import Plan, PolicyComparison

LOGGER = logging.getLogger(__name__)
MAX_ENTRY_BYTES = 10 * 1024 * 1024
CATALOG_IDS = {"fast", "compact", "sla", "balanced", "eco", "covering", "baseline"}


class CacheClient(Protocol):
    """The small synchronous Redis surface used by the catalog cache."""

    def get(self, name: str) -> object: ...

    def set(self, name: str, value: bytes, *, ex: int) -> object: ...

    def close(self) -> None: ...


@lru_cache(maxsize=1)
def code_version() -> str:
    """Invalidate after engine/schema/dependency changes, including non-launcher deployments."""
    root = Path(__file__).parent
    digest = hashlib.sha256(platform.python_version().encode())
    for path in sorted([*root.glob("*.py"), root / "requirements.txt"]):
        digest.update(path.name.encode())
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()[:20]


class RedisCatalogCache:
    """Bounded, expiring cache-aside storage with exact input identity and payload integrity."""

    def __init__(
        self,
        client: CacheClient,
        namespace: str,
        secret: bytes,
        ttl_sec: int = 600,
        *,
        connection_errors: tuple[type[Exception], ...] = (OSError,),
    ):
        if not re.fullmatch(r"[A-Za-z0-9:_-]{1,100}", namespace) or len(secret) < 16:
            raise ValueError("REDIS_BETA_IDENTITY_INVALID")
        if not 1 <= ttl_sec <= 86400:
            raise ValueError("REDIS_BETA_TTL_INVALID")
        self.client = client
        self.namespace = namespace
        self.secret = secret
        self.ttl_sec = ttl_sec
        self.connection_errors = connection_errors
        self.stats = {
            "hits": 0,
            "misses": 0,
            "errors": 0,
            "invalid": 0,
            "writes": 0,
            "oversized": 0,
        }
        self._last_warning = float("-inf")

    def key(
        self, publication_id: str, input_hash: str, context: str, budget_ms: int, scope: str = ""
    ) -> str:
        """Include publication, exact bytes, routing context and search budget; names never contain PII."""
        identity = json.dumps(
            [publication_id, input_hash, context, budget_ms, scope], separators=(",", ":")
        )
        return f"navix:{self.namespace}:catalog-v1:{code_version()}:{hashlib.sha256(identity.encode()).hexdigest()}"

    def _signature(self, key: str, payload: bytes) -> bytes:
        return (
            hmac.new(self.secret, key.encode() + b"\0" + payload, hashlib.sha256)
            .hexdigest()
            .encode()
        )

    def _warning(self, kind: str) -> None:
        # URLs, passwords, keys and cached task data must not enter logs.
        if time.monotonic() - self._last_warning >= 30:
            LOGGER.warning("REDIS_BETA_%s; using ordinary catalog calculation", kind)
            self._last_warning = time.monotonic()

    def get(
        self, publication_id: str, input_hash: str, context: str, budget_ms: int, scope: str = ""
    ) -> tuple[PolicyComparison, dict[str, Plan]] | None:
        """Return an authenticated same-input catalog or a cache miss; failures never stop planning."""
        key = self.key(publication_id, input_hash, context, budget_ms, scope)
        try:
            value = self.client.get(key)
        except self.connection_errors:
            self.stats["errors"] += 1
            self.stats["misses"] += 1
            self._warning("UNAVAILABLE")
            return None
        if value is None:
            self.stats["misses"] += 1
            return None
        try:
            if not isinstance(value, bytes) or len(value) > MAX_ENTRY_BYTES:
                raise ValueError("CACHE_SIZE_INVALID")
            signature, payload = value.split(b"\n", 1)
            if not hmac.compare_digest(signature, self._signature(key, payload)):
                raise ValueError("CACHE_SIGNATURE_INVALID")
            document = json.loads(payload)
            if not isinstance(document, dict) or document.get("schema_version") != 1:
                raise ValueError("CACHE_SCHEMA_INVALID")
            comparison = PolicyComparison.model_validate(document["comparison"])
            plans = {name: Plan.model_validate(plan) for name, plan in document["plans"].items()}
            if (
                comparison.input_publication_id != publication_id
                or comparison.input_hash != input_hash
                or comparison.router_context_version != context
                or comparison.search_budget_ms != budget_ms
                or set(plans) != CATALOG_IDS
                or any(
                    row.summary != plans[row.strategy_id].summary
                    or row.is_usable != plans[row.strategy_id].is_usable
                    for row in comparison.rows
                )
            ):
                raise ValueError("CACHE_CONTEXT_INVALID")
        except (ValueError, TypeError, KeyError, AttributeError):
            self.stats["invalid"] += 1
            self.stats["misses"] += 1
            self._warning("INVALID_ENTRY")
            return None
        self.stats["hits"] += 1
        return comparison, plans

    def put(self, comparison: PolicyComparison, plans: dict[str, Plan], scope: str = "") -> None:
        """Atomically store one complete catalog with TTL; never cache partial solver output."""
        key = self.key(
            comparison.input_publication_id,
            comparison.input_hash,
            comparison.router_context_version,
            comparison.search_budget_ms,
            scope,
        )
        payload = json.dumps(
            {
                "schema_version": 1,
                "comparison": comparison.model_dump(mode="json"),
                "plans": {name: plan.model_dump(mode="json") for name, plan in plans.items()},
            },
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        value = self._signature(key, payload) + b"\n" + payload
        if len(value) > MAX_ENTRY_BYTES:
            self.stats["oversized"] += 1
            return
        try:
            self.client.set(key, value, ex=self.ttl_sec)
        except self.connection_errors:
            self.stats["errors"] += 1
            self._warning("UNAVAILABLE")
            return
        self.stats["writes"] += 1

    def close(self) -> None:
        """Release pooled connections when this Runtime stops."""
        try:
            self.client.close()
        except self.connection_errors:
            pass


def configured_catalog_cache() -> RedisCatalogCache | None:
    """Create the explicitly enabled beta cache; disabled mode imports no Redis client and makes no calls."""
    if os.environ.get("ROUTER_REDIS_BETA", "false").strip().lower() != "true":
        return None
    try:
        from redis import Redis
        from redis.backoff import NoBackoff
        from redis.exceptions import RedisError
        from redis.retry import Retry
    except ImportError:
        LOGGER.warning("REDIS_BETA_CLIENT_UNAVAILABLE; using ordinary catalog calculation")
        return None
    try:
        url = os.environ.get("ROUTER_REDIS_URL", "")
        parsed = urlparse(url)
        if parsed.scheme not in ("redis", "rediss") or not parsed.hostname:
            raise ValueError("REDIS_BETA_URL_INVALID")
        secret = unquote(parsed.password or "").encode()
        namespace = os.environ.get("ROUTER_REDIS_NAMESPACE", "")
        ttl_sec = int(os.environ.get("ROUTER_REDIS_TTL_SEC", "600"))
        client = Redis.from_url(
            url,
            decode_responses=False,
            socket_connect_timeout=0.15,
            socket_timeout=0.25,
            retry=Retry(NoBackoff(), 0),
            health_check_interval=30,
            max_connections=4,
            protocol=2,
        )
        return RedisCatalogCache(
            client, namespace, secret, ttl_sec, connection_errors=(OSError, RedisError)
        )
    except (ValueError, TypeError, RedisError):
        LOGGER.warning("REDIS_BETA_CONFIGURATION_INVALID; using ordinary catalog calculation")
        return None
