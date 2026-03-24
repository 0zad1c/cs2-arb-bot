// ─────────────────────────────────────────────────────────────────────────────
// clients/csfloat.js — Cliente para la API de CSFloat
//
// Funcionalidades:
//   - WebSocket para listings en tiempo real (latencia mínima)
//   - REST API para búsqueda de listings y ejecución de compras
//   - Rate limiting automático
//   - Reconexión automática del WebSocket con backoff exponencial
// ─────────────────────────────────────────────────────────────────────────────
import WebSocket from 'ws';
import axios     from 'axios';
import { CSFLOAT, BOT, SKINS } from '../config.js';
import { withRetry, isRetryableHttpError, getRetryAfterMs, sleep } from '../utils/retry.js';
import { log, logEvento } from '../services/logger.js';

// ── HTTP Client ────────────────────────────────────────────────────────────
const http = axios.create({
  baseURL: CSFLOAT.baseUrl,
  timeout: 15_000,
  headers: {
    'Authorization': CSFLOAT.apiKey,
    'Content-Type':  'application/json',
    'User-Agent':    'CS2ArbBot/2.0',
  },
});

// Interceptor de rate limiting
let ultimaLlamada = 0;
http.interceptors.request.use(async (config) => {
  const ahora   = Date.now();
  const esperar = CSFLOAT.rateLimitMs - (ahora - ultimaLlamada);
  if (esperar > 0) await sleep(esperar);
  ultimaLlamada = Date.now();
  return config;
});

// ── REST API ───────────────────────────────────────────────────────────────

/**
 * Busca listings en CSFloat para una skin.
 * @param {object} params
 * @param {string} params.marketHashName  — Nombre exacto del skin en Steam
 * @param {number} params.minFloat
 * @param {number} params.maxFloat
 * @param {number} params.maxPrice        — Precio máximo en USD
 * @param {number} params.limit           — Número de resultados (default: 20)
 * @returns {Promise<Array>}              — Array de listings
 */
export async function buscarListings(params) {
  const { marketHashName, minFloat, maxFloat, maxPrice, limit = 20 } = params;

  return withRetry(async () => {
    const resp = await http.get('/listings', {
      params: {
        market_hash_name: marketHashName,
        min_float:        minFloat,
        max_float:        maxFloat,
        max_price:        Math.floor(maxPrice * 100),  // CSFloat usa centavos
        sort_by:          'lowest_price',
        limit,
        type:             'buy_now',
      },
    });
    return resp.data?.data ?? [];
  }, {
    retries:  4,
    base:     2000,
    retryIf:  isRetryableHttpError,
    onRetry:  (n, err, delay) => log.warn(`CSFloat listings: reintento ${n}`, { err: err.message, delay }),
  });
}

/**
 * Obtiene el historial de precios / precios actuales de una skin.
 * Se usa para calibrar los umbrales de compra.
 */
export async function obtenerPreciosMercado(marketHashName) {
  return withRetry(async () => {
    const resp = await http.get('/listings/stats', {
      params: { market_hash_name: marketHashName },
    });
    return resp.data?.data ?? null;
  }, {
    retries: 3,
    base:    3000,
    retryIf: isRetryableHttpError,
  });
}

/**
 * Ejecuta la compra de un listing.
 * En modo paper, simula la compra sin llamar a la API real.
 *
 * @param {string} listingId  — ID del listing en CSFloat
 * @param {number} precio     — Precio esperado (para verificación de slippage)
 * @returns {Promise<object>}  — Datos de la transacción
 */
export async function comprar(listingId, precio) {
  if (BOT.mode === 'paper') {
    log.info(`[PAPER] Simulando compra listing ${listingId} @ $${precio}`);
    logEvento('compra_ejecutada', `[PAPER] Listing ${listingId}`, { listingId, precio });
    return { id: `paper_${Date.now()}`, status: 'simulated', precio };
  }

  return withRetry(async () => {
    const resp = await http.post(`/listings/${listingId}/buy`, {
      max_price: Math.floor(precio * 100 * 1.005),  // +0.5% tolerancia de slippage
    });
    return resp.data;
  }, {
    retries:  2,
    base:     1000,
    maxDelay: 5000,
    retryIf:  (err) => {
      // NO reintentar en compras si el status es 4xx (podría duplicar la compra)
      const status = err?.response?.status;
      return !status || status >= 500;
    },
    onRetry: (n, err) => log.warn(`CSFloat compra: reintento ${n}`, { err: err.message }),
  });
}

