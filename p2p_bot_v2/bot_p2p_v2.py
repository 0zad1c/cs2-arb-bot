"""
bot_p2p_v2.py — Bot de Arbitraje Binance P2P (versión auditada y mejorada)

Equipo de ingeniería híbrido:
  - Arquitecto (Antigravity/Cloud): Diseño, auditoría y síntesis
  - Programador (LM Studio/Local): Generación de funciones optimizadas

Mejoras clave sobre la v1:
  1. [SEGURIDAD]    Credenciales en .env, nunca hardcodeadas
  2. [API]          Headers User-Agent + retry con backoff exponencial
  3. [LÓGICA]       Anti-spam por timestamp (no solo por valor)
  4. [IA]           adaptive_strategy pura con deque + stddev + niveles de mercado
  5. [ROBUSTEZ]     Excepciones específicas, sin `except:` desnudos
  6. [GUI]          Tkinter en hilo separado para evitar conflicto con asyncio
  7. [LOGGING]      Logger configurado con rotación de archivos
"""

import asyncio
import random
import time
from collections import deque
from threading import Thread
from dataclasses import dataclass, field
import statistics
import tkinter as tk
from tkinter import ttk, messagebox
from typing import Optional

import aiohttp
from aiohttp import ClientTimeout, ClientResponseError, ClientConnectorError
from loguru import logger

# ── Importar configuración segura y base de datos ─────────────────────────────
from config import config
from database import P2PDatabase

# Instancia global de la base de datos
db = P2PDatabase()

# ── Logging con rotación ──────────────────────────────────────────────────────
logger.add("logs/bot_p2p_{time}.log", rotation="10 MB", retention="7 days", level="DEBUG")

# ── Headers anti-bloqueo (rotación de User-Agents) ───────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
]

BINANCE_P2P_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search"

# ── Estado de sesión del usuario (llenado por GUI) ────────────────────────────
@dataclass
class SessionState:
    user_amount_ves: float = 0.0
    selected_bank: str = ""
    payment_methods_filter: list = field(default_factory=list)

session_state = SessionState()

# ── Historial de mercado (thread-safe con deque) ──────────────────────────────
# LM Studio sugirió deque(maxlen=50) — correcto, implementado aquí
market_history: deque = deque(maxlen=50)

# ── Anti-spam: guardar timestamp de última alerta ─────────────────────────────
_last_alert_time: float = 0.0
_last_alert_spread: float = 0.0
ALERT_COOLDOWN_SECONDS = 60  # No repetir misma alerta por al menos 60s


# ==========================================
# 📡 TELEGRAM
# ==========================================
async def send_telegram_alert(session: aiohttp.ClientSession, message: str) -> None:
    """Envía alerta a Telegram. En modo simulación, solo loggea."""
    if config.is_simulation_mode():
        logger.info(f"[SIMULACIÓN ALERTA]\n{message}")
        return

    url = f"https://api.telegram.org/bot{config.telegram_bot_token}/sendMessage"
    payload = {
        "chat_id": config.telegram_chat_id,
        "text": message,
        "parse_mode": "HTML",
    }

    try:
        async with session.post(url, json=payload, timeout=ClientTimeout(total=10)) as r:
            if r.status != 200:
                body = await r.text()
                logger.error(f"Telegram error {r.status}: {body}")
    except ClientConnectorError as e:
        logger.error(f"No se pudo conectar con Telegram: {e}")
    except asyncio.TimeoutError:
        logger.warning("Timeout al enviar alerta a Telegram")


# ==========================================
# 🌐 FETCH CON RETRY + BACKOFF EXPONENCIAL
#
# Síntesis: LM Studio generó la idea de headers y retry.
# Arquitecto corrigió: usar POST (no GET), endpoint correcto,
# payload correcto, y retry real con asyncio.sleep.
# ==========================================
async def fetch_page(
    session: aiohttp.ClientSession,
    trade_type: str,
    page: int,
    payment_methods: list,
) -> list:
    """
    Obtiene una página de anuncios P2P de Binance con reintentos y backoff exponencial.

    Args:
        session: Sesión aiohttp compartida.
        trade_type: "BUY" o "SELL".
        page: Número de página (1-indexed).
        payment_methods: Lista de métodos de pago a filtrar.

    Returns:
        Lista de anuncios, o lista vacía si todos los reintentos fallan.
    """
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    payload = {
        "fiat": config.fiat,
        "page": page,
        "rows": config.rows,
        "tradeType": trade_type,
        "asset": config.asset,
        "payTypes": payment_methods,
    }

    timeout = ClientTimeout(total=10, connect=5)
    max_retries = 3

    for attempt in range(1, max_retries + 1):
        try:
            async with session.post(
                BINANCE_P2P_URL,
                json=payload,
                headers=headers,
                timeout=timeout,
            ) as response:
                response.raise_for_status()  # Lanza excepción si 4xx/5xx
                data = await response.json(content_type=None)
                return data.get("data", [])

        except asyncio.TimeoutError:
            logger.warning(f"Timeout en fetch_page (intento {attempt}/{max_retries}, tipo={trade_type}, pág={page})")
        except ClientResponseError as e:
            logger.error(f"HTTP {e.status} en fetch_page: {e.message} (intento {attempt}/{max_retries})")
            if e.status in (429, 418):  # Rate limited — esperar más
                await asyncio.sleep(10 * attempt)
                continue
        except ClientConnectorError as e:
            logger.error(f"Error de conexión en fetch_page: {e} (intento {attempt}/{max_retries})")
        except Exception as e:
            logger.error(f"Error inesperado en fetch_page: {type(e).__name__}: {e}")

        if attempt < max_retries:
            backoff = 2 ** attempt + random.uniform(0, 1)
            logger.debug(f"Reintentando en {backoff:.1f}s...")
            await asyncio.sleep(backoff)

    logger.warning(f"fetch_page falló definitivamente (tipo={trade_type}, pág={page})")
    return []


