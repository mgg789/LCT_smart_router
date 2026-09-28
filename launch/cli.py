"""Interactive console wizard for installing a local Navix contour."""

from __future__ import annotations

import argparse
import getpass
import subprocess
import sys

from . import core, versions

BANNER = r"""
  _   _    _ __     _____ __  __
 | \ | |  / \\ \   / /_ _|\ \/ /
 |  \| | / _ \\ \ / / | |  \  /
 | |\  |/ ___ \\ V /  | |  /  \
 |_| \_/_/   \_\\_/  |___|/_/\_\
"""
SOURCE = "https://sourcecraft.dev/lct-hackaton-2026/case-13-field-engineer-routing-team-22"


def _core():
    """Shared engine accessor used by the GUI."""
    return core


def yes(prompt: str, default: bool = False) -> bool:
    """Read an explicit yes/no choice using a visible default."""
    while True:
        value = input(prompt + (" [Да/нет]: " if default else " [да/Нет]: ")).strip().lower()
        if not value:
            return default
        if value in ("да", "д", "y", "yes", "1"):
            return True
        if value in ("нет", "н", "n", "no", "0"):
            return False
        print("Ответьте да или нет.")


def port(prompt: str, default: int, required: bool) -> int | None:
    """Read a bounded port; '-' disables optional publication."""
    while True:
        value = input(
            f"{prompt} [{default}]" + ("" if required else " (- — не открывать)") + ": "
        ).strip()
        if value == "-" and not required:
            return None
        try:
            number = int(value or default)
            if 1 <= number <= 65535:
                return number
        except ValueError:
            pass
        print("Введите порт от 1 до 65535.")


def dispatcher_credentials(previous: dict[str, str] | None = None) -> tuple[str, str]:
    """Collect the launch-time dispatcher identity without echoing its password."""
    previous = previous or {}
    email = input(
        "Почта диспетчера"
        + (
            f" [{previous['DISPATCHER_EMAIL']}]"
            if previous.get("DISPATCHER_EMAIL")
            else " (обязательно)"
        )
        + ": "
    ).strip() or previous.get("DISPATCHER_EMAIL", "")
    password = getpass.getpass(
        "Пароль диспетчера (пусто — сохранить): "
        if previous.get("DISPATCHER_PASSWORD")
        else "Пароль диспетчера (обязательно, минимум 8 символов): "
    ) or previous.get("DISPATCHER_PASSWORD", "")
    return email, password


