"""Interactive console wizard for installing a local Navix contour."""

from __future__ import annotations

import argparse
import getpass
import subprocess
import sys

from . import core

BANNER = r"""
  _   _    _ __     _____ __  __
 | \ | |  / \\ \   / /_ _|\ \/ /
 |  \| | / _ \\ \ / / | |  \  /
 | |\  |/ ___ \\ V /  | |  /  \
 |_| \_/_/   \_\\_/  |___|/_/\_\
"""
SOURCE = (
    "https://sourcecraft.dev/lct-hackaton-2026/case-13-field-engineer-routing-team-22"
)


def _core():
    """Shared engine accessor used by the GUI."""
    return core


def yes(prompt: str, default: bool = False) -> bool:
    """Read an explicit yes/no choice using a visible default."""
    while True:
        value = (
            input(prompt + (" [Да/нет]: " if default else " [да/Нет]: "))
            .strip()
            .lower()
        )
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


def build_parser() -> argparse.ArgumentParser:
    """Define optional unattended launch arguments; default is an interactive wizard."""
    parser = argparse.ArgumentParser(description="Navix launcher")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--osrm", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--mode", choices=("full", "headless"))
    parser.add_argument("--api-port", type=int)
    parser.add_argument("--ui-port", type=int)
    parser.add_argument(
        "--autostart", action=argparse.BooleanOptionalAction, default=None
    )
    parser.add_argument("--env", help="Путь к .env")
    return parser


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
    network = core.check_network()
    print("✓ Сеть доступна" if network else "Сеть недоступна")
    online = network and not args.offline
    if interactive and online:
        print("Офлайн — закрытый контур. Онлайн — AI и внешние API карт.")
        online = yes("Включить онлайн-режим?", True)
    mode = args.mode
    if not mode:
        mode = (
            "headless"
            if interactive and yes("Headless (только API, без UI)?")
            else "full"
        )
    options = {
        "online": online,
        "mode": mode,
        "osrm": args.osrm
        if args.osrm is not None
        else interactive and yes("Запускать OSRM (дорожные маршруты)?", True),
        "autostart": args.autostart
        if args.autostart is not None
        else interactive and yes("Автозапуск при старте Docker?"),
        "api_port": args.api_port,
        "ui_port": args.ui_port if mode == "full" else None,
    }
    if interactive:
        if options["api_port"] is None:
            options["api_port"] = port("Порт API + MCP", 8000, mode == "headless")
        if mode == "full" and options["ui_port"] is None:
            options["ui_port"] = port("Порт UI", 5173, True)
    core.validate_options(options)
    env_text = core.read_env(args.env) if args.env else ""
    while not env_text and interactive:
        print(
            ("1 — distribute.droidje.com по PIN (рекомендуется)\n" if network else "")
            + "2 — файл .env\n3 — ввести значения"
        )
        choice = input("Источник настроек: ").strip()
        try:
            if choice == "1" and network:
                env_text = core.fetch_secrets(getpass.getpass("Шестизначный PIN: "))
            elif choice == "2":
                env_text = core.read_env(input("Путь к .env: ").strip())
            elif choice == "3":
                values = {
                    "DISPATCHER_EMAIL": input("Почта диспетчера: ").strip(),
                    "DISPATCHER_PASSWORD": getpass.getpass("Пароль диспетчера: "),
                }
                if online:
                    values.update(
                        LLM_PROVIDER=input(
                            "AI provider [off/openai_chat/agents]: "
                        ).strip()
                        or "off",
                        LLM_TOKEN=getpass.getpass("AI token (если нужен): "),
                        LLM_BASE_URL=input("AI base URL (если нужен): ").strip(),
                        LLM_MODEL=input("AI model (если нужна): ").strip(),
                    )
                env_text = "\n".join(f"{k}={v}" for k, v in values.items() if v)
        except (OSError, ValueError):
            print(
                "Не удалось получить настройки. Проверьте путь/PIN или выберите другой источник."
            )
    if not env_text:
        raise ValueError("Для неинтерактивного запуска укажите --env.")
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
