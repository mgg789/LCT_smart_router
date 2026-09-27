"""Small non-blocking Tkinter launcher for Navix."""

from __future__ import annotations

import queue
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from . import cli

BG = "#151515"
PANEL = "#202020"
YELLOW = "#ffd500"
TEXT = "#f3f3f3"
MUTED = "#a9a9a9"


class Launcher(tk.Tk):
    """Collect launcher options and run the shared backend in a worker thread."""

    def __init__(self) -> None:
        super().__init__()
        self.title("Navix | Smart Router")
        self.configure(bg=BG)
        self.geometry("620x700")
        self.minsize(560, 620)
        self._events: queue.Queue[tuple[str, object]] = queue.Queue()
        self._interactive_widgets: list[tk.Misc] = []
        self._preflight_ready = False
        self._network_ok = False
        self._build()
        self._set_controls_enabled(False)
        self.after(100, self._drain_events)
        threading.Thread(target=self._preflight_worker, daemon=True).start()

    def _build(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Navix.TFrame", background=BG)
        style.configure(
            "Navix.TLabel", background=BG, foreground=TEXT, font=("Arial", 11)
        )
        style.configure(
            "Muted.TLabel", background=BG, foreground=MUTED, font=("Arial", 10)
        )
        style.configure("Navix.TCheckbutton", background=BG, foreground=TEXT)
        style.configure(
            "Navix.TButton", background=YELLOW, foreground="#111111", padding=8
        )
        root = ttk.Frame(self, style="Navix.TFrame", padding=24)
        root.pack(fill="both", expand=True)
        tk.Label(root, text="NAVIX", bg=BG, fg=YELLOW, font=("Arial", 28, "bold")).pack(
            anchor="w"
        )
        ttk.Label(root, text="Smart Router launcher", style="Muted.TLabel").pack(
            anchor="w", pady=(0, 18)
        )
        form = tk.Frame(root, bg=PANEL, padx=18, pady=16)
        form.pack(fill="x")
        self.online = tk.BooleanVar(value=True)
        self.osrm = tk.BooleanVar(value=False)
        self.autostart = tk.BooleanVar(value=False)
        for index, (text, variable) in enumerate(
            (
                ("Online режим", self.online),
                ("OSRM маршрутизация", self.osrm),
                ("Автозапуск", self.autostart),
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
        self.mode = ttk.Combobox(
            row, values=("full", "headless"), state="readonly", width=12
        )
        self.mode.set("full")
        self.mode.pack(side="left", padx=12)
        self._interactive_widgets.append(self.mode)
        self.api_port = self._entry(row, "API port", "")
        self.ui_port = self._entry(row, "UI port*", "5173")
        self._interactive_widgets.extend((self.api_port, self.ui_port))
        secrets = tk.LabelFrame(root, text="Секреты", bg=BG, fg=TEXT, padx=12, pady=8)
        secrets.pack(fill="x", pady=18)
        self.pin = self._labeled_entry(secrets, "PIN (рекомендуется)")
        self.email = self._labeled_entry(secrets, "DISPATCHER_EMAIL")
        self.password = self._labeled_entry(secrets, "DISPATCHER_PASSWORD", masked=True)
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
                widget.configure(state=state)
            except tk.TclError:
                pass
        self.start_button.configure(state=state)

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

    def _labeled_entry(
        self, parent: tk.Misc, label: str, masked: bool = False
    ) -> tk.Entry:
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
        }
        env_path = Path(self.env_path.get()) if self.env_path.get() else None
        pin = self.pin.get().strip()
        manual_values = {
            "DISPATCHER_EMAIL": self.email.get(),
            "DISPATCHER_PASSWORD": self.password.get(),
            "LLM_TOKEN": self.llm_token.get(),
            "LLM_PROVIDER": self.llm_provider.get(),
            "LLM_BASE_URL": self.llm_base_url.get(),
        }
        manual_env_text = "\n".join(
            f"{key}={value}" for key, value in manual_values.items() if value
        )
        self.start_button.configure(state="disabled")
        self.status_var.set("Запуск…")
        self._append("Запуск проверки…")
        threading.Thread(
            target=self._worker,
            args=(options, env_path, pin, manual_env_text),
            daemon=True,
        ).start()

    def _preflight_worker(self) -> None:
        try:
            core = cli._core()
            errors = list(core.check_integrity())
            if errors:
                response: dict[str, bool] = {"accepted": False}
                answer = threading.Event()
                self._events.put(("integrity", (errors, response, answer)))
                answer.wait()
                if not response["accepted"]:
                    self._events.put(
                        ("preflight_failed", "Проверка целостности не подтверждена.")
                    )
                    return
            docker_ok, docker_message = core.check_docker()
            while not docker_ok:
                response = {"retry": False}
                answer = threading.Event()
                self._events.put(("docker_retry", (docker_message, response, answer)))
                answer.wait()
                if not response["retry"]:
                    self._events.put(
                        (
                            "preflight_failed",
                            "Docker недоступен. Установите Docker: https://docs.docker.com/get-docker/",
                        )
                    )
                    return
                docker_ok, docker_message = core.check_docker()
            network_ok = bool(core.check_network())
            self._events.put(("preflight_done", network_ok))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            self._events.put(("preflight_failed", str(exc)))

    def _worker(
        self,
        options: dict[str, object],
        env_path: Path | None,
        pin: str,
        manual_env_text: str,
    ) -> None:
        try:
            core = cli._core()
            if env_path:
                env_text = core.read_env(env_path)
            elif pin:
                if not self._network_ok:
                    raise RuntimeError(
                        "PIN недоступен без сети; используйте .env или ручной ввод секретов."
                    )
                env_text = core.fetch_secrets(pin)
            else:
                env_text = manual_env_text
            result = core.launch(
                options, env_text, lambda msg: self._events.put(("log", msg))
            )
            self._events.put(("done", result))
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            self._events.put(("error", str(exc)))

    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self._events.get_nowait()
                if kind == "log":
                    self._append(str(payload))
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
                        self.online.set(False)
                        self.online_checkbox.configure(state="disabled")
                        self.pin.configure(state="disabled")
                        self.network_hint.set(
                            "Офлайн: данные остаются локально; AI и внешние карты отключены."
                        )
                        self._append(
                            "[network] сеть недоступна; online режим отключён."
                        )
                        self.status_var.set("Готово · офлайн")
                    else:
                        self.network_hint.set(
                            "Online: доступны AI и внешние карты; офлайн сохраняет данные локально."
                        )
                        self.status_var.set("Готово · сеть доступна")
                elif kind == "preflight_failed":
                    self.status_var.set("Preflight остановлен")
                    self._append(f"Ошибка preflight: {payload}")
                elif kind == "done":
                    self._append(
                        "Готово: "
                        + ", ".join(f"{k}={v}" for k, v in dict(payload).items())
                    )
                    self.status_var.set("Запуск завершён")
                    self.start_button.configure(state="normal")
                else:
                    self._append(f"Ошибка: {payload}")
                    self.status_var.set("Ошибка")
                    self.start_button.configure(state="normal")
        except queue.Empty:
            pass
        self.after(100, self._drain_events)


def main() -> None:
    Launcher().mainloop()


if __name__ == "__main__":
    main()
