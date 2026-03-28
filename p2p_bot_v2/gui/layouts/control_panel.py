"""
gui/layouts/control_panel.py
Panel izquierdo de control: configuración del bot, botones Start/Stop y log stream.
"""
import json
import re
import threading
from pathlib import Path
from typing import Callable

import customtkinter as ctk

PREFS_FILE = Path(__file__).parent.parent.parent / "p2p_gui_prefs.json"
BANKS = ["Banesco", "Provincial", "Mercantil", "Venezuela", "BOD", "BNC", "Banplus"]
PAYMENT_METHODS = ["PagoMovil", "Transferencia", "Zelle", "Efectivo"]

# Colores
BG_PANEL = "#16213e"
BG_CARD  = "#1a1a2e"
ACCENT   = "#00d4ff"
DANGER   = "#ff4757"
TEXT     = "#e0e0e0"
MUTED    = "#6c7a89"


class ControlPanel(ctk.CTkFrame):
    """
    Panel izquierdo (280px fijo).
    Contiene: configuración, botones Start/Stop y log stream en vivo.
    """

    def __init__(
        self,
        master,
        on_start: Callable,
        on_stop: Callable,
        **kwargs,
    ):
        super().__init__(
            master,
            width=280,
            fg_color=BG_PANEL,
            corner_radius=0,
            **kwargs,
        )
        self.pack_propagate(False)
        self._on_start = on_start
        self._on_stop = on_stop
        self._log_lock = threading.Lock()
        self._log_lines = 0
        self._build()
        self._load_prefs()

    # ── Construcción ──────────────────────────────────────────────────────────

    def _build(self):
        # Título del panel
        ctk.CTkLabel(
            self,
            text="CONFIGURACION",
            font=ctk.CTkFont("Segoe UI", 10, "bold"),
            text_color=MUTED,
        ).pack(anchor="w", padx=16, pady=(16, 4))

        # ── Card de configuración ─────────────────────────────────────────────
        card = ctk.CTkFrame(self, fg_color=BG_CARD, corner_radius=10)
        card.pack(fill="x", padx=12, pady=4)

        # Monto VES
        ctk.CTkLabel(card, text="Monto en VES (0 = sin filtro)",
                     font=ctk.CTkFont("Segoe UI", 10), text_color=TEXT).pack(
            anchor="w", padx=12, pady=(12, 2))

        self._entry_amount = ctk.CTkEntry(
            card,
            placeholder_text="0.00",
            font=ctk.CTkFont("Segoe UI", 12),
            fg_color="#0f0f1a",
            border_color=ACCENT,
            text_color=TEXT,
        )
        self._entry_amount.pack(fill="x", padx=12, pady=(0, 8))
        self._entry_amount.bind("<FocusOut>", self._validate_amount)

        # Banco principal
        ctk.CTkLabel(card, text="Banco principal",
                     font=ctk.CTkFont("Segoe UI", 10), text_color=TEXT).pack(
            anchor="w", padx=12, pady=(4, 2))

        self._combo_bank = ctk.CTkComboBox(
            card,
            values=BANKS,
            fg_color="#0f0f1a",
            button_color=ACCENT,
            border_color=ACCENT,
            text_color=TEXT,
            font=ctk.CTkFont("Segoe UI", 12),
        )
        self._combo_bank.pack(fill="x", padx=12, pady=(0, 8))

        # Delay
        ctk.CTkLabel(card, text="Intervalo (seg)",
                     font=ctk.CTkFont("Segoe UI", 10), text_color=TEXT).pack(
            anchor="w", padx=12, pady=(4, 2))

        delay_row = ctk.CTkFrame(card, fg_color="transparent")
        delay_row.pack(fill="x", padx=12, pady=(0, 8))

        self._delay_value_label = ctk.CTkLabel(
            delay_row, text="5s", font=ctk.CTkFont("Segoe UI", 11, "bold"),
            text_color=ACCENT, width=30)
        self._delay_value_label.pack(side="right")

        self._slider_delay = ctk.CTkSlider(
            delay_row, from_=1, to=30, number_of_steps=29,
            progress_color=ACCENT, button_color=ACCENT,
            command=self._on_delay_change,
        )
        self._slider_delay.set(5)
        self._slider_delay.pack(side="left", fill="x", expand=True)

        # Métodos de pago
        ctk.CTkLabel(card, text="Metodos de pago",
                     font=ctk.CTkFont("Segoe UI", 10), text_color=TEXT).pack(
            anchor="w", padx=12, pady=(4, 2))

        self._method_vars = {}
        for method in PAYMENT_METHODS:
            var = ctk.BooleanVar(value=(method == "PagoMovil"))
            self._method_vars[method] = var
            ctk.CTkCheckBox(
                card,
                text=method,
                variable=var,
                font=ctk.CTkFont("Segoe UI", 11),
                text_color=TEXT,
                checkmark_color=ACCENT,
                fg_color=ACCENT,
            ).pack(anchor="w", padx=16, pady=2)

        ctk.CTkLabel(card, text="", height=4).pack()  # spacer

        # ── Botones Start / Stop ──────────────────────────────────────────────
        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.pack(fill="x", padx=12, pady=8)

        self._btn_start = ctk.CTkButton(
            btn_frame,
            text="▶  INICIAR",
            font=ctk.CTkFont("Segoe UI", 13, "bold"),
            fg_color=ACCENT,
            text_color="#0f0f1a",
            hover_color="#00b8d9",
            corner_radius=8,
            height=40,
            command=self._start_clicked,
        )
        self._btn_start.pack(fill="x", pady=(0, 6))

        self._btn_stop = ctk.CTkButton(
            btn_frame,
            text="■  DETENER",
            font=ctk.CTkFont("Segoe UI", 13, "bold"),
            fg_color="#2a1a1e",
            text_color=DANGER,
            hover_color="#3a1a1e",
            border_color=DANGER,
            border_width=1,
            corner_radius=8,
            height=40,
            state="disabled",
            command=self._stop_clicked,
        )
        self._btn_stop.pack(fill="x")

        # ── Log Stream ────────────────────────────────────────────────────────
        ctk.CTkLabel(
            self,
            text="LOG EN VIVO",
            font=ctk.CTkFont("Segoe UI", 10, "bold"),
            text_color=MUTED,
        ).pack(anchor="w", padx=16, pady=(16, 4))

        self._log_box = ctk.CTkTextbox(
            self,
            fg_color=BG_CARD,
            text_color="#8be9fd",
            font=ctk.CTkFont("Consolas", 10),
            corner_radius=8,
            wrap="word",
            state="disabled",
        )
        self._log_box.pack(fill="both", expand=True, padx=12, pady=(0, 12))

    # ── Lógica de botones ─────────────────────────────────────────────────────

    def _start_clicked(self):
        if not self._validate_amount():
            return
        self._btn_start.configure(state="disabled")
        self._btn_stop.configure(state="normal")
        self._on_start(
            amount=self._get_amount(),
            bank=self._combo_bank.get(),
            methods=self._get_methods(),
            delay=int(self._slider_delay.get()),
        )

    def _stop_clicked(self):
        self._btn_stop.configure(state="disabled")
        self._btn_start.configure(state="normal")
        self._on_stop()

    def _on_delay_change(self, value):
        self._delay_value_label.configure(text=f"{int(value)}s")

    # ── Validación ────────────────────────────────────────────────────────────

    def _validate_amount(self, event=None) -> bool:
        text = self._entry_amount.get().strip() or "0"
        try:
            val = float(text)
            if val < 0:
                raise ValueError
            self._entry_amount.configure(border_color=ACCENT)
            return True
        except ValueError:
            self._entry_amount.configure(border_color=DANGER)
            return False

    def _get_amount(self) -> float:
        try:
            return float(self._entry_amount.get().strip() or "0")
        except ValueError:
            return 0.0

    def _get_methods(self) -> list:
        return [m for m, var in self._method_vars.items() if var.get()]

    # ── Log stream API ────────────────────────────────────────────────────────

    def append_log(self, line: str) -> None:
        """Añade una línea al log stream. Thread-safe vía CTk."""
        with self._log_lock:
            self._log_box.configure(state="normal")
            self._log_box.insert("end", line + "\n")
            self._log_lines += 1
            # Limitar a 200 líneas
            if self._log_lines > 200:
                self._log_box.delete("1.0", "3.0")
                self._log_lines -= 2
            self._log_box.configure(state="disabled")
            self._log_box.see("end")

    # ── Re-enable start button ────────────────────────────────────────────────

    def reset_buttons(self) -> None:
        """Resetea botones al estado inicial (bot detenido)."""
        self._btn_start.configure(state="normal")
        self._btn_stop.configure(state="disabled")

    # ── Preferencias ─────────────────────────────────────────────────────────

    def _load_prefs(self) -> None:
        """Carga las preferencias guardadas del archivo JSON."""
        if not PREFS_FILE.exists():
            return
        try:
            with open(PREFS_FILE, "r") as f:
                prefs = json.load(f)
            amount = prefs.get("amount", "0")
            self._entry_amount.insert(0, str(amount))
            bank = prefs.get("bank", BANKS[0])
            if bank in BANKS:
                self._combo_bank.set(bank)
            delay = prefs.get("delay", 5)
            self._slider_delay.set(delay)
            self._delay_value_label.configure(text=f"{int(delay)}s")
            for method, state in prefs.get("methods", {}).items():
                if method in self._method_vars:
                    self._method_vars[method].set(state)
        except Exception:
            pass

    def save_prefs(self) -> None:
        """Guarda las preferencias actuales al archivo JSON."""
        prefs = {
            "amount": self._entry_amount.get().strip() or "0",
            "bank": self._combo_bank.get(),
            "delay": int(self._slider_delay.get()),
            "methods": {m: var.get() for m, var in self._method_vars.items()},
        }
        try:
            with open(PREFS_FILE, "w") as f:
                json.dump(prefs, f, indent=2)
        except Exception:
            pass
