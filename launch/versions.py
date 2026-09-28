"""Advisory release checks independent of PIN-protected configuration downloads."""

from __future__ import annotations

import json
import re
import ssl
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from .installation import private_write, read_json
from .tls import https_context

VERSION_PATTERN = re.compile(
    r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)


def parse_version(value: str) -> tuple[int, int, int, tuple[str, ...]]:
    """Accept published v1.7 and semantic versions; preserve prerelease ordering."""
    match = VERSION_PATTERN.fullmatch(value)
    if not match or len(value) > 128:
        raise ValueError("Некорректная версия релиза.")
    prerelease = tuple(match[4].split(".")) if match[4] else ()
    if any(
        not part or (part.isdigit() and len(part) > 1 and part.startswith("0"))
        for part in prerelease
    ):
        raise ValueError("Некорректная версия релиза.")
    return (
        int(match[1]),
        int(match[2]),
        int(match[3] or 0),
        prerelease,
    )


def compare(left: str, right: str) -> int:
    """Compare SemVer numbers and prerelease identifiers; build metadata is not precedence."""
    a, b = parse_version(left), parse_version(right)
    if a[:3] != b[:3]:
        return 1 if a[:3] > b[:3] else -1
    if a[3] == b[3]:
        return 0
    if not a[3] or not b[3]:
        return 1 if not a[3] else -1
    for x, y in zip(a[3], b[3]):
        if x == y:
            continue
        if x.isdigit() and y.isdigit():
            return 1 if int(x) > int(y) else -1
        if x.isdigit() != y.isdigit():
            return -1 if x.isdigit() else 1
        return 1 if x > y else -1
    return 1 if len(a[3]) > len(b[3]) else -1


def local_version(root: Path) -> str | None:
    """Read package-owned version metadata; never mistake package.json's workspace version for a release."""
    try:
        metadata = read_json(root / "launch/release.json")
        value = metadata.get("version") if metadata else None
        if isinstance(value, str):
            parse_version(value)
            return value
    except (OSError, ValueError):
        pass
    return None


def release_metadata(value: object) -> dict[str, str]:
    """Validate only public release metadata and an HTTPS download destination."""
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise ValueError("Неизвестный формат сведений о релизе.")
    version, url = value.get("version"), value.get("download_url")
    if not isinstance(version, str) or not isinstance(url, str) or len(url) > 2048:
        raise ValueError("Неполные сведения о релизе.")
    parse_version(version)
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or any(ord(char) < 33 for char in url)
    ):
        raise ValueError("Недопустимая ссылка на релиз.")
    return {"version": version, "download_url": url}


def check(root: Path, state: Path, service: str, *, online: bool = True) -> dict:
    """Read one bounded public endpoint; a failed check never blocks startup or sends a PIN."""
    current = local_version(root)
    try:
        development = (read_json(root / "launch/release.json") or {}).get(
            "channel"
        ) == "development"
    except (OSError, ValueError):
        development = False
    result = {
        "status": "unavailable",
        "current": current,
        "latest": None,
        "download_url": None,
        "source": "none",
        "checked_at": None,
        "development": development,
    }
    cache_file = state / "version-cache.json"
    metadata = None
    if online:
        try:
            request = urllib.request.Request(
                service.rstrip("/") + "/navix/version", headers={"Accept": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=5, context=https_context()) as response:
                raw = response.read(8193)
            if len(raw) > 8192:
                raise ValueError("Ответ проверки версии слишком большой.")
            metadata = release_metadata(json.loads(raw))
            result.update(source="network", checked_at=int(time.time()))
            try:
                private_write(
                    cache_file,
                    json.dumps(
                        {
                            "service": service,
                            "checked_at": result["checked_at"],
                            "release": {"schema_version": 1, **metadata},
                        }
                    ),
                )
            except OSError:
                pass
        except (OSError, ValueError) as exc:
            if isinstance(getattr(exc, "reason", exc), ssl.SSLCertVerificationError):
                result["error_kind"] = "certificate"
    if metadata is None:
        try:
            cache = read_json(cache_file)
            if (
                cache
                and cache.get("service") == service
                and isinstance(cache.get("checked_at"), int)
            ):
                metadata = release_metadata(cache.get("release"))
                result.update(source="cache", checked_at=cache["checked_at"])
        except (OSError, ValueError):
            pass
    if metadata:
        result.update(latest=metadata["version"], download_url=metadata["download_url"])
        if development:
            result["status"] = "development"
        elif current is None:
            result["status"] = "unknown_local"
        else:
            order = compare(current, metadata["version"])
            result["status"] = (
                "update_available" if order < 0 else "current" if order == 0 else "ahead"
            )
    return result


def message(result: dict) -> str:
    """Explain version status and cache age without claiming offline data is freshly checked."""
    current = result["current"] or "не указана в пакете"
    prefix = (
        f"Сборка разработки на базе {current}. "
        if result.get("development")
        else f"Версия пакета: {current}. "
    )
    if result.get("error_kind") == "certificate":
        prefix += "Сертификат сервиса не прошёл проверку TLS. "
    if result["source"] == "cache":
        checked = time.strftime("%d.%m.%Y %H:%M", time.localtime(result["checked_at"]))
        prefix += f"Сервис недоступен; сведения из проверки {checked}. "
    status = result["status"]
    if status == "development":
        return prefix + f"Опубликован релиз {result['latest']}: {result['download_url']}"
    if status == "update_available":
        return (
            prefix
            + f"Доступна {result['latest']}. Рекомендуем скачать новую версию: {result['download_url']}"
        )
    if status == "current":
        return prefix + (
            "Совпадает с последним известным релизом."
            if result["source"] == "cache"
            else "Установлен актуальный релиз."
        )
    if status == "ahead":
        return prefix + f"Пакет новее опубликованного релиза {result['latest']}."
    if status == "unknown_local":
        return prefix + f"Опубликован релиз {result['latest']}: {result['download_url']}"
    return prefix + "Проверка актуальности недоступна; запуск можно продолжить."
