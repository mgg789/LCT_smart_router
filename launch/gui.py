"""Small non-blocking Tkinter launcher for Navix."""

from __future__ import annotations

import argparse
import json
import queue
import subprocess
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

from . import cli, versions

BG = "#151515"
PANEL = "#202020"
YELLOW = "#ffd500"
TEXT = "#f3f3f3"
MUTED = "#a9a9a9"


class Launcher(tk.Tk):
    """Collect launcher options and run the shared backend in a worker thread."""

    def __init__(self, *, offline: bool = False) -> None:
        super().__init__()
        self.title("Navix | Smart Router")
        self.configure(bg=BG)
        self.geometry("700x900")
        self.minsize(640, 700)
        self._events: queue.Queue[tuple[str, object]] = queue.Queue()
        self._interactive_widgets: list[tk.Misc] = []
        self._preflight_ready = False
        self._network_ok = False
        self._initial_offline = offline
        self._busy = False
        self._saved_env = ""
        self._saved_options = {}
        self._release_url = None
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._close)
        self._set_controls_enabled(False)
        self._poll_id = self.after(100, self._drain_events)
        threading.Thread(
            target=self._preflight_worker, args=(self._initial_offline, self._events), daemon=True
        ).start()

    def _build(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Navix.TFrame", background=BG)
        style.configure("Navix.TLabel", background=BG, foreground=TEXT, font=("Arial", 11))
        style.configure("Muted.TLabel", background=BG, foreground=MUTED, font=("Arial", 10))
        style.configure("Navix.TCheckbutton", background=BG, foreground=TEXT)
        style.configure("Navix.TButton", background=YELLOW, foreground="#111111", padding=8)
        outer = ttk.Frame(self, style="Navix.TFrame")
        outer.pack(fill="both", expand=True)
        canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        scrollbar = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        root = ttk.Frame(canvas, style="Navix.TFrame", padding=24)
        window = canvas.create_window((0, 0), window=root, anchor="nw")
        root.bind("<Configure>", lambda _: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda event: canvas.itemconfigure(window, width=event.width))
        tk.Label(root, text="NAVIX", bg=BG, fg=YELLOW, font=("Arial", 28, "bold")).pack(anchor="w")
        ttk.Label(root, text="Smart Router launcher", style="Muted.TLabel").pack(
            anchor="w", pady=(0, 18)
        )
        self.installation_var = tk.StringVar(value="Проверка установки…")
        ttk.Label(
            root, textvariable=self.installation_var, style="Navix.TLabel", wraplength=590
        ).pack(anchor="w", pady=(0, 8))
        self.version_var = tk.StringVar(value="Проверка версии…")
        ttk.Label(root, textvariable=self.version_var, style="Muted.TLabel", wraplength=590).pack(
            anchor="w", pady=(0, 8)
        )
        self.download_button = ttk.Button(
            root,
            text="Скачать новую версию",
            command=lambda: webbrowser.open(self._release_url) if self._release_url else None,
        )
        self.management = ttk.Frame(root, style="Navix.TFrame")
        self.management.pack(fill="x", pady=(0, 12))
        self.restart_button = ttk.Button(
            self.management, text="Запуск с сохранёнными", command=self._restart
        )
        self.restart_button.pack(side="left", padx=(0, 6))
        self.remove_button = ttk.Button(
            self.management, text="Удалить экземпляр", command=lambda: self._remove(False)
        )
        self.remove_button.pack(side="left", padx=(0, 6))
        self.purge_button = ttk.Button(
            self.management, text="Удалить с данными", command=lambda: self._remove(True)
        )
        self.purge_button.pack(side="left")
        self._interactive_widgets.extend(
            (self.restart_button, self.remove_button, self.purge_button)
        )
        form = tk.Frame(root, bg=PANEL, padx=18, pady=16)
        self.form = form
        form.pack(fill="x")
        self.online = tk.BooleanVar(value=not self._initial_offline)
        self.osrm = tk.BooleanVar(value=False)
        self.autostart = tk.BooleanVar(value=False)
        self.redis_beta = tk.BooleanVar(value=False)
        for index, (text, variable) in enumerate(
            (
                ("Online режим", self.online),
                ("OSRM маршрутизация", self.osrm),
                ("Автозапуск", self.autostart),
                ("Redis-beta · экспериментальный кэш", self.redis_beta),
            )
        ):
            checkbox = tk.Checkbutton(
                form,
                text=text,
                variable=variable,
                bg=PANEL,
                fg=TEXT,
                selectcolor=PANEL,
                activebackground=PANEL,
                activeforeground=TEXT,
            )
            checkbox.pack(anchor="w")
            self._interactive_widgets.append(checkbox)
            if index == 0:
                self.online_checkbox = checkbox
        self.network_hint = tk.StringVar(
            value="Офлайн: данные остаются локально; AI и внешние карты отключены."
        )
        tk.Label(
            form,
            textvariable=self.network_hint,
            bg=PANEL,
            fg=MUTED,
            justify="left",
            anchor="w",
        ).pack(anchor="w", pady=(8, 0))
        row = tk.Frame(form, bg=PANEL)
        row.pack(fill="x", pady=(14, 0))
        tk.Label(row, text="Режим", bg=PANEL, fg=TEXT).pack(side="left")
        self.mode = ttk.Combobox(row, values=("full", "headless"), state="readonly", width=12)
        self.mode.set("full")
        self.mode.pack(side="left", padx=12)
        self._interactive_widgets.append(self.mode)
        self.api_port = self._entry(row, "API port", "")
        self.ui_port = self._entry(row, "UI port*", "5173")
        self._interactive_widgets.extend((self.api_port, self.ui_port))
        secrets = tk.LabelFrame(root, text="Доступ и настройки", bg=BG, fg=TEXT, padx=12, pady=8)
        secrets.pack(fill="x", pady=18)
        self.pin = self._labeled_entry(secrets, "PIN (рекомендуется)", masked=True)
        self.email = self._labeled_entry(secrets, "Почта диспетчера")
        self.password = self._labeled_entry(
            secrets, "Пароль диспетчера (пусто — сохранить существующий)", masked=True
        )
        self.llm_token = self._labeled_entry(secrets, "LLM_TOKEN", masked=True)
        self.llm_provider = self._labeled_entry(secrets, "LLM_PROVIDER")
        self.llm_base_url = self._labeled_entry(secrets, "LLM_BASE_URL")
        self._interactive_widgets.extend(
            (
                self.pin,
                self.email,
                self.password,
                self.llm_token,
                self.llm_provider,
                self.llm_base_url,
            )
        )
        self.env_path = tk.StringVar()
        self.env_button = tk.Button(
            secrets,
            text="Импорт .env",
            command=self._choose_env,
            bg="#343434",
            fg=TEXT,
            relief="flat",
        )
        self.env_button.pack(anchor="w", pady=(8, 0))
        self._interactive_widgets.append(self.env_button)
        tk.Label(secrets, textvariable=self.env_path, bg=BG, fg=MUTED).pack(anchor="w")
        self.log = tk.Text(
            root,
            height=10,
            bg="#0e0e0e",
            fg="#d7d7d7",
            insertbackground=TEXT,
            relief="flat",
            state="disabled",
        )
        self.log.pack(fill="both", expand=True, pady=(0, 14))
        self.start_button = ttk.Button(
            root, text="Запустить Navix", style="Navix.TButton", command=self._start
        )
        self.start_button.pack(fill="x")

        self.status_var = tk.StringVar(value="Проверка целостности и Docker…")
        ttk.Label(root, textvariable=self.status_var, style="Muted.TLabel").pack(
            anchor="w", pady=(0, 8), before=self.start_button
        )

    def _set_controls_enabled(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        for widget in self._interactive_widgets:
            try:
                widget.configure(
                    state="readonly" if enabled and isinstance(widget, ttk.Combobox) else state
                )
            except tk.TclError:
                pass
        self.start_button.configure(state=state)
        if not self._network_ok:
            self.pin.configure(state="disabled")

    def _close(self) -> None:
        if self._busy:
            messagebox.showinfo(
                "Navix", "Операция ещё выполняется. Дождитесь результата перед закрытием лаунчера."
            )
            return
        self.destroy()

    def destroy(self) -> None:
        """Cancel the Tcl timer before disposing the native window."""
        if getattr(self, "_poll_id", None):
            self.after_cancel(self._poll_id)
            self._poll_id = None
        super().destroy()

    def _begin(self, target, args: tuple = ()) -> None:
        self._busy = True
        self._set_controls_enabled(False)
        self.status_var.set("Выполняется…")
        threading.Thread(target=target, args=(*args, self._events), daemon=True).start()

    def _apply_installation(self, status: dict, env_text: str) -> None:
        self._saved_env = env_text
        self._saved_options = status["options"]
        labels = {
            "new": "Новая установка",
            "running": "Установка работает",
            "stopped": "Установка остановлена",
            "partial": "Подготовка не завершена — можно повторить запуск",
            "removed": "Экземпляр удалён; данные и настройки сохранены",
        }
        self.installation_var.set(labels[status["status"]])
        if self._saved_options.get("redis_beta"):
            self.installation_var.set(
                self.installation_var.get()
                + (
                    " · Redis-beta готов"
                    if status.get("redis_ready")
                    else " · Redis-beta недоступен, обычный расчёт сохранён"
                )
            )
        if not status["record"]:
            self.management.pack_forget()
            self.start_button.configure(text="Установить и запустить")
            self.redis_beta.set(False)
            for entry in (self.password, self.pin, self.llm_token):
                entry.configure(state="normal")
                entry.delete(0, "end")
            self.env_path.set("")
            self._set_controls_enabled(self._preflight_ready and not self._busy)
            return
        if not self.management.winfo_manager():
            self.management.pack(fill="x", pady=(0, 12), before=self.form)
        self.start_button.configure(text="Применить настройки и запустить")
        options = self._saved_options
        for key, variable in (
            ("online", self.online),
            ("osrm", self.osrm),
            ("autostart", self.autostart),
            ("redis_beta", self.redis_beta),
        ):
            if key in options:
                variable.set(options[key])
        if self._initial_offline:
            self.online.set(False)
        if options.get("mode"):
            self.mode.set(options["mode"])
        for key, entry in (("api_port", self.api_port), ("ui_port", self.ui_port)):
            entry.configure(state="normal")
            entry.delete(0, "end")
            if options.get(key):
                entry.insert(0, str(options[key]))
        values = cli._core().parse_env(env_text) if env_text else {}
        self.email.configure(state="normal")
        self.email.delete(0, "end")
        self.email.insert(0, values.get("DISPATCHER_EMAIL", ""))
        self._set_controls_enabled(self._preflight_ready and not self._busy)

    def _restart(self) -> None:
        if not self._saved_env or not self._saved_options:
            messagebox.showinfo(
                "Navix",
                "Подготовка не завершена. Заполните настройки и нажмите «Применить настройки и запустить».",
            )
            return
        options = dict(self._saved_options)
        if self._initial_offline:
            options["online"] = False
        self._begin(self._restart_worker, (options, self._saved_env))

    @staticmethod
    def _restart_worker(options: dict, saved_env: str, events: queue.Queue) -> None:
        try:
            result = cli._core().launch(options, saved_env, lambda msg: events.put(("log", msg)))
            events.put(("done", result))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            events.put(("error", str(exc)))

    def _remove(self, purge: bool) -> None:
        self._begin(self._removal_preview_worker, (purge,))

    @staticmethod
    def _removal_preview_worker(purge: bool, events: queue.Queue) -> None:
        try:
            events.put(("remove_confirm", (purge, cli._core().removal_preview())))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            events.put(("error", str(exc)))

    @staticmethod
    def _remove_worker(purge: bool, confirmation: str, events: queue.Queue) -> None:
        try:
            cli._core().remove_installation(
                purge_data=purge,
                confirmation=confirmation,
                log=lambda msg: events.put(("log", msg)),
            )
            events.put(
                ("removed", (cli._core().installation_status(), cli._core().saved_environment()))
            )
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            events.put(("error", str(exc)))

    def _entry(self, parent: tk.Misc, label: str, value: str) -> tk.Entry:
        frame = tk.Frame(parent, bg=PANEL)
        frame.pack(side="left", padx=8)
        tk.Label(frame, text=label, bg=PANEL, fg=MUTED).pack()
        entry = tk.Entry(
            frame, width=8, bg="#303030", fg=TEXT, insertbackground=TEXT, relief="flat"
        )
        entry.insert(0, value)
        entry.pack()
        return entry

    def _labeled_entry(self, parent: tk.Misc, label: str, masked: bool = False) -> tk.Entry:
        tk.Label(parent, text=label, bg=BG, fg=TEXT).pack(anchor="w")
        entry = tk.Entry(
            parent,
            show="*" if masked else "",
            bg="#303030",
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
        )
        entry.pack(fill="x", pady=(3, 0))
        return entry

    def _choose_env(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=(("Environment files", ".env"), ("All files", "*"))
        )
        if path:
            self.env_path.set(path)

    def _append(self, message: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", message + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _start(self) -> None:
        if not self._preflight_ready:
            return
        try:
            api_port = int(self.api_port.get()) if self.api_port.get().strip() else None
            ui_port = int(self.ui_port.get()) if self.ui_port.get().strip() else None
        except ValueError:
            messagebox.showerror("Navix", "Порты должны быть целыми числами.")
            return
        if self.mode.get() == "full" and ui_port is None:
            messagebox.showerror("Navix", "Для full режима нужен UI port.")
            return
        options = {
            "online": self.online.get(),
            "osrm": self.osrm.get(),
            "mode": self.mode.get(),
            "api_port": api_port,
            "ui_port": ui_port,
            "autostart": self.autostart.get(),
            "redis_beta": self.redis_beta.get(),
        }
        env_path = Path(self.env_path.get()) if self.env_path.get() else None
        pin = self.pin.get().strip()
        manual_values = {
            "LLM_TOKEN": self.llm_token.get(),
            "LLM_PROVIDER": self.llm_provider.get(),
            "LLM_BASE_URL": self.llm_base_url.get(),
        }
        manual_env_text = "\n".join(
            f"{key}={value}" for key, value in manual_values.items() if value
        )
        email = self.email.get().strip()
        previous = cli._core().parse_env(self._saved_env) if self._saved_env else {}
        password = self.password.get() or previous.get("DISPATCHER_PASSWORD", "")
        if not email or len(password) < 8:
            messagebox.showerror(
                "Navix",
                "Введите почту диспетчера и пароль длиной не менее 8 символов.",
            )
            return
        self.status_var.set("Запуск…")
        self._append("Запуск проверки…")
        self._begin(
            self._worker,
            (
                options,
                env_path,
                pin,
                manual_env_text,
                email,
                password,
                self._saved_env,
                self._network_ok,
            ),
        )

    @staticmethod
    def _preflight_worker(offline: bool, events: queue.Queue) -> None:
        try:
            core = cli._core()
            errors = list(core.check_integrity())
            if errors:
                response: dict[str, bool] = {"accepted": False}
                answer = threading.Event()
                events.put(("integrity", (errors, response, answer)))
                answer.wait()
                if not response["accepted"]:
                    events.put(("preflight_failed", "Проверка целостности не подтверждена."))
                    return
            docker_ok, docker_message = core.check_docker()
            while not docker_ok:
                response = {"retry": False}
                answer = threading.Event()
                events.put(("docker_retry", (docker_message, response, answer)))
                answer.wait()
                if not response["retry"]:
                    events.put(
                        (
                            "preflight_failed",
                            "Docker недоступен. Установите Docker: https://docs.docker.com/get-docker/",
                        )
                    )
                    return
                docker_ok, docker_message = core.check_docker()
            events.put(("installation", (core.installation_status(), core.saved_environment())))
            network_ok = not offline and bool(core.check_network())
            events.put(("version", core.check_version(online=not offline)))
            events.put(("preflight_done", network_ok))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            events.put(("preflight_failed", str(exc)))

    @staticmethod
    def _worker(
        options: dict[str, object],
        env_path: Path | None,
        pin: str,
        manual_env_text: str,
        email: str,
        password: str,
        saved_env: str,
        network_ok: bool,
        events: queue.Queue,
    ) -> None:
        try:
            core = cli._core()
            if env_path:
                env_text = core.read_env(env_path)
            elif pin:
                if not network_ok:
                    raise RuntimeError(
                        "PIN недоступен без сети; используйте .env или ручной ввод секретов."
                    )
                env_text = core.fetch_secrets(pin)
            else:
                env = core.parse_env(saved_env) if saved_env else {}
                env.update(core.parse_env(manual_env_text))
                env_text = "\n".join(
                    f"{key}=" + json.dumps(value, ensure_ascii=False) for key, value in env.items()
                )
            env_text = cli._core().override_dispatcher_credentials(env_text, email, password)
            result = core.launch(options, env_text, lambda msg: events.put(("log", msg)))
            events.put(("done", result))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            events.put(("error", str(exc)))

    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self._events.get_nowait()
                if kind == "log":
                    self._append(str(payload))
                elif kind == "installation":
                    self._apply_installation(*payload)
                elif kind == "version":
                    self.version_var.set(versions.message(payload))
                    self._release_url = (
                        payload["download_url"]
                        if payload["status"] in ("update_available", "unknown_local", "development")
                        else None
                    )
                    if self._release_url:
                        self.download_button.pack(anchor="w", pady=(0, 10), before=self.form)
                elif kind == "remove_confirm":
                    purge, preview = payload
                    description = f"Экземпляр: {preview['project']}\nТома: {', '.join(preview['volumes']) or 'нет'}"
                    confirmation = ""
                    if purge:
                        confirmation = (
                            simpledialog.askstring(
                                "Удалить данные Navix",
                                description
                                + f"\n\nДля безвозвратного удаления введите DELETE {preview['project']}:",
                            )
                            or ""
                        )
                        accepted = confirmation == f"DELETE {preview['project']}"
                    else:
                        accepted = messagebox.askyesno(
                            "Удалить экземпляр Navix",
                            description + "\n\nУдалить контейнеры? Данные и настройки сохранятся.",
                        )
                    if accepted:
                        threading.Thread(
                            target=self._remove_worker,
                            args=(purge, confirmation, self._events),
                            daemon=True,
                        ).start()
                    else:
                        self._busy = False
                        self._set_controls_enabled(True)
                        self.status_var.set("Удаление отменено")
                elif kind == "removed":
                    self._busy = False
                    self._apply_installation(*payload)
                    self._set_controls_enabled(True)
                    self.status_var.set("Удаление завершено")
                elif kind == "integrity":
                    errors, response, answer = payload
                    for error in errors:
                        self._append(f"[integrity] {error}")
                    response["accepted"] = messagebox.askyesno(
                        "Navix",
                        "Проверка целостности не прошла. Повторите установку:\n"
                        f"{cli.SOURCE}\n\nПродолжить несмотря на ошибки?",
                    )
                    answer.set()
                elif kind == "docker_retry":
                    message, response, answer = payload
                    self._append(f"[docker] {message}")
                    response["retry"] = messagebox.askretrycancel(
                        "Navix",
                        "Docker недоступен. Повторить проверку?\nУстановка: https://docs.docker.com/get-docker/",
                    )
                    answer.set()
                elif kind == "preflight_done":
                    network_ok = bool(payload)
                    self._network_ok = network_ok
                    self._preflight_ready = True
                    self._set_controls_enabled(True)
                    if not network_ok:
                        self.pin.configure(state="disabled")
                        self.network_hint.set(
                            "Дистрибуция недоступна. Используйте сохранённые настройки или .env."
                        )
                        self._append(
                            "[network] дистрибуция недоступна; режим запуска выбирается отдельно."
                        )
                        self.status_var.set("Готово · дистрибуция недоступна")
                    else:
                        self.network_hint.set(
                            "Online: доступны AI и внешние карты; офлайн сохраняет данные локально."
                        )
                        self.status_var.set("Готово · сеть доступна")
                elif kind == "preflight_failed":
                    self.status_var.set("Preflight остановлен")
                    self._append(f"Ошибка preflight: {payload}")
                elif kind == "done":
                    self._busy = False
                    self._append(
                        "Готово: " + ", ".join(f"{k}={v}" for k, v in dict(payload).items())
                    )
                    self.status_var.set("Запуск завершён")
                    self._set_controls_enabled(True)
                    threading.Thread(
                        target=self._reload_installation, args=(self._events,), daemon=True
                    ).start()
                else:
                    self._busy = False
                    self._append(f"Ошибка: {payload}")
                    self.status_var.set("Ошибка")
                    self._set_controls_enabled(True)
        except queue.Empty:
            pass
        self._poll_id = self.after(100, self._drain_events)

    @staticmethod
    def _reload_installation(events: queue.Queue) -> None:
        try:
            events.put(
                (
                    "installation",
                    (cli._core().installation_status(), cli._core().saved_environment()),
                )
            )
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            events.put(("log", str(exc)))


def main() -> None:
    """Start the GUI; explicit offline mode performs no distribution request."""
    parser = argparse.ArgumentParser(description="Navix GUI launcher")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    Launcher(offline=args.offline).mainloop()


if __name__ == "__main__":
    main()
