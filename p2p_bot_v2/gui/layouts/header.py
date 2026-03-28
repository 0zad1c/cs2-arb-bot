"""
gui/layouts/header.py
Barra superior: logo, estado global del bot, nivel de mercado, última actualización.
"""
import customtkinter as ctk
from datetime import datetime


# Colores por nivel de mercado
LEVEL_COLORS = {
    "ARRANQUE": "#ffd32a",
    "FROZEN":   "#6c7a89",
    "NORMAL":   "#00d4ff",
    "ACTIVO":   "#00ff9f",
    "EXPLOSIVO": "#ff4757",
}


class HeaderBar(ctk.CTkFrame):
    """
    Barra fija en la parte superior de la ventana.
    Muestra: Logo | Título | Estado (círculo + texto) | Nivel mercado | Timestamp.
    """

    def __init__(self, master, **kwargs):
        super().__init__(
            master,
            fg_color="#0f0f1a",
            corner_radius=0,
            height=56,
            **kwargs,
        )
        self.pack_propagate(False)
        self._cycle_count = 0
        self._build()

    def _build(self):
        # ── Logo + Título ──────────────────────────────────────────────────────
        left = ctk.CTkFrame(self, fg_color="transparent")
        left.pack(side="left", padx=16)

        ctk.CTkLabel(
            left,
            text="P2P",
            font=ctk.CTkFont("Segoe UI", 20, "bold"),
            text_color="#00d4ff",
        ).pack(side="left")

        ctk.CTkLabel(
            left,
            text=" BOT PRO v2",
            font=ctk.CTkFont("Segoe UI", 14),
            text_color="#e0e0e0",
        ).pack(side="left")

        ctk.CTkLabel(
            left,
            text="  SIMULACION",
            font=ctk.CTkFont("Segoe UI", 9),
            text_color="#ffd32a",
            fg_color="#2a2a1a",
            corner_radius=4,
        ).pack(side="left", padx=6)

        # ── Estado del bot (centro) ────────────────────────────────────────────
        center = ctk.CTkFrame(self, fg_color="transparent")
        center.pack(side="left", expand=True)

        self._status_dot = ctk.CTkLabel(
            center,
            text="●",
            font=ctk.CTkFont("Segoe UI", 18),
            text_color="#6c7a89",
        )
        self._status_dot.pack(side="left", padx=(0, 4))

        self._status_label = ctk.CTkLabel(
            center,
            text="DETENIDO",
            font=ctk.CTkFont("Segoe UI", 13, "bold"),
            text_color="#6c7a89",
        )
        self._status_label.pack(side="left")

        # ── Nivel de mercado ───────────────────────────────────────────────────
        self._level_badge = ctk.CTkLabel(
            center,
            text="  ---  ",
            font=ctk.CTkFont("Segoe UI", 10, "bold"),
            fg_color="#1a1a2e",
            corner_radius=8,
            text_color="#6c7a89",
        )
        self._level_badge.pack(side="left", padx=12)

        # Ciclos
        self._cycles_label = ctk.CTkLabel(
            center,
            text="Ciclos: 0",
            font=ctk.CTkFont("Segoe UI", 10),
            text_color="#6c7a89",
        )
        self._cycles_label.pack(side="left", padx=8)

        # ── Timestamp (derecha) ────────────────────────────────────────────────
        right = ctk.CTkFrame(self, fg_color="transparent")
        right.pack(side="right", padx=16)

        self._time_label = ctk.CTkLabel(
            right,
            text="--:--:--",
            font=ctk.CTkFont("Segoe UI", 10),
            text_color="#6c7a89",
        )
        self._time_label.pack()

    # ── API pública ───────────────────────────────────────────────────────────

    def set_running(self, running: bool) -> None:
        """Actualiza el indicador de estado del bot."""
        if running:
            self._status_dot.configure(text_color="#00ff9f")
            self._status_label.configure(text="ACTIVO", text_color="#00ff9f")
        else:
            self._status_dot.configure(text_color="#6c7a89")
            self._status_label.configure(text="DETENIDO", text_color="#6c7a89")

    def set_market_level(self, level: str) -> None:
        """Actualiza el badge de nivel de mercado con color dinámico."""
        color = LEVEL_COLORS.get(level, "#6c7a89")
        self._level_badge.configure(
            text=f"  {level}  ",
            text_color=color,
            fg_color="#1a1a2e",
        )

    def set_cycle(self, count: int) -> None:
        self._cycles_label.configure(text=f"Ciclos: {count}")

    def update_timestamp(self) -> None:
        now = datetime.now().strftime("%H:%M:%S")
        self._time_label.configure(text=now)
