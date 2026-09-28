"""Installation identity, ownership checks and exclusive local lifecycle operations."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

OWNER_LABEL = "dev.navix.installation"
ROOT_LABEL = "dev.navix.root"
PROJECT_LABEL = "com.docker.compose.project"


def private_write(path: Path, text: str) -> None:
    """Atomically replace a private UTF-8 file; temporary files stay owner-only on POSIX."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path: Path) -> dict | None:
    """Read local metadata without silently replacing a damaged installation identity."""
    if not path.exists():
        return None
    try:
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, UnicodeError):
        raise ValueError(
            f"Повреждён файл установки {path.name}. Сохраните .launch и восстановите его из копии."
        ) from None


def normalized_path(value: str | Path) -> str:
    """Compare Compose's Windows/Unix path spellings on the current host."""
    return os.path.normcase(os.path.abspath(str(value))).replace("\\", "/")


def load(state: Path, root: Path) -> dict | None:
    """Load this directory's installation, refusing a copied foreign state directory."""
    record = read_json(state / "installation.json")
    if record is None:
        return None
    if (
        not re.fullmatch(r"[a-f0-9]{12}", str(record.get("id", "")))
        or not re.fullmatch(r"navix-launch(?:-[a-f0-9]{12})?", str(record.get("project", "")))
        or record.get("schema_version") != 1
    ):
        raise ValueError(
            "Неизвестный формат установки. Сохраните каталог .launch перед восстановлением."
        )
    if normalized_path(record.get("root", "")) != normalized_path(root):
        raise ValueError(
            "Каталог .launch принадлежит другой папке. Откройте исходную установку или распакуйте новый пакет без .launch."
        )
    return record


def ensure(state: Path, root: Path, *, persist: bool = True) -> dict:
    """Allocate one isolated Compose project, retaining known legacy database identity."""
    record = load(state, root)
    if record:
        return record
    legacy = read_json(state / "active.json") or read_json(state / "compose.json")
    identity = read_json(state / "identity.json")
    installation_id = uuid.uuid4().hex[:12]
    if legacy is not None and (legacy.get("name") != "navix-launch" or not identity):
        raise ValueError(
            "Старая конфигурация не имеет подтверждённой identity.json. Автоматическое создание новых паролей запрещено."
        )
    if legacy:
        installation_id = hashlib.sha256(normalized_path(root).encode()).hexdigest()[:12]
    record = {
        "schema_version": 1,
        "id": installation_id,
        "project": "navix-launch" if legacy else f"navix-launch-{installation_id}",
        "root": normalized_path(root),
        "legacy": legacy is not None,
        "phase": "prepared",
        "options": options_from_config(legacy) if legacy else {},
    }
    if persist:
        save(state, record)
    return record


def options_from_config(config: dict) -> dict:
    """Recover existing legacy launcher choices from its own resolved Compose file."""
    services = config.get("services", {})

    def port(service: str) -> int | None:
        entries = services.get(service, {}).get("ports", [])
        return int(entries[0]["published"]) if entries else None

    return {
        "mode": "full" if "web" in services else "headless",
        "online": not config.get("networks", {}).get("default", {}).get("internal", False),
        "osrm": "osrm" in services,
        "autostart": services.get("router", {}).get("restart", "no") != "no",
        "api_port": port("gateway") or port("api"),
        "ui_port": port("web"),
    }


def save(state: Path, record: dict) -> None:
    """Persist lifecycle state without credentials or provider tokens."""
    private_write(
        state / "installation.json", json.dumps(record, ensure_ascii=False, indent=2) + "\n"
    )


