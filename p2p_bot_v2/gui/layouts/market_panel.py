"""
gui/layouts/market_panel.py
Panel central: tablas BUY / SELL con color condicional y tarjeta de spread actual.
"""
import customtkinter as ctk
from tkinter import ttk

BG_PANEL  = "#16213e"
BG_CARD   = "#1a1a2e"
BG_TABLE  = "#0f0f1a"
ACCENT    = "#00d4ff"
GREEN     = "#00ff9f"
RED       = "#ff4757"
YELLOW    = "#ffd32a"
TEXT      = "#e0e0e0"
MUTED     = "#6c7a89"

COLUMNS = ("trader", "precio", "min", "max", "métodos", "score")
COL_WIDTHS = (130, 80, 70, 80, 120, 60)


class MarketPanel(ctk.CTkFrame):
    """
    Panel central con dos tablas (BUY y SELL) y una tarjeta de resumen de spread.
    Se actualiza completamente en cada UIMessage recibido.
    """

    def __init__(self, master, **kwargs):
        super().__init__(master, fg_color=BG_PANEL, corner_radius=0, **kwargs)
        self._build_styles()
        self._build()

    # ── Estilos Treeview ──────────────────────────────────────────────────────

    def _build_styles(self):
        style = ttk.Style()
        style.theme_use("clam")

        style.configure(
            "P2P.Treeview",
            background=BG_TABLE,
            foreground=TEXT,
            fieldbackground=BG_TABLE,
            rowheight=26,
            font=("Segoe UI", 10),
            borderwidth=0,
        )
        style.configure(
            "P2P.Treeview.Heading",
            background="#0a0a15",
            foreground=ACCENT,
            font=("Segoe UI", 9, "bold"),
            relief="flat",
        )
        style.map("P2P.Treeview", background=[("selected", "#2a3a4e")])
        style.configure("P2P.Treeview", relief="flat", bd=0)

    # ── Construcción ──────────────────────────────────────────────────────────

    def _build(self):
        # ── Tabla BUY ─────────────────────────────────────────────────────────
        ctk.CTkLabel(
            self,
            text="COMPRA  (BUY)",
            font=ctk.CTkFont("Segoe UI", 11, "bold"),
            text_color=GREEN,
        ).pack(anchor="w", padx=16, pady=(16, 4))

        buy_frame = ctk.CTkFrame(self, fg_color=BG_CARD, corner_radius=10)
        buy_frame.pack(fill="x", padx=12, pady=(0, 8))

        self._tree_buy = self._make_tree(buy_frame)

        # ── Tabla SELL ────────────────────────────────────────────────────────
        ctk.CTkLabel(
            self,
            text="VENTA  (SELL)",
            font=ctk.CTkFont("Segoe UI", 11, "bold"),
            text_color=RED,
        ).pack(anchor="w", padx=16, pady=(8, 4))

        sell_frame = ctk.CTkFrame(self, fg_color=BG_CARD, corner_radius=10)
        sell_frame.pack(fill="x", padx=12, pady=(0, 8))

        self._tree_sell = self._make_tree(sell_frame)

        # ── Tarjeta de Spread ─────────────────────────────────────────────────
        spread_card = ctk.CTkFrame(self, fg_color=BG_CARD, corner_radius=10)
        spread_card.pack(fill="x", padx=12, pady=4)

        row = ctk.CTkFrame(spread_card, fg_color="transparent")
        row.pack(fill="x", padx=16, pady=12)

        # Spread actual
        left = ctk.CTkFrame(row, fg_color="transparent")
        left.pack(side="left", expand=True)

        ctk.CTkLabel(left, text="SPREAD ACTUAL",
                     font=ctk.CTkFont("Segoe UI", 9), text_color=MUTED).pack()

        self._spread_label = ctk.CTkLabel(
            left,
            text="--.--%",
            font=ctk.CTkFont("Segoe UI", 26, "bold"),
            text_color=MUTED,
        )
        self._spread_label.pack()

        # Separador
        ctk.CTkFrame(row, width=2, fg_color="#2a3a4e").pack(
            side="left", fill="y", padx=20)

        # Target IA + nivel
        right = ctk.CTkFrame(row, fg_color="transparent")
        right.pack(side="left", expand=True)

        ctk.CTkLabel(right, text="TARGET IA",
                     font=ctk.CTkFont("Segoe UI", 9), text_color=MUTED).pack()

        self._target_label = ctk.CTkLabel(
            right,
            text="--.--%",
            font=ctk.CTkFont("Segoe UI", 20, "bold"),
            text_color=ACCENT,
        )
        self._target_label.pack()

        self._level_label = ctk.CTkLabel(
            right,
            text="ARRANQUE",
            font=ctk.CTkFont("Segoe UI", 11, "bold"),
            text_color=YELLOW,
        )
        self._level_label.pack()

    def _make_tree(self, parent) -> ttk.Treeview:
        """Construye un Treeview estilizado para BUY o SELL."""
        container = ctk.CTkFrame(parent, fg_color="transparent")
        container.pack(fill="x", padx=4, pady=4)

        tree = ttk.Treeview(
            container,
            columns=COLUMNS,
            show="headings",
            style="P2P.Treeview",
            height=5,
        )

        headers = ["Trader", "Precio", "Min VES", "Max VES", "Metodos", "Score"]
        for col, header, width in zip(COLUMNS, headers, COL_WIDTHS):
            tree.heading(col, text=header)
            tree.column(col, width=width, anchor="center" if col != "trader" else "w")

        # Scrollbar
        scrollbar = ttk.Scrollbar(container, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=scrollbar.set)

        tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        # Tag de color para la mejor oferta
        tree.tag_configure("best_buy", foreground=GREEN)
        tree.tag_configure("best_sell", foreground=RED)

        return tree

    # ── API pública ───────────────────────────────────────────────────────────

    def update_tables(self, buys: list, sells: list) -> None:
        """Reemplaza el contenido de ambas tablas con datos frescos."""
        self._fill_tree(self._tree_buy, buys, tag="best_buy")
        self._fill_tree(self._tree_sell, sells, tag="best_sell")

    def _fill_tree(self, tree: ttk.Treeview, data: list, tag: str) -> None:
        """Limpia y rellena un Treeview con la lista de ads."""
        for row in tree.get_children():
            tree.delete(row)

        for i, ad in enumerate(data[:20]):  # Máximo 20 filas
            values = (
                ad.get("seller", "?")[:18],
                f"{ad.get('price', 0):,.2f}",
                f"{ad.get('min', 0):,.0f}",
                f"{ad.get('max', 0):,.0f}",
                ", ".join(ad.get("methods", []))[:20],
                f"{ad.get('score', 0):.0f}",
            )
            row_tag = (tag,) if i == 0 else ()
            tree.insert("", "end", values=values, tags=row_tag)

    def update_spread_card(
        self,
        spread_pct: float,
        dynamic_target: float,
        market_level: str,
        is_opportunity: bool,
    ) -> None:
        """Actualiza la tarjeta de spread con colores contextuales."""
        spread_color = GREEN if is_opportunity else (YELLOW if spread_pct > 1.0 else RED)
        self._spread_label.configure(
            text=f"{spread_pct:.2f}%",
            text_color=spread_color,
        )
        self._target_label.configure(text=f"{dynamic_target:.2f}%")

        level_colors = {
            "FROZEN": MUTED, "ARRANQUE": YELLOW,
            "NORMAL": ACCENT, "ACTIVO": GREEN, "EXPLOSIVO": RED,
        }
        self._level_label.configure(
            text=market_level,
            text_color=level_colors.get(market_level, ACCENT),
        )
