"""
gui/app.py
P2PBotApp — Ventana principal customtkinter.
Ensambla todos los layouts y orquesta la comunicación async <-> UI.
"""
import asyncio
import threading
from tkinter import messagebox

import customtkinter as ctk

from gui.bridge import AsyncBridge
from gui.state import UIMessage
from gui.layouts.header import HeaderBar
from gui.layouts.control_panel import ControlPanel
from gui.layouts.market_panel import MarketPanel
from gui.layouts.history_panel import HistoryPanel

# Importar la lógica del bot
import bot_p2p_v2 as bot_module

# Configuración global de apariencia
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")

WIN_MIN_W = 1100
WIN_MIN_H = 680


class P2PBotApp(ctk.CTk):
    """
    Ventana raíz de la aplicación. Punto de ensamblaje de todos los paneles.

    Args:
        bot_loop: asyncio event loop corriendo en hilo secundario.
        stop_event: asyncio.Event para controlar el ciclo del bot.
        ui_queue: asyncio.Queue para recibir UIMessage del bot.
    """

    def __init__(
        self,
        bot_loop: asyncio.AbstractEventLoop,
        stop_event: asyncio.Event,
        ui_queue: asyncio.Queue,
    ):
        super().__init__()
        self._bot_loop = bot_loop
        self._stop_event = stop_event
        self._ui_queue = ui_queue
        self._cycle_count = 0
        self._is_running = False

        self._configure_window()
        self._build_layout()
        self._setup_bridge()
        self._setup_close_handler()

        # Cargar oportunidades pasadas de la DB al arrancar
        self._load_db_history()

    # ── Configuración de la ventana ───────────────────────────────────────────

    def _configure_window(self):
        self.title("P2P Bot Pro v2 — Binance Arbitrage")
        self.geometry(f"{WIN_MIN_W}x{WIN_MIN_H}")
        self.minsize(WIN_MIN_W, WIN_MIN_H)
        self.configure(fg_color="#0f0f1a")

    # ── Ensamblaje de layouts ─────────────────────────────────────────────────

    def _build_layout(self):
        # Header (full width, fijo en top)
        self._header = HeaderBar(self)
        self._header.pack(fill="x", side="top")

        # Separador visual
        ctk.CTkFrame(self, height=1, fg_color="#1a2a3e").pack(fill="x")

        # Contenedor principal (3 columnas)
        main = ctk.CTkFrame(self, fg_color="transparent")
        main.pack(fill="both", expand=True)

        # Panel izquierdo
        self._control = ControlPanel(
            main,
            on_start=self._handle_start,
            on_stop=self._handle_stop,
        )
        self._control.pack(side="left", fill="y")

        # Separador
        ctk.CTkFrame(main, width=1, fg_color="#1a2a3e").pack(side="left", fill="y")

        # Panel central (flexible)
        self._market = MarketPanel(main)
        self._market.pack(side="left", fill="both", expand=True)

        # Separador
        ctk.CTkFrame(main, width=1, fg_color="#1a2a3e").pack(side="left", fill="y")

        # Panel derecho
        self._history = HistoryPanel(main)
        self._history.pack(side="left", fill="y")

        # Status bar inferior
        self._status_bar = ctk.CTkLabel(
            self,
            text="Listo. Configure los parametros y presione INICIAR.",
            font=ctk.CTkFont("Segoe UI", 9),
            text_color="#6c7a89",
            fg_color="#0a0a15",
            anchor="w",
        )
        self._status_bar.pack(fill="x", side="bottom", padx=16, pady=4)

    # ── AsyncBridge ───────────────────────────────────────────────────────────

    def _setup_bridge(self):
        self._bridge = AsyncBridge(
            bot_loop=self._bot_loop,
            ui_queue=self._ui_queue,
            on_message=self._handle_ui_message,
        )
        self._bridge.start_polling(self)

    # ── Handlers de botones ───────────────────────────────────────────────────

    def _handle_start(self, amount: float, bank: str, methods: list, delay: int):
        """Callback del botón INICIAR. Configura el bot y lanza el loop async."""
        # Actualizar session_state del bot (thread-safe — solo escritura simple)
        bot_module.session_state.user_amount_ves = amount
        bot_module.session_state.selected_bank = bank
        bot_module.session_state.payment_methods_filter = methods

        # También actualizar el delay en config
        object.__setattr__(bot_module.config, "delay_seconds", float(delay))

        # Limpiar el stop_event para que el bot arranque
        self._bridge.call_bot_threadsafe(self._stop_event.clear)

        # Lanzar la corrutina main() del bot en el loop secundario
        self._bridge.run_bot_coroutine(bot_module.main(self._stop_event))

        # Actualizar UI
        self._is_running = True
        self._header.set_running(True)
        self._set_status("Bot iniciado. Esperando primer ciclo...")
        self._control.append_log("[SISTEMA] Bot iniciado correctamente.")

    def _handle_stop(self):
        """Callback del botón DETENER. Señaliza el stop_event."""
        self._bridge.call_bot_threadsafe(self._stop_event.set)
        self._is_running = False
        self._header.set_running(False)
        self._set_status("Bot detenido por el usuario.")
        self._control.append_log("[SISTEMA] Detención solicitada.")
        self._control.reset_buttons()

    # ── Procesamiento de mensajes del bot ─────────────────────────────────────

    def _handle_ui_message(self, msg: UIMessage) -> None:
        """
        Recibe un UIMessage del bridge y actualiza todos los widgets.
        Se ejecuta en el hilo principal (safe para CTk).
        """
        self._cycle_count += 1

        # Manejo de errores del bot
        if msg.error:
            self._set_status(f"[ERROR] {msg.error}", error=True)
            self._control.append_log(f"[ERROR] {msg.error}")
            return

        # Header
        self._header.set_cycle(self._cycle_count)
        self._header.set_market_level(msg.market_level)
        self._header.update_timestamp()

        # Tablas de mercado
        self._market.update_tables(msg.buys, msg.sells)
        self._market.update_spread_card(
            msg.spread_pct,
            msg.dynamic_target,
            msg.market_level,
            msg.is_opportunity,
        )

        # Gráfico histórico
        self._history.update_chart(msg.spread_pct, msg.dynamic_target)

        # Log y oportunidades
        if msg.log_line:
            self._control.append_log(msg.log_line)

        if msg.is_opportunity:
            self._history.add_opportunity(msg.spread_pct, msg.best_buy_price)
            self._set_status(
                f"OPORTUNIDAD: Spread {msg.spread_pct:.2f}% > Target {msg.dynamic_target:.2f}% | "
                f"Compra: {msg.best_buy_price:,.2f}"
            )
        else:
            self._set_status(
                f"Ciclo {self._cycle_count} | Spread: {msg.spread_pct:.2f}% | "
                f"Target IA: {msg.dynamic_target:.2f}% | Mercado: {msg.market_level}"
            )

    # ── Status bar ────────────────────────────────────────────────────────────

    def _set_status(self, text: str, error: bool = False) -> None:
        color = "#ff4757" if error else "#6c7a89"
        self._status_bar.configure(text=text, text_color=color)

    # ── DB History Loader ─────────────────────────────────────────────────────

    def _load_db_history(self) -> None:
        """Carga oportunidades pasadas de la DB al panel de historial."""
        try:
            from database import P2PDatabase
            db = P2PDatabase()
            records = db.get_last_records(50)
            for rec in records:
                # rec: (timestamp, asset, fiat, price, spread)
                self._history.add_opportunity(rec[4], rec[3])
                self._history.update_chart(rec[4], 0.0)
            if records:
                self._control.append_log(
                    f"[DB] {len(records)} oportunidades historicas cargadas."
                )
        except Exception as e:
            self._control.append_log(f"[DB] No se pudo cargar historial: {e}")

    # ── Cierre seguro ─────────────────────────────────────────────────────────

    def _setup_close_handler(self):
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _on_close(self) -> None:
        """Prevención de errores: confirmar cierre si el bot está activo."""
        if self._is_running:
            if not messagebox.askyesno(
                "Confirmar cierre",
                "El bot esta activo. Deseas detenerlo y salir?",
            ):
                return
            # Detener el bot antes de salir
            self._bridge.call_bot_threadsafe(self._stop_event.set)

        self._bridge.stop_polling()
        self._control.save_prefs()

        # Limpiar matplotlib para evitar warnings
        try:
            import matplotlib.pyplot as plt
            plt.close("all")
        except Exception:
            pass

        self.destroy()