@contextmanager
def operation(state: Path) -> Iterator[None]:
    """Serialize GUI/CLI operations; OS file locks are released after a crashed process."""
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state / "operation.lock").open("a+b") as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError(
                "С этой установкой уже работает другой лаунчер. Дождитесь завершения операции."
            ) from None
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def docker_read(args: list[str]) -> str:
    """Read bounded Docker metadata without dumping container environments or logs."""
    try:
        result = subprocess.run(
            ["docker", *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=25,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("Docker недоступен; состояние установки не определено.") from None
    if result.returncode:
        raise ValueError("Docker не смог прочитать состояние установки.")
    return result.stdout


def assert_owned(labels: dict, record: dict, state: Path, *, volume: bool = False) -> None:
    """Require both the Compose project and installation identity before destructive actions."""
    if labels.get(PROJECT_LABEL) != record["project"]:
        raise ValueError("Ресурс Docker принадлежит другому проекту. Операция отменена.")
    if labels.get(OWNER_LABEL) == record["id"] and labels.get(ROOT_LABEL) == record["root"]:
        return
    if record.get("legacy") and not labels.get(OWNER_LABEL):
        if volume:
            return
        directory = labels.get("com.docker.compose.project.working_dir", "")
        if normalized_path(directory) in (normalized_path(state), record["root"]):
            return
    raise ValueError("Ресурс Docker принадлежит другой установке Navix. Операция отменена.")


def inspect(state: Path, root: Path) -> dict:
    """Describe local installation health and its own ports; unknown Docker state stays explicit."""
    record = load(state, root)
    if record is None:
        if (state / "identity.json").exists() and (
            (state / "active.json").exists() or (state / "compose.json").exists()
        ):
            record = ensure(state, root, persist=False)
        else:
            return {"status": "new", "options": {}, "ports": [], "record": None}
    ids = docker_read(
        ["ps", "-aq", "--filter", f"label={PROJECT_LABEL}={record['project']}"]
    ).split()
    containers = []
    if ids:
        template = '{"labels":{{json .Config.Labels}},"state":{{json .State}},"ports":{{json .NetworkSettings.Ports}}}'
        containers = [
            json.loads(line)
            for line in docker_read(["inspect", "--format", template, *ids]).splitlines()
            if line.strip()
        ]
    running = set()
    ports = set()
    for container in containers:
        labels = container["labels"] or {}
        assert_owned(labels, record, state)
        service = labels.get("com.docker.compose.service", "")
        runtime = container["state"]
        if (
            runtime.get("Running")
            and runtime.get("Health", {}).get("Status", "healthy") == "healthy"
        ):
            running.add(service)
        if runtime.get("Running"):
            for mappings in (container.get("ports") or {}).values():
                for mapping in mappings or []:
                    ports.add(int(mapping["HostPort"]))
    options = record.get("options", {})
    required = {"postgres", "router", "api"}
    if options.get("mode") == "full":
        required.add("web")
    if options.get("osrm"):
        required.update(("osrm", "road-api"))
    if not options.get("online", True) and options.get("api_port"):
        required.add("gateway")
    if required <= running:
        status = "running"
    elif containers and not any(c["state"].get("Running") for c in containers):
        status = "stopped"
    elif not containers and record.get("phase") == "removed":
        status = "removed"
    else:
        status = "partial"
    return {"status": status, "options": options, "ports": sorted(ports), "record": record}


def owned_volumes(state: Path, record: dict) -> list[str]:
    """List only verified volumes for a reviewed full removal; never prune Docker globally."""
    names = docker_read(
        ["volume", "ls", "-q", "--filter", f"label={PROJECT_LABEL}={record['project']}"]
    ).split()
    if not names:
        return []
    volumes = json.loads(docker_read(["volume", "inspect", *names]))
    config = read_json(state / "active.json") or read_json(state / "compose.json") or {}
    declared = {v.get("name") for v in config.get("volumes", {}).values()}
    for volume in volumes:
        assert_owned(volume.get("Labels") or {}, record, state, volume=True)
        if volume["Name"] not in declared:
            raise ValueError(
                "У установки найден неизвестный том. Автоматическое полное удаление отменено."
            )
    return [v["Name"] for v in volumes]