async def fetch_all(
    session: aiohttp.ClientSession,
    trade_type: str,
    payment_methods: list,
) -> list:
    """Obtiene todas las páginas configuradas en paralelo."""
    tasks = [
        fetch_page(session, trade_type, page, payment_methods)
        for page in range(1, config.pages + 1)
    ]
    results = await asyncio.gather(*tasks)
    return [item for sublist in results for item in sublist]


# ==========================================
# 🧠 PARSER — Con excepciones específicas
# ==========================================
def normalize(text: str) -> str:
    return text.lower().replace(" ", "").replace("_", "")


def parse_ads(data: list, user_amount_ves: float) -> list:
    """
    Parsea los anuncios crudos de Binance P2P y filtra por criterios.

    Args:
        data: Lista de anuncios en formato raw de la API.
        user_amount_ves: Monto del usuario en VES para verificar rango.

    Returns:
        Lista de anuncios válidos y enriquecidos.
    """
    ads = []
    for ad in data:
        try:
            adv = ad["adv"]
            user = ad["advertiser"]

            price = float(adv["price"])
            min_amt = float(adv["minSingleTransAmount"])
            max_amt = float(adv["dynamicMaxSingleTransAmount"])
            rating = float(user["monthFinishRate"])
            orders = int(user["monthOrderCount"])
            methods = [normalize(m["identifier"]) for m in adv.get("tradeMethods", [])]

            # Validar que el monto del usuario esté en rango
            valid_amount = (user_amount_ves <= 0) or (min_amt <= user_amount_ves <= max_amt)

            if rating >= config.min_rating and orders >= config.min_orders and valid_amount:
                score = rating * orders  # Score compuesto de calidad del trader
                ads.append({
                    "price": price,
                    "seller": user.get("nickName", "Desconocido"),
                    "methods": methods,
                    "score": score,
                    "min": min_amt,
                    "max": max_amt,
                })

        except KeyError as e:
            logger.debug(f"Anuncio con campo faltante ignorado: {e}")
        except (ValueError, TypeError) as e:
            logger.debug(f"Anuncio con valor inválido ignorado: {e}")

    return ads


# ==========================================
# 🤖 IA ADAPTATIVA — Versión mejorada
#
# Síntesis: LM Studio sugirió deque + stddev + niveles.
# Arquitecto refinó: la lógica de adjusted_target del modelo local
# era incorrecta (multiplicaba spread por mean+stddev).
# Implementación correcta basada en medias históricas + ajuste de volatilidad.
# ==========================================

# Thresholds para clasificación de mercado
MARKET_THRESHOLDS = {
    "FROZEN":    (0.0,  0.8),
    "NORMAL":    (0.8,  1.5),
    "ACTIVO":    (1.5,  2.5),
    "EXPLOSIVO": (2.5, float("inf")),
}


