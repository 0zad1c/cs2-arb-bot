"""
gui/__init__.py
Punto de entrada del paquete GUI.
Expone launch_gui() que recibe el asyncio loop y el stop_event del bot.
"""
from gui.app import P2PBotApp


def launch_gui(bot_loop, stop_event, ui_queue):
    """
    Lanza la ventana principal de la GUI.
    Debe llamarse desde el hilo principal (no desde asyncio).

    Args:
        bot_loop: El asyncio event loop que corre el bot en su hilo.
        stop_event: asyncio.Event para controlar el ciclo del bot.
        ui_queue: asyncio.Queue para recibir UIMessage del bot.
    """
    app = P2PBotApp(bot_loop=bot_loop, stop_event=stop_event, ui_queue=ui_queue)
    app.mainloop()