/**
 * Verifica el saldo de la cuenta CSFloat.
 */
export async function obtenerSaldo() {
  const resp = await http.get('/me');
  return resp.data?.user?.balance_usd ?? null;
}

// ── WebSocket en tiempo real ───────────────────────────────────────────────
let ws            = null;
let reconectando  = false;
let intentosWS    = 0;
let pingInterval  = null;
const manejadores = new Map();   // skinId → callback

/**
 * Inicia la conexión WebSocket con CSFloat para recibir listings en tiempo real.
 *
 * @param {Function} onListing — callback(listing) llamado por cada nuevo listing relevante
 */
export function iniciarWebSocket(onListing) {
  _conectarWS(onListing);
}

function _conectarWS(onListing) {
  if (reconectando) return;
  reconectando = true;

  const url = `${CSFLOAT.wsUrl}?apiKey=${CSFLOAT.apiKey}`;
  log.info(`Conectando a CSFloat WebSocket (intento ${intentosWS + 1})...`);

  ws = new WebSocket(url, {
    headers: { 'Origin': 'https://csfloat.com' },
  });

  ws.on('open', () => {
    intentosWS   = 0;
    reconectando = false;
    log.ok('CSFloat WebSocket conectado ✅');
    logEvento('bot_reanudado', 'WebSocket CSFloat conectado');

    // Suscribirse a las skins activas
    const skinsFiltro = SKINS
      .filter(s => s.activa)
      .map(s => s.marketName);

    ws.send(JSON.stringify({
      type:    'subscribe',
      channel: 'listings',
      filters: { market_hash_names: skinsFiltro },
    }));

    // Ping cada 30s para mantener la conexión viva
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // CSFloat envía distintos tipos de mensaje
      if (msg.type === 'listings' && Array.isArray(msg.data)) {
        for (const listing of msg.data) {
          _procesarListingWS(listing, onListing);
        }
      }
      if (msg.type === 'listing' && msg.data) {
        _procesarListingWS(msg.data, onListing);
      }
    } catch (err) {
      log.warn('WS: error parseando mensaje', { err: err.message });
    }
  });

  ws.on('error', (err) => {
    log.error('CSFloat WebSocket error', { err: err.message });
  });

  ws.on('close', (code, reason) => {
    clearInterval(pingInterval);
    reconectando = false;
    const motivo = reason?.toString() || 'desconocido';
    log.warn(`CSFloat WebSocket cerrado (${code}: ${motivo}). Reconectando...`);
    logEvento('error', `WS cerrado: ${code}`, { code, motivo });

    // Backoff exponencial: 2s, 4s, 8s, 16s, 32s, max 120s
    intentosWS++;
    const delay = Math.min(2000 * Math.pow(2, intentosWS - 1), 120_000);
    setTimeout(() => _conectarWS(onListing), delay);
  });
}

/**
 * Normaliza un listing del WebSocket y lo pasa al handler si es relevante.
 */
function _procesarListingWS(listing, onListing) {
  try {
    const item = listing.item;
    if (!item) return;

    const precioUsd   = listing.price / 100;     // CSFloat retorna centavos
    const floatValue  = parseFloat(item.float_value ?? item.floatvalue ?? 0);
    const marketName  = item.market_hash_name ?? item.market_name ?? '';

    // Buscar la skin en nuestra configuración
    const skin = SKINS.find(s =>
      s.activa && s.marketName.toLowerCase() === marketName.toLowerCase()
    );
    if (!skin) return;

    // Verificar contra los bands de la skin
    for (const band of skin.bands) {
      if (
        floatValue >= band.floatMin &&
        floatValue <= band.floatMax &&
        precioUsd  <= band.maxCompraCF
      ) {
        log.ok(`🎯 WS hit! ${marketName} | float: ${floatValue.toFixed(6)} | $${precioUsd}`);
        onListing({
          listingId:  listing.id,
          skin,
          band,
          floatValue,
          precio:     precioUsd,
          paintSeed:  item.paint_seed,
          marketName,
          rawListing: listing,
        });
        break;
      }
    }
  } catch (err) {
    log.warn('WS: error procesando listing', { err: err.message });
  }
}

/** Cierra la conexión WebSocket limpiamente. */
export function cerrarWebSocket() {
  clearInterval(pingInterval);
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}