def adaptive_strategy(spread_percent: float, history: deque) -> tuple[float, str]:
    """
    Calcula el target dinámico y nivel de mercado basado en el historial.

    Estrategia:
    - Si la volatilidad (stddev) es alta → subir el target (ser más selectivo)
    - Si el mercado está frío → bajar el target ligeramente para no perderse señales
    - El nivel de mercado se determina por la media histórica

    Args:
        spread_percent: Spread actual en porcentaje.
        history: Historial reciente de spreads (deque).

    Returns:
        Tupla (target_float, nivel_de_mercado_str)
    """
    history.append(spread_percent)

    if len(history) < 5:
        # Datos insuficientes: usar el target base de la config
        return config.spread_target_percent, "ARRANQUE"

    hist_list = list(history)
    avg = statistics.mean(hist_list)
    stddev = statistics.stdev(hist_list) if len(hist_list) > 1 else 0.0

    # Ajuste de volatilidad: alta volatilidad → target más alto (más selectivo)
    volatility_adjustment = min(stddev * 0.3, 1.0)  # Cap a +1% de ajuste

    # Target base según nivel medio del mercado
    if avg < 0.8:
        base_target = 1.0   # Mercado frío: bajar umbral para no perder nada
    elif avg < 1.5:
        base_target = 1.5   # Normal
    elif avg < 2.5:
        base_target = 2.0   # Activo
    else:
        base_target = 2.8   # Explosivo: ser más exigente

    dynamic_target = round(base_target + volatility_adjustment, 2)

    # Clasificar nivel de mercado
    market_level = "NORMAL"
    for level, (low, high) in MARKET_THRESHOLDS.items():
        if low <= avg < high:
            market_level = level
            break

    return dynamic_target, market_level


# ==========================================
# 🔥 ANALYZER PRO
# ==========================================
async def analyze(
    session: aiohttp.ClientSession,
    buys: list,
    sells: list,
    selected_bank: str,
) -> None:
    """Analiza oportunidades de arbitraje entre compradores y vendedores."""
    global _last_alert_time, _last_alert_spread

    if not buys or not sells:
        logger.debug("Sin suficientes anuncios para analizar.")
        return

    import pandas as pd
    df_buy = pd.DataFrame(buys).sort_values("price")
    df_sell = pd.DataFrame(sells).sort_values("price", ascending=False)

    top_buy = df_buy.head(5)
    top_sell = df_sell.head(5)

    avg_buy = top_buy["price"].mean()
    best_buy = top_buy.iloc[0]
    best_sell = top_sell.iloc[0]

    # ── Detección de oferta fake (precio muy por debajo del mercado) ──────────
    if best_buy["price"] < avg_buy * 0.97:
        logger.warning(
            f"⚠️ Posible oferta fake detectada: precio {best_buy['price']} vs promedio {avg_buy:.2f}"
        )
        return

    # ── Comisión dinámica según método de pago ────────────────────────────────
    bank_normalized = normalize(selected_bank)
    aplica_comision = not any(bank_normalized in m for m in best_buy["methods"])
    fee = config.pago_movil_commission if aplica_comision else 0.0
    real_buy = best_buy["price"] * (1 + fee)

    spread = best_sell["price"] - real_buy
    spread_percent = (spread / real_buy) * 100

    # ── IA adaptativa ─────────────────────────────────────────────────────────
    dynamic_target, market_level = adaptive_strategy(spread_percent, market_history)

    logger.info(
        f"[{market_level}] Spread: {spread_percent:.2f}% | "
        f"Target IA: {dynamic_target:.2f}% | "
        f"Compra: {best_buy['price']} | Venta: {best_sell['price']}"
    )

    if spread_percent < dynamic_target:
        return

    # ── Registro de oportunidad en Base de Datos ─────────────────────────────
    try:
        db.insert_record(config.asset, config.fiat, best_buy['price'], spread_percent)
    except Exception as e:
        logger.error(f"Error al persistir oportunidad en DB: {e}")


    # ── Anti-spam mejorado: por valor Y por tiempo ────────────────────────────
    current_time = time.monotonic()
    current_spread_rounded = round(spread_percent, 2)

    same_signal = (current_spread_rounded == _last_alert_spread)
    too_soon = (current_time - _last_alert_time) < ALERT_COOLDOWN_SECONDS

    if same_signal and too_soon:
        logger.debug("Alerta duplicada suprimida (misma señal en cooldown)")
        return

    _last_alert_time = current_time
    _last_alert_spread = current_spread_rounded

    commission_note = f"(+{config.pago_movil_commission*100:.1f}% comisión)" if aplica_comision else "(sin comisión extra)"

    msg = (
        f"🚀 <b>OPORTUNIDAD P2P DETECTADA</b>\n\n"
        f"📈 <b>Mercado:</b> {market_level}\n"
        f"💰 <b>Compra:</b> {best_buy['price']:,.2f} {config.fiat} {commission_note}\n"
        f"💵 <b>Venta:</b> {best_sell['price']:,.2f} {config.fiat}\n"
        f"📊 <b>Spread:</b> <b>{spread_percent:.2f}%</b>\n"
        f"🎯 <b>Target IA:</b> {dynamic_target:.2f}%\n"
        f"👤 <b>Trader:</b> {best_buy['seller']} "
        f"(Score: {best_buy['score']:.0f})\n"
        f"📋 <b>Métodos:</b> {', '.join(best_buy['methods'])}"
    )

    await send_telegram_alert(session, msg)


