"""Portable Navix launcher engine; never execute imported dotenv contents."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".launch"
PROJECT = "navix-launch"
DISTRIBUTION = "https://distribute.droidje.com"


def check_integrity() -> list[str]:
    """Return missing/modified package paths from the release manifest."""
    manifest = ROOT / "launch/manifest.json"
    if not manifest.is_file():
        return ["launch/manifest.json"]
    failures = []
    for name, digest in json.loads(manifest.read_text()).items():
        path = ROOT / name
        if (
            not path.is_file()
            or hashlib.sha256(path.read_bytes()).hexdigest() != digest
        ):
            failures.append(name)
    return failures


def check_docker() -> tuple[bool, str]:
    """Check both Compose and a reachable Docker daemon without mutations."""
    try:
        for args in (["docker", "compose", "version"], ["docker", "info"]):
            result = subprocess.run(args, check=False, capture_output=True, timeout=20)
            if result.returncode:
                return False, "Запустите Docker и проверьте наличие Docker Compose."
        return True, "Docker готов"
    except FileNotFoundError:
        return (
            False,
            "Установите Docker: https://docs.docker.com/get-started/get-docker/",
        )
    except subprocess.TimeoutExpired:
        return False, "Docker не отвечает. Запустите его и повторите проверку."


def check_network() -> bool:
    """Probe distribution HTTPS availability with a bounded timeout."""
    try:
        with urllib.request.urlopen(
            DISTRIBUTION + "/navix/status", timeout=5
        ) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def fetch_secrets(pin: str) -> str:
    """Download the authorized env bundle; PIN is sent only in the HTTPS body."""
    if not re.fullmatch(r"[0-9]{6}", pin):
        raise ValueError("Введите шестизначный PIN.")
    request = urllib.request.Request(
        DISTRIBUTION + "/navix/data",
        data=json.dumps({"pin": pin}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read(262145)
        if len(data) > 262144:
            raise ValueError("Файл настроек слишком большой.")
        return data.decode("utf-8-sig")
    except OSError:
        raise ValueError(
            "Не удалось получить настройки. Проверьте PIN и статус дистрибуции."
        ) from None


def read_env(path: str) -> str:
    """Read a bounded UTF-8 dotenv file without evaluating shell expressions."""
    data = Path(path).expanduser().read_bytes()
    if len(data) > 262144:
        raise ValueError("Файл настроек слишком большой.")
    return data.decode("utf-8-sig")


def parse_env(text: str) -> dict[str, str]:
    """Parse single-line dotenv values; reject commands, multiline and malformed keys."""
    result = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        key, sep, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError("Некорректный формат .env: ожидается KEY=value.")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            if value[0] == '"':
                try:
                    value = json.loads(value)
                except ValueError:
                    raise ValueError(
                        "Некорректное экранирование значения .env."
                    ) from None
            else:
                value = value[1:-1]
        if "\x00" in value or "${" in value or "$(" in value or "`" in value:
            raise ValueError(
                "В .env допустимы только готовые значения без подстановок."
            )
        result[key] = value
    return result


def override_dispatcher_credentials(env_text: str, email: str, password: str) -> str:
    """Replace packaged dispatcher credentials with values entered at launch."""
    email = email.strip()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(password) < 8:
        raise ValueError("Укажите почту и пароль диспетчера (минимум 8 символов).")
    env = parse_env(env_text)
    env["DISPATCHER_EMAIL"] = email
    env["DISPATCHER_PASSWORD"] = password
    return (
        "\n".join(
            f"{key}=" + json.dumps(value, ensure_ascii=False)
            for key, value in env.items()
        )
        + "\n"
    )


def validate_options(options: dict) -> None:
    """Reject inconsistent modes and invalid or duplicated published ports."""
    if options.get("mode") not in ("full", "headless"):
        raise ValueError("Выберите Full или headless.")
    if options["mode"] == "headless" and not options.get("api_port"):
        raise ValueError("В headless нужен порт API/MCP.")
    if options["mode"] == "full" and not options.get("ui_port"):
        raise ValueError("В Full нужен порт UI.")
    ports = [options.get("api_port")]
    if options["mode"] == "full":
        ports.append(options.get("ui_port"))
    used = []
    for port in ports:
        if port is not None:
            if (
                isinstance(port, bool)
                or not isinstance(port, int)
                or not 1 <= port <= 65535
            ):
                raise ValueError("Порт должен быть целым числом от 1 до 65535.")
            used.append(port)
    if len(set(used)) != len(used):
        raise ValueError("Порты API и UI должны различаться.")


def private_write(path: Path, text: str) -> None:
    """Atomically save local configuration with owner-only POSIX permissions."""
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def launch(options: dict, env_text: str, log=print) -> dict:
    """Resolve canonical Compose, isolate settings, build/start and wait for health."""
    validate_options(options)
    env = parse_env(env_text)
    if not env.get("DISPATCHER_EMAIL") or len(env.get("DISPATCHER_PASSWORD", "")) < 8:
        raise ValueError("Укажите почту и пароль диспетчера (минимум 8 символов).")
    STATE.mkdir(mode=0o700, exist_ok=True)
    # Persist installation credentials across restarts, independently of provider imports.
    identity_file = STATE / "identity.json"
    identity = (
        json.loads(identity_file.read_text())
        if identity_file.exists()
        else {
            "POSTGRES_PASSWORD": secrets.token_hex(24),
            "ROUTER_DB_PASSWORD": secrets.token_hex(24),
        }
    )
    private_write(identity_file, json.dumps(identity))
    env.update(identity)
    env.update(
        {
            "POSTGRES_USER": "lct",
            "POSTGRES_DB": "lct",
            "NODE_ENV": "production",
            "AUTH_DEV_EXPOSE_CODES": "false",
            "VITE_SENTRY_ENABLED": "false",
        }
    )
    if not options["online"]:
        env["LLM_PROVIDER"] = "off"
        for key in list(env):
            if key.startswith(("SMTP_", "OTEL_", "SENTRY_", "SYS1_")) or key in (
                "LLM_TOKEN",
                "LLM_PROXY_TOKEN",
                "LOCATION_IQ_TOKEN",
                "JEV_API_URL",
            ):
                env.pop(key)
        env.update(
            {
                "OTEL_ENABLED": "false",
                "SENTRY_ENABLED": "false",
                "ROUTER_OTEL_ENABLED": "false",
                "ROUTER_SENTRY_ENABLED": "false",
            }
        )
    # Resolve the canonical YAML via Compose, substituting env_file before it is loaded.
    source = (ROOT / "infra/docker-compose.yml").read_text()
    if source.count("path: ../.env") != 1:
        raise ValueError("Формат Compose изменился: обновите лаунчер.")
    source = source.replace(
        "path: ../.env", "path: " + json.dumps(str(STATE / "input.env"))
    )
    private_write(
        STATE / "input.env",
        "\n".join(
            f"{k}=" + json.dumps(v, ensure_ascii=False).replace("$", "\\$")
            for k, v in env.items()
        )
        + "\n",
    )
    fd, temporary = tempfile.mkstemp(
        prefix=".launcher-", suffix=".yml", dir=ROOT / "infra"
    )
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(source)
        process_env = {
            k: v
            for k, v in os.environ.items()
            if k
            in (
                "PATH",
                "HOME",
                "USERPROFILE",
                "SYSTEMROOT",
                "SystemRoot",
                "TEMP",
                "TMP",
                "DOCKER_HOST",
                "DOCKER_CONTEXT",
                "DOCKER_CONFIG",
                "DOCKER_TLS_VERIFY",
                "DOCKER_CERT_PATH",
            )
        }
        for key in list(process_env):
            if key.startswith("COMPOSE_"):
                process_env.pop(key)
        process_env.update(env)
        proc = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                str(STATE / "input.env"),
                "-p",
                PROJECT,
                "-f",
                temporary,
                "config",
                "--format",
                "json",
            ],
            env=process_env,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode:
            raise ValueError(
                "Не удалось проверить Docker Compose. Проверьте версию Docker и настройки."
            )
        # Compose serializes literal dollars as $$ for safe round-tripping.
        # Normalize once before merging raw user values, then escape at the final write.
        config = json.loads(proc.stdout.replace("$$", "$"))
    finally:
        os.unlink(temporary)
    services = config["services"]
    selected = {"postgres", "migrate", "router-db-bootstrap", "router", "api"}
    if options["mode"] == "full":
        selected.add("web")
    if options["osrm"]:
        selected.update(("osrm", "road-api"))
    # route3 follows the OSRM option unless explicitly overridden: the engine
    # needs no extra wizard question when the road contour is already on.
    route3 = options.get("route3")
    if route3 is None:
        route3 = bool(options["osrm"])
    if route3:
        selected.add("route-engine3")
    if options["online"]:
        selected.add("sys1")
    config["services"] = {
        name: svc for name, svc in services.items() if name in selected
    }
    for name, svc in config["services"].items():
        svc.pop("ports", None)
        svc.pop("profiles", None)
        svc["restart"] = (
            "no"
            if name in ("migrate", "router-db-bootstrap") or not options["autostart"]
            else "unless-stopped"
        )
        if "build" in svc:
            svc["image"] = f"{PROJECT}-{name}:local"
        if name == "api":
            svc["environment"].update(env)
            svc["environment"].update(
                {
                    "PORT": "8000",
                    "ROUTER_BASE_URL": "http://router:8100",
                    "DATASET_ROOT": "/app/data/dataset/anonymized",
                    "NAVIX_STRAIGHT_ROUTES": "false" if options["osrm"] else "true",
                }
            )
            svc["environment"]["DATABASE_URL"] = services["migrate"]["environment"][
                "DATABASE_URL"
            ]
            for key in ("API_ROAD_API_URL", "ROUTER_ROAD_API_URL"):
                if not options["osrm"]:
                    svc["environment"].pop(key, None)
            if not route3:
                svc["environment"].pop("ROUTE3_URL", None)
        if name == "router" and not options["osrm"]:
            svc["environment"].pop("ROUTER_ROAD_API_URL", None)
            svc["environment"].update(
                {"ROUTER_ROAD_API_OFFLINE": "true", "ROUTER_OSRM_OFFLINE": "true"}
            )
        if name == "router" and not route3:
            svc["environment"].pop("ROUTE3_URL", None)
    urls = {}
    for name, key, target in [("api", "api_port", 8000), ("web", "ui_port", 80)]:
        port = options.get(key)
        if name in config["services"] and port:
            config["services"][name]["ports"] = [
                {
                    "target": target,
                    "published": str(port),
                    "host_ip": "127.0.0.1",
                    "protocol": "tcp",
                }
            ]
            urls[name] = f"http://localhost:{port}"
    if not options["online"]:
        config.setdefault("networks", {}).setdefault("default", {})["internal"] = True
        config["networks"]["edge"] = {}
        if "web" in config["services"]:
            config["services"]["web"]["networks"] = {"default": None, "edge": None}
        if options.get("api_port"):
            api = config["services"]["api"]
            config["services"]["gateway"] = {
                "image": api["image"],
                "entrypoint": ["node", "/launch/gateway.cjs"],
                "ports": api.pop("ports"),
                "networks": {"default": None, "edge": None},
                "restart": "unless-stopped" if options["autostart"] else "no",
                "depends_on": {"api": {"condition": "service_healthy"}},
                "volumes": [
                    {
                        "type": "bind",
                        "source": str(ROOT / "launch/gateway.cjs"),
                        "target": "/launch/gateway.cjs",
                        "read_only": True,
                    }
                ],
                "healthcheck": {
                    "test": [
                        "CMD",
                        "node",
                        "-e",
                        "fetch('http://127.0.0.1:8000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
                    ],
                    "interval": "5s",
                    "timeout": "5s",
                    "retries": 12,
                },
            }

    # Escape dollars for the second Compose parse (e.g. bootstrap shell variables).
    if "web" in config["services"]:
        private_write(
            STATE / "navix-runtime.js",
            "window.navixOffline = "
            + ("false" if options["online"] else "true")
            + ";\n",
        )
        os.chmod(STATE / "navix-runtime.js", 0o644)
        config["services"]["web"].setdefault("volumes", []).append(
            {
                "type": "bind",
                "source": str(STATE / "navix-runtime.js"),
                "target": "/usr/share/nginx/html/navix-runtime.js",
                "read_only": True,
            }
        )
        if not options["online"]:
            nginx = (
                (ROOT / "apps/web/nginx.conf")
                .read_text()
                .replace(
                    "server_name _;",
                    """server_name _;
    add_header Content-Security-Policy "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'" always;""",
                )
            )
            private_write(STATE / "offline-nginx.conf", nginx)
            os.chmod(STATE / "offline-nginx.conf", 0o644)
            config["services"]["web"]["volumes"].append(
                {
                    "type": "bind",
                    "source": str(STATE / "offline-nginx.conf"),
                    "target": "/etc/nginx/conf.d/default.conf",
                    "read_only": True,
                }
            )
    serialized = json.dumps(config, ensure_ascii=False).replace("$", "$$")
    old_config = (
        json.loads((STATE / "active.json").read_text())
        if (STATE / "active.json").exists()
        else None
    )
    private_write(STATE / "compose.json", serialized)
    command = ["docker", "compose", "-p", PROJECT, "-f", str(STATE / "compose.json")]

    def run(args):
        # Docker output can contain imported settings: retain only a private diagnostic file.
        with open(STATE / "docker.log", "w", encoding="utf-8") as output:
            os.chmod(STATE / "docker.log", 0o600)
            result = subprocess.run(
                command + args, check=False, stdout=output, stderr=subprocess.STDOUT
            )
        if result.returncode:
            raise ValueError(
                "Docker не завершил операцию. Диагностика: .launch/docker.log (может содержать настройки)."
            )

    if options["online"]:
        log("Сборка Docker-образов…")
        run(["build"])
    else:
        for svc in config["services"].values():
            image = svc.get("image")
            if (
                image
                and subprocess.run(
                    ["docker", "image", "inspect", image],
                    check=False,
                    capture_output=True,
                ).returncode
            ):
                raise ValueError(
                    "Для офлайн-запуска подготовьте Docker-образы при доступной сети: "
                    + image
                )
    if old_config and old_config.get("networks") != config.get("networks"):
        # Docker cannot mutate an existing network's internal flag. Recreate only this
        # installation's containers/network; named database volumes are retained.
        private_write(STATE / "previous.json", json.dumps(old_config))
        stopped = subprocess.run(
            [
                "docker",
                "compose",
                "-p",
                PROJECT,
                "-f",
                str(STATE / "previous.json"),
                "down",
            ],
            check=False,
            capture_output=True,
        )
        if stopped.returncode:
            raise ValueError("Не удалось переключить изоляцию сети текущей установки.")
    if old_config:
        removed = set(old_config["services"]) - set(config["services"])
        if removed:
            private_write(STATE / "previous.json", json.dumps(old_config))
            stopped = subprocess.run(
                [
                    "docker",
                    "compose",
                    "-p",
                    PROJECT,
                    "-f",
                    str(STATE / "previous.json"),
                    "stop",
                    *sorted(removed),
                ],
                check=False,
                capture_output=True,
            )
            if stopped.returncode:
                raise ValueError(
                    "Не удалось остановить исключённые сервисы предыдущего запуска."
                )
    log("Запуск и проверка готовности…")
    run(
        [
            "up",
            "-d",
            "--no-build",
            "--pull",
            "never" if not options["online"] else "missing",
            "--wait",
            "--wait-timeout",
            "240",
        ]
    )
    for name, url in urls.items():
        endpoint = url + ("/health/ready" if name == "api" else "/")
        for attempt in range(10):
            try:
                with urllib.request.urlopen(endpoint, timeout=3) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if attempt == 9:
                raise ValueError(
                    "Контейнеры запущены, но опубликованный порт недоступен: " + url
                )
            time.sleep(0.5)
    private_write(STATE / "active.json", serialized)
    log("Navix запущен.")
    return urls