def build_parser() -> argparse.ArgumentParser:
    """Define optional unattended launch arguments; default is an interactive wizard."""
    parser = argparse.ArgumentParser(description="Navix launcher")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--osrm", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--mode", choices=("full", "headless"))
    parser.add_argument("--api-port", type=int)
    parser.add_argument("--ui-port", type=int)
    parser.add_argument("--autostart", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--env", help="Путь к .env")
    parser.add_argument(
        "--action",
        choices=("start", "configure", "status", "remove", "purge"),
        help="Действие с существующей установкой; без аргумента открывается меню",
    )
    return parser


def existing_action(status: dict) -> str:
    """Offer management only for this directory's verified installation."""
    labels = {
        "running": "работает",
        "stopped": "остановлена",
        "partial": "подготовлена частично",
        "removed": "удалена, данные сохранены",
    }
    print(f"Установка {status['record']['project']}: {labels[status['status']]}")
    print(
        "1 — запустить / перезапустить с сохранёнными настройками\n2 — изменить настройки и запустить\n3 — удалить экземпляр, сохранив данные\n4 — удалить экземпляр и его данные\n0 — выйти"
    )
    while True:
        value = input("Действие [1]: ").strip() or "1"
        actions = {"1": "start", "2": "configure", "3": "remove", "4": "purge", "0": "exit"}
        if value in actions:
            return actions[value]


def remove_interactively(purge: bool) -> int:
    """Show exact owned resources and require a separate confirmation for data removal."""
    preview = core.removal_preview()
    print(f"Экземпляр: {preview['project']}\nКаталог: {preview['root']}")
    print("Тома данных: " + (", ".join(preview["volumes"]) or "нет"))
    if purge:
        confirmation = input(
            f"Безвозвратно удалить эти данные? Введите DELETE {preview['project']}: "
        ).strip()
        if confirmation != f"DELETE {preview['project']}":
            print("Удаление отменено.")
            return 0
    else:
        confirmation = ""
        if not yes("Удалить контейнеры экземпляра, сохранив данные и настройки?"):
            return 0
    core.remove_installation(purge_data=purge, confirmation=confirmation)
    return 0


def run(args: argparse.Namespace) -> int:
    """Run preflight, prompt for options and credentials, then invoke the engine."""
    print(BANNER, "\nNavix · локальный запуск\n", flush=True)
    interactive = sys.stdin.isatty()
    errors = core.check_integrity()
    if errors:
        print("Проверка пакетов не прошла. Повторите установку с " + SOURCE)
        print("Проблемные файлы: " + ", ".join(errors))
        if not interactive or not yes("Продолжить так?"):
            return 1
    else:
        print("✓ Проверка пакетов пройдена")
    while True:
        ready, message = core.check_docker()
        print(message)
        if ready:
            break
        if not interactive or not yes("Повторить проверку Docker?", True):
            return 1
    status = core.installation_status()
    action = getattr(args, "action", None)
    if action == "status":
        print("Состояние установки: " + status["status"])
        return 0
    if not action and status["record"]:
        if not interactive:
            raise ValueError(
                "Для существующей установки укажите --action start или --action status."
            )
        action = existing_action(status)
    if action == "exit":
        return 0
    if action in ("remove", "purge"):
        if not interactive:
            raise ValueError("Удаление требует интерактивного подтверждения.")
        return remove_interactively(action == "purge")
    network = not args.offline and core.check_network()
    print(
        "✓ Сервис дистрибуции доступен"
        if network
        else "Сервис дистрибуции недоступен или выбран офлайн-режим"
    )
    print(versions.message(core.check_version(online=not args.offline)))
    saved_env = core.saved_environment()
    saved_options = status["options"]
    if action == "start":
        if not saved_env or not saved_options:
            raise ValueError("Сохранённых настроек недостаточно. Выберите изменение настроек.")
        start_options = dict(saved_options)
        for key in ("mode", "api_port", "ui_port", "osrm", "autostart"):
            value = getattr(args, key, None)
            if value is not None:
                start_options[key] = value
        if args.offline:
            start_options["online"] = False
        for name, url in core.launch(start_options, saved_env, print).items():
            print(f"{name}: {url}")
        return 0
    online = not args.offline and saved_options.get("online", True)
    if interactive and not args.offline:
        print("Офлайн — закрытый контур. Онлайн — AI и внешние API карт.")
        online = yes("Включить онлайн-режим?", online)
    mode = args.mode
    if not mode:
        mode = (
            "headless"
            if interactive
            and yes("Headless (только API, без UI)?", saved_options.get("mode") == "headless")
            else "full"
        )
    options = {
        "online": online,
        "mode": mode,
        "osrm": args.osrm
        if args.osrm is not None
        else interactive
        and yes("Запускать OSRM (дорожные маршруты)?", saved_options.get("osrm", False)),
        "autostart": args.autostart
        if args.autostart is not None
        else interactive
        and yes("Автозапуск при старте Docker?", saved_options.get("autostart", False)),
        "api_port": args.api_port,
        "ui_port": args.ui_port if mode == "full" else None,
    }
    if interactive:
        if options["api_port"] is None:
            options["api_port"] = port(
                "Порт API + MCP", saved_options.get("api_port") or 8000, mode == "headless"
            )
        if mode == "full" and options["ui_port"] is None:
            options["ui_port"] = port("Порт UI", saved_options.get("ui_port") or 5173, True)
    core.validate_options(options)
    env_text = core.read_env(args.env) if args.env else ""
    while not env_text and interactive:
        print(
            ("1 — distribute.droidje.com по PIN (рекомендуется)\n" if network else "")
            + "2 — файл .env\n3 — ввести значения"
            + ("\n4 — сохранить настройки этой установки" if saved_env else "")
        )
        choice = input("Источник настроек" + (" [4]" if saved_env else "") + ": ").strip() or (
            "4" if saved_env else ""
        )
        try:
            if choice == "4" and saved_env:
                env_text = saved_env
            elif choice == "1" and network:
                env_text = core.fetch_secrets(getpass.getpass("Шестизначный PIN: "))
            elif choice == "2":
                env_text = core.read_env(input("Путь к .env: ").strip())
            elif choice == "3":
                values = {
                    # Dispatcher credentials are collected by the common prompt below,
                    # after this source has been acquired.
                }
                if online:
                    values.update(
                        LLM_PROVIDER=input("AI provider [off/openai_chat/agents]: ").strip()
                        or "off",
                        LLM_TOKEN=getpass.getpass("AI token (если нужен): "),
                        LLM_BASE_URL=input("AI base URL (если нужен): ").strip(),
                        LLM_MODEL=input("AI model (если нужна): ").strip(),
                    )
                env_text = "\n".join(f"{k}={v}" for k, v in values.items() if v) or "\n"
        except (OSError, ValueError):
            print("Не удалось получить настройки. Проверьте путь/PIN или выберите другой источник.")
    if not env_text:
        raise ValueError("Для неинтерактивного запуска укажите --env.")
    if not interactive:
        raise ValueError("Запуск требует интерактивного ввода почты и пароля диспетчера.")
    email, password = dispatcher_credentials(core.parse_env(saved_env) if saved_env else None)
    env_text = core.override_dispatcher_credentials(env_text, email, password)
    for name, url in core.launch(options, env_text, print).items():
        print(f"{name}: {url}")
    return 0


def main() -> int:
    """Keep expected setup failures concise without dumping secret-bearing exceptions."""
    try:
        return run(build_parser().parse_args())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(
            str(error)
            if isinstance(error, ValueError)
            else "Ошибка доступа к файлу, Docker или сети."
        )
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\nЗапуск отменён.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