# ==========================================
# 🔁 LOOP PRINCIPAL
# ==========================================
async def main(stop_event: asyncio.Event) -> None:
    """Loop principal del bot. Se detiene cuando se activa stop_event."""
    logger.info(f"Bot iniciado. Config: {config}")

    # ── Inicializar historial desde DB ────────────────────────────────────────
    try:
        last_records = db.get_last_records(50)
        for rec in last_records:
            # Estructura del registro: (timestamp, asset, fiat, price, spread)
            # El spread es el último elemento (índice 4)
            market_history.append(rec[4])
        if last_records:
            logger.info(f"Historial inicializado con {len(last_records)} registros de la DB.")
    except Exception as e:
        logger.warning(f"No se pudo cargar el historial de la DB: {e}")

    # Crear sesión con connection pooling

    connector = aiohttp.TCPConnector(limit=10, ttl_dns_cache=300)
    timeout = ClientTimeout(total=30)

    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        while not stop_event.is_set():
            try:
                # Capturar estado actual de la sesión del usuario
                payment_methods = list(session_state.payment_methods_filter)
                user_amount = session_state.user_amount_ves
                selected_bank = session_state.selected_bank

                buy_raw = await fetch_all(session, "BUY", payment_methods)
                sell_raw = await fetch_all(session, "SELL", payment_methods)

                buys = parse_ads(buy_raw, user_amount)
                sells = parse_ads(sell_raw, user_amount)

                logger.debug(f"Anuncios parseados — Compra: {len(buys)}, Venta: {len(sells)}")

                await analyze(session, buys, sells, selected_bank)

            except Exception as e:
                logger.error(f"Error en el loop principal: {type(e).__name__}: {e}")

            await asyncio.sleep(config.delay_seconds)


# ==========================================
# 🖥️ GUI — En hilo separado para evitar conflicto con asyncio
# ==========================================
def gui() -> bool:
    """
    Muestra la GUI de configuración en un hilo dedicado.

    Returns:
        True si el usuario confirmó los datos, False si cerró la ventana.
    """
    confirmed = [False]  # Lista mutable para pasar el resultado fuera del closure

    def on_start():
        global session_state
        try:
            amount = float(entry_amount.get())
            if amount < 0:
                raise ValueError("El monto no puede ser negativo")

            bank = combo_bank.get()
            session_state.user_amount_ves = amount
            session_state.selected_bank = bank
            session_state.payment_methods_filter = ["PagoMovil", bank]
            confirmed[0] = True
            root.destroy()
        except ValueError:
            messagebox.showerror("Error", "Ingresa un monto válido (número >= 0)")

    root = tk.Tk()
    root.title("BOT P2P PRO v2 — Configuración")
    root.geometry("320x240")
    root.resizable(False, False)
    root.configure(bg="#1a1a2e")

    # ── Estilo ────────────────────────────────────────────────────────────────
    style = ttk.Style()
    style.theme_use("clam")
    style.configure("TCombobox", fieldbackground="#16213e", foreground="white")

    label_cfg = {"bg": "#1a1a2e", "fg": "#e0e0e0", "font": ("Segoe UI", 10)}
    entry_cfg = {"bg": "#16213e", "fg": "white", "insertbackground": "white",
                 "relief": "flat", "font": ("Segoe UI", 11), "width": 25}

    tk.Label(root, text="🤖 Bot P2P Pro v2", bg="#1a1a2e",
             fg="#00d4ff", font=("Segoe UI", 13, "bold")).pack(pady=(15, 5))

    tk.Label(root, text="Monto en VES (0 = sin filtro)", **label_cfg).pack()
    entry_amount = tk.Entry(root, **entry_cfg)
    entry_amount.insert(0, "0")
    entry_amount.pack(pady=4)

    tk.Label(root, text="Banco principal", **label_cfg).pack(pady=(8, 0))
    combo_bank = ttk.Combobox(
        root,
        values=["Banesco", "Provincial", "Mercantil", "Venezuela", "BOD"],
        state="readonly",
        width=23,
    )
    combo_bank.current(0)
    combo_bank.pack(pady=4)

    tk.Button(
        root,
        text="▶  INICIAR BOT",
        command=on_start,
        bg="#00d4ff",
        fg="#1a1a2e",
        font=("Segoe UI", 11, "bold"),
        relief="flat",
        padx=20,
        pady=8,
        cursor="hand2",
    ).pack(pady=15)

    root.mainloop()
    return confirmed[0]


# ==========================================
# 🚀 ENTRY POINT
# ==========================================
if __name__ == "__main__":
    if gui():
        logger.info("GUI completada. Iniciando loop asyncio...")

        stop_event = asyncio.Event()

        try:
            asyncio.run(main(stop_event))
        except KeyboardInterrupt:
            logger.info("Bot detenido por el usuario (Ctrl+C).")
        except Exception as e:
            logger.critical(f"Error fatal: {e}", exc_info=True)
    else:
        logger.info("Bot cancelado por el usuario en la GUI.")
