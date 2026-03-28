"""
gui/state.py
Dataclass UIMessage — canal de datos del bot hacia la UI.
El bot produce estas instancias; la UI las consume.
"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class UIMessage:
    """
    Snapshot del estado del bot en un ciclo de análisis.
    Se transmite por asyncio.Queue desde el loop async hacia el hilo de la UI.
    """
    buys: list = field(default_factory=list)       # Ads de compra parseados (dicts)
    sells: list = field(default_factory=list)      # Ads de venta parseados (dicts)
    spread_pct: float = 0.0                        # Spread calculado en este ciclo
    dynamic_target: float = 0.0                    # Target dinámico de la IA
    market_level: str = "ARRANQUE"                 # Nivel de mercado
    best_buy_price: float = 0.0                    # Mejor precio de compra
    best_sell_price: float = 0.0                   # Mejor precio de venta
    log_line: str = ""                             # Última línea de log para stream
    cycle_count: int = 0                           # Número de ciclo actual
    is_opportunity: bool = False                   # True si supera el target
    error: Optional[str] = None                    # Mensaje de error, si hay
