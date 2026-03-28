"""
config.py — Sistema de configuración seguro para el Bot P2P Binance.

Síntesis: Arquitecto (Antigravity) + Programador Local (LM Studio)
- LM Studio generó la estructura base de dataclass + dotenv
- Revisión del Arquitecto: corregido el tipo de PAGES (int simple, no lista),
  eliminada la dependencia de campo mutable en dataclass frozen,
  añadida validación __post_init__ en lugar de función externa,
  y mejorado el manejo de errores de carga de .env.
"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# Cargar .env desde el directorio del proyecto
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    load_dotenv(dotenv_path=_env_path)
else:
    load_dotenv()  # Fallback: buscar en el directorio actual


@dataclass(frozen=True)
class Config:
    """
    Configuración inmutable y validada del bot.
    Todos los valores se leen desde variables de entorno o un archivo .env.
    """

    # ── Telegram ─────────────────────────────────────────────────────────────
    telegram_bot_token: str = field(
        default_factory=lambda: os.environ.get("TELEGRAM_BOT_TOKEN", "TU_TELEGRAM_BOT_TOKEN")
    )
    telegram_chat_id: str = field(
        default_factory=lambda: os.environ.get("TELEGRAM_CHAT_ID", "")
    )

    # ── Mercado ───────────────────────────────────────────────────────────────
    asset: str = field(default_factory=lambda: os.environ.get("ASSET", "USDT"))
    fiat: str = field(default_factory=lambda: os.environ.get("FIAT", "VES"))
    rows: int = field(default_factory=lambda: int(os.environ.get("ROWS", "20")))
    pages: int = field(default_factory=lambda: int(os.environ.get("PAGES", "3")))
    delay_seconds: float = field(
        default_factory=lambda: float(os.environ.get("DELAY_SECONDS", "5"))
    )

    # ── Filtros de traders ────────────────────────────────────────────────────
    min_rating: float = field(
        default_factory=lambda: float(os.environ.get("MIN_RATING", "0.90"))
    )
    min_orders: int = field(
        default_factory=lambda: int(os.environ.get("MIN_ORDERS", "50"))
    )

    # ── Estrategia ────────────────────────────────────────────────────────────
    spread_target_percent: float = field(
        default_factory=lambda: float(os.environ.get("SPREAD_TARGET_PERCENT", "2.0"))
    )
    pago_movil_commission: float = field(
        default_factory=lambda: float(os.environ.get("PAGO_MOVIL_COMMISSION", "0.003"))
    )

    def __post_init__(self) -> None:
        """Valida todos los campos al momento de creación. Lanza ValueError si algo falla."""
        self._validate_telegram()
        self._validate_market()
        self._validate_filters()
        self._validate_strategy()

    # ── Validadores privados ──────────────────────────────────────────────────

    def _validate_telegram(self) -> None:
        token = self.telegram_bot_token
        if token == "TU_TELEGRAM_BOT_TOKEN":
            # Modo simulación es válido, no lanzar error
            return
        # Formato real del token de Telegram: <digits>:<alphanumeric>
        pattern = r"^\d{8,12}:[A-Za-z0-9_-]{35,}$"
        if not re.match(pattern, token):
            raise ValueError(
                f"TELEGRAM_BOT_TOKEN tiene formato inválido. "
                f"Se esperaba '<id>:<hash>', pero se recibió: '{token[:15]}...'"
            )
        if not self.telegram_chat_id:
            raise ValueError(
                "TELEGRAM_CHAT_ID está vacío, pero el token de Telegram es real. "
                "Define TELEGRAM_CHAT_ID en tu archivo .env"
            )

    def _validate_market(self) -> None:
        if not self.asset:
            raise ValueError("ASSET no puede estar vacío (ej: USDT, BTC)")
        if not self.fiat:
            raise ValueError("FIAT no puede estar vacío (ej: VES, USD)")
        if self.rows <= 0 or self.rows > 100:
            raise ValueError(f"ROWS debe estar entre 1 y 100, recibido: {self.rows}")
        if self.pages <= 0 or self.pages > 10:
            raise ValueError(f"PAGES debe estar entre 1 y 10, recibido: {self.pages}")
        if self.delay_seconds < 1:
            raise ValueError(
                f"DELAY_SECONDS debe ser >= 1 para evitar rate limiting, recibido: {self.delay_seconds}"
            )

    def _validate_filters(self) -> None:
        if not (0.0 < self.min_rating <= 1.0):
            raise ValueError(
                f"MIN_RATING debe estar entre 0.0 (exclusivo) y 1.0, recibido: {self.min_rating}"
            )
        if self.min_orders < 0:
            raise ValueError(
                f"MIN_ORDERS debe ser mayor o igual a 0, recibido: {self.min_orders}"
            )

    def _validate_strategy(self) -> None:
        if self.spread_target_percent <= 0 or self.spread_target_percent > 100:
            raise ValueError(
                f"SPREAD_TARGET_PERCENT debe estar entre 0 y 100, recibido: {self.spread_target_percent}"
            )
        if not (0.0 <= self.pago_movil_commission < 0.1):
            raise ValueError(
                f"PAGO_MOVIL_COMMISSION debe estar entre 0 y 0.10 (10%), "
                f"recibido: {self.pago_movil_commission}"
            )

    # ── Métodos de utilidad ───────────────────────────────────────────────────

    def is_simulation_mode(self) -> bool:
        """Retorna True si el bot corre en modo simulación (sin token real)."""
        return self.telegram_bot_token == "TU_TELEGRAM_BOT_TOKEN"

    def __repr__(self) -> str:
        """Representación segura: oculta el token."""
        token_repr = "***SIMULATION***" if self.is_simulation_mode() else f"***{self.telegram_bot_token[-8:]}"
        return (
            f"Config(asset={self.asset}, fiat={self.fiat}, rows={self.rows}, "
            f"pages={self.pages}, delay={self.delay_seconds}s, "
            f"min_rating={self.min_rating}, min_orders={self.min_orders}, "
            f"spread_target={self.spread_target_percent}%, token={token_repr})"
        )


# Instancia global del config — falla rápido si hay errores de configuración
try:
    config = Config()
except ValueError as e:
    raise SystemExit(f"[CONFIG ERROR] {e}") from e
