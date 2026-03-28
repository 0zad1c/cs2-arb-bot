"""
gui/bridge.py
AsyncBridge — puente entre el loop asyncio del bot y el hilo principal de la UI.

Patrón:
  Bot (async thread)  -->  asyncio.Queue  -->  after(150, _poll)  -->  CTk widgets
  CTk callbacks       -->  run_coroutine_threadsafe(coro, bot_loop)
"""
import asyncio
from typing import Callable, Optional
from gui.state import UIMessage


class AsyncBridge:
    """
    Gestiona la comunicación bidireccional entre asyncio y tkinter/CTk.

    Usage en app.py:
        bridge = AsyncBridge(bot_loop, ui_queue, on_message_callback)
        bridge.start_polling(root_widget)  # Inicia el ciclo after()
        bridge.stop_polling()              # Detiene el ciclo
    """

    POLL_INTERVAL_MS = 150  # Frecuencia de polling de la queue

    def __init__(
        self,
        bot_loop: asyncio.AbstractEventLoop,
        ui_queue: asyncio.Queue,
        on_message: Callable[[UIMessage], None],
    ):
        self._loop = bot_loop
        self._queue = ui_queue
        self._on_message = on_message
        self._polling = False
        self._root = None  # Se setea en start_polling()

    # ── Polling: UI <-- Bot ───────────────────────────────────────────────────

    def start_polling(self, root_widget) -> None:
        """Inicia el ciclo de polling. Llamar tras root.mainloop() setup."""
        self._root = root_widget
        self._polling = True
        self._poll()

    def stop_polling(self) -> None:
        """Detiene el ciclo de polling."""
        self._polling = False

    def _poll(self) -> None:
        """Drena todos los mensajes pendientes en la queue (no-blocking)."""
        if not self._polling or self._root is None:
            return

        try:
            # Procesar hasta 5 mensajes por tick para no acumular lag
            for _ in range(5):
                msg: UIMessage = self._queue.get_nowait()
                self._on_message(msg)
        except asyncio.QueueEmpty:
            pass
        except Exception:
            pass  # No crashear la UI por errores de mensaje

        # Reschedular usando after() — seguro en hilo principal
        self._root.after(self.POLL_INTERVAL_MS, self._poll)

    # ── Envío de comandos: UI --> Bot ─────────────────────────────────────────

    def run_bot_coroutine(self, coro) -> None:
        """
        Dispara una corrutina en el loop del bot desde un callback de la UI.
        Thread-safe. No bloquea el hilo principal.

        Example:
            bridge.run_bot_coroutine(async_start_bot())
        """
        asyncio.run_coroutine_threadsafe(coro, self._loop)

    def call_bot_threadsafe(self, func: Callable, *args) -> None:
        """
        Llama a una función síncrona en el loop del bot de forma thread-safe.
        Útil para activar eventos (ej: stop_event.set()).

        Example:
            bridge.call_bot_threadsafe(stop_event.set)
        """
        self._loop.call_soon_threadsafe(func, *args)
