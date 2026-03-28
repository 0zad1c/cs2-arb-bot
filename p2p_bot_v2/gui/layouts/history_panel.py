"""
gui/layouts/history_panel.py
Panel derecho: gráfico matplotlib del spread histórico + tabla de oportunidades de la DB.
"""
import customtkinter as ctk
from tkinter import ttk
from collections import deque
from datetime import datetime
import matplotlib
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

BG_PANEL = "#16213e"
BG_CARD  = "#1a1a2e"
BG_PLOT  = "#0f0f1a"
ACCENT   = "#00d4ff"
GREEN    = "#00ff9f"
RED      = "#ff4757"
YELLOW   = "#ffd32a"
TEXT     = "#e0e0e0"
MUTED    = "#6c7a89"

HISTORY_LEN = 50


class HistoryPanel(ctk.CTkFrame):
    """
    Panel derecho (300px fijo).
    Contiene: gráfico matplotlib del spread en el tiempo + tabla de oportunidades detectadas.
    """

    def __init__(self, master, **kwargs):
        super().__init__(
            master,
            width=320,
            fg_color=BG_PANEL,
            corner_radius=0,
            **kwargs,
        )
        self.pack_propagate(False)
        self._spread_history: deque = deque(maxlen=HISTORY_LEN)
        self._target_history: deque = deque(maxlen=HISTORY_LEN)
        self._opp_count = 0
        self._build()

    # ── Construcción ──────────────────────────────────────────────────────────

    def _build(self):
        # ── Gráfico de Spread ─────────────────────────────────────────────────
        ctk.CTkLabel(
            self,
            text="GRAFICO DE SPREAD",
            font=ctk.CTkFont("Segoe UI", 10, "bold"),
            text_color=MUTED,
        ).pack(anchor="w", padx=16, pady=(16, 4))

        plot_frame = ctk.CTkFrame(self, fg_color=BG_CARD, corner_radius=10)
        plot_frame.pack(fill="x", padx=12, pady=(0, 8))

        self._fig, self._ax = plt.subplots(figsize=(3.2, 2.2), dpi=80)
        self._fig.patch.set_facecolor(BG_PLOT)
        self._ax.set_facecolor(BG_PLOT)
        self._ax.tick_params(colors=MUTED, labelsize=7)
        for spine in self._ax.spines.values():
            spine.set_edgecolor("#2a3a4e")

        self._line_spread, = self._ax.plot([], [], color=ACCENT, linewidth=1.5,
                                            label="Spread %")
        self._line_target, = self._ax.plot([], [], color=YELLOW, linewidth=1,
                                            linestyle="--", label="Target IA")
        self._ax.legend(fontsize=7, facecolor=BG_CARD, labelcolor=TEXT,
                       framealpha=0.8, loc="upper left")
        self._fig.tight_layout(pad=0.5)

        self._canvas = FigureCanvasTkAgg(self._fig, master=plot_frame)
        self._canvas.get_tk_widget().configure(bg=BG_PLOT, highlightthickness=0)
        self._canvas.get_tk_widget().pack(fill="x", padx=4, pady=4)

        # ── Tabla de oportunidades ────────────────────────────────────────────
        ctk.CTkLabel(
            self,
            text="OPORTUNIDADES DETECTADAS",
            font=ctk.CTkFont("Segoe UI", 10, "bold"),
            text_color=MUTED,
        ).pack(anchor="w", padx=16, pady=(8, 4))

        opp_frame = ctk.CTkFrame(self, fg_color=BG_CARD, corner_radius=10)
        opp_frame.pack(fill="both", expand=True, padx=12, pady=(0, 12))

        style = ttk.Style()
        style.configure(
            "Opp.Treeview",
            background=BG_CARD,
            foreground=TEXT,
            fieldbackground=BG_CARD,
            rowheight=24,
            font=("Segoe UI", 9),
            borderwidth=0,
        )
        style.configure(
            "Opp.Treeview.Heading",
            background="#0a0a15",
            foreground=GREEN,
            font=("Segoe UI", 8, "bold"),
            relief="flat",
        )
        style.map("Opp.Treeview", background=[("selected", "#1e3a2a")])

        self._tree_opp = ttk.Treeview(
            opp_frame,
            columns=("hora", "spread", "precio"),
            show="headings",
            style="Opp.Treeview",
        )
        self._tree_opp.heading("hora",   text="Hora")
        self._tree_opp.heading("spread", text="Spread%")
        self._tree_opp.heading("precio", text="Precio")
        self._tree_opp.column("hora",   width=65, anchor="center")
        self._tree_opp.column("spread", width=70, anchor="center")
        self._tree_opp.column("precio", width=80, anchor="center")
        self._tree_opp.tag_configure("opp", foreground=GREEN)

        self._tree_opp.pack(fill="both", expand=True, padx=4, pady=4)

    # ── API pública ───────────────────────────────────────────────────────────

    def update_chart(self, spread_pct: float, dynamic_target: float) -> None:
        """Añade un punto al gráfico y redibuja."""
        self._spread_history.append(spread_pct)
        self._target_history.append(dynamic_target)

        x = list(range(len(self._spread_history)))
        self._line_spread.set_data(x, list(self._spread_history))
        self._line_target.set_data(x, list(self._target_history))

        if len(x) > 1:
            self._ax.set_xlim(0, max(1, len(x) - 1))
            all_vals = list(self._spread_history) + list(self._target_history)
            margin = 0.5
            self._ax.set_ylim(
                max(0, min(all_vals) - margin),
                max(all_vals) + margin,
            )

        self._canvas.draw_idle()  # Más eficiente que draw()

    def add_opportunity(self, spread_pct: float, price: float) -> None:
        """Añade una fila a la tabla de oportunidades detectadas."""
        hora = datetime.now().strftime("%H:%M:%S")
        self._tree_opp.insert(
            "", 0,
            values=(hora, f"{spread_pct:.2f}%", f"{price:,.2f}"),
            tags=("opp",),
        )
        self._opp_count += 1
        # Limitar a 100 filas
        children = self._tree_opp.get_children()
        if len(children) > 100:
            self._tree_opp.delete(children[-1])
