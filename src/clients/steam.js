// ─────────────────────────────────────────────────────────────────────────────
// clients/steam.js — Cliente Steam Market
//
// Responsabilidades:
//   - Obtener precios actuales de Steam Market (precio mediano, mínimo, volumen)
//   - Listar ítems en Steam Market para venta
//   - Verificar inventario
//   - Manejo de sesión (cookies) y rate limits agresivos de Steam
//
// NOTA: Steam es muy agresivo en rate limiting. Espaciar llamadas >= 3s.
//       Las cookies de sesión expiran. El bot monitorea 401/403 y alerta.
// ─────────────────────────────────────────────────────────────────────────────
import axios from 'axios';
import { STEAM, BOT, FEES }   from '../config.js';
import { withRetry, isRetryableHttpError, sleep } from '../utils/retry.js';
import { log, logEvento, logPrecio }              from '../services/logger.js';
import { alertaError }                            from '../services/alerts.js';

// ── HTTP Client sin sesión (endpoints públicos) ───────────────────────────
const httpPublico = axios.create({
  baseURL: STEAM.marketBaseUrl,
  timeout: 15_000,
  headers: {
    'User-Agent':  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept':      'application/json, text/javascript, */*; q=0.01',
    'Referer':     'https://steamcommunity.com/market/',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

// ── HTTP Client con sesión (endpoints autenticados) ───────────────────────
const httpSesion = axios.create({
  baseURL: 'https://steamcommunity.com',
  timeout: 20_000,
  headers: {
    'User-Agent':  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Referer':     'https://steamcommunity.com/market/',
    'Cookie':      `sessionid=${STEAM.sessionId}; steamLoginSecure=${STEAM.loginSecure}; ${STEAM.parental ? `steamparental=${STEAM.parental}` : ''}`,
  },
});

// Rate limiter compartido para Steam
let ultimaLlamadaSteam = 0;
async function rateLimitSteam() {
  const ahora   = Date.now();
  const esperar = STEAM.rateLimitMs - (ahora - ultimaLlamadaSteam);
  if (esperar > 0) await sleep(esperar);
  ultimaLlamadaSteam = Date.now();
}

// ── Precios de mercado ────────────────────────────────────────────────────

/**
 * Obtiene el precio actual de un ítem en Steam Market.
 * Retorna: { precio_min, precio_median, volumen, moneda }
 *
 * Este endpoint es público (no requiere sesión).
 */
export async function obtenerPrecioSteam(marketHashName, appId = 730) {
  await rateLimitSteam();

  return withRetry(async () => {
    const resp = await httpPublico.get('/priceoverview/', {
      params: {
        appid:            appId,
        currency:         1,           // 1 = USD
        market_hash_name: marketHashName,
      },
    });

    const d = resp.data;
    if (!d.success) throw new Error('Steam API: success=false');

    // Steam retorna strings como "$0.35"
    const parsear = (s) => parseFloat(String(s ?? '0').replace(/[^0-9.]/g, '')) || null;

    return {
      precio_min:    parsear(d.lowest_price),
      precio_median: parsear(d.median_price),
      volumen:       parseInt(d.volume?.replace(/,/g, '') || '0', 10),
    };
  }, {
    retries: 4,
    base:    5000,
    retryIf: (err) => {
      // Si Steam nos bloquea (429, 403), esperamos más
      if (err?.response?.status === 429) {
        log.warn('Steam: rate limit 429. Esperando 60s...');
        return true;
      }
      return isRetryableHttpError(err);
    },
    onRetry: (n, err, delay) => log.warn(`Steam precios: reintento ${n}/${delay}ms`, { err: err.message }),
  });
}

/**
 * Obtiene el historial de ventas recientes (últimas N transacciones).
 * Útil para calcular precio de venta óptimo.
 *
 * ATENCIÓN: Este endpoint requiere estar autenticado.
 */
export async function historialVentas(marketHashName, appId = 730) {
  await rateLimitSteam();

  if (!STEAM.sessionId || !STEAM.loginSecure) {
    log.warn('Steam: sesión no configurada — historialVentas no disponible');
    return null;
  }

  return withRetry(async () => {
    const resp = await httpSesion.get('/market/pricehistory/', {
      params: {
        appid:            appId,
        market_hash_name: marketHashName,
      },
    });

    if (!resp.data.success) throw new Error('Steam historial: success=false');

    // Retorna array de [fecha_str, precio, volumen_str]
    const ventas = (resp.data.prices ?? [])
      .slice(-50)
      .map(([fecha, precio, vol]) => ({
        fecha:  new Date(fecha),
        precio: parseFloat(precio),
        volumen: parseInt(vol, 10),
      }));

    return ventas;
  }, {
    retries: 3,
    base:    8000,
    retryIf: isRetryableHttpError,
  });
}

/**
 * Calcula el precio óptimo de venta basado en el historial.
 * Estrategia: usar el percentil 20 de las últimas ventas (vender rápido, no caro).
 */
export function calcularPrecioVenta(historial, descuentoPct = 0.02) {
  if (!historial || historial.length === 0) return null;

  // Usar solo ventas de las últimas 72h para mayor relevancia
  const hace72h = Date.now() - 72 * 60 * 60 * 1000;
  const recientes = historial
    .filter(v => v.fecha.getTime() >= hace72h)
    .map(v => v.precio)
    .sort((a, b) => a - b);

  if (recientes.length === 0) return null;

  // Percentil 20 = precio al que vende el 20% más barato
  const idx     = Math.floor(recientes.length * 0.20);
  const p20     = recientes[idx];

  // Aplicar descuento para asegurar la venta
  return parseFloat((p20 * (1 - descuentoPct)).toFixed(2));
}

// ── Listado en Steam Market ───────────────────────────────────────────────

/**
 * Lista un ítem del inventario en Steam Market.
 * Requiere sesión autenticada.
 *
 * @param {string} assetId    — ID del asset en el inventario Steam
 * @param {number} appId      — App ID (730 para CS2)
 * @param {number} contextId  — Context ID (2 para CS2)
 * @param {number} precio     — Precio en USD (lo que el comprador paga)
 * @returns {Promise<boolean>} — true si se listó correctamente
 */
export async function listarEnMarket(assetId, appId, contextId, precio) {
  if (BOT.mode === 'paper') {
    log.info(`[PAPER] Simulando listado asset ${assetId} @ $${precio}`);
    return true;
  }

  if (!STEAM.sessionId || !STEAM.loginSecure) {
    throw new Error('Steam: sesión no configurada para listado');
  }

  await rateLimitSteam();

  // Steam usa el precio en centavos (lo que recibe el vendedor = precio * 0.87)
  const precioVendedor = Math.floor(precio * FEES.steam * 100);  // centavos

  return withRetry(async () => {
    const params = new URLSearchParams({
      sessionid:        STEAM.sessionId,
      appid:            String(appId),
      contextid:        String(contextId),
      assetid:          assetId,
      amount:           '1',
      price:            String(precioVendedor),
    });

    const resp = await httpSesion.post('/market/sellitem/', params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!resp.data.success) {
      const msg = resp.data.message || resp.data.error || 'Error desconocido';
      throw new Error(`Steam sellitem: ${msg}`);
    }

    log.ok(`✅ Listado en Steam Market: asset ${assetId} @ $${precio}`);
    return true;
  }, {
    retries:  2,
    base:     5000,
    retryIf:  (err) => {
      // No reintentar si Steam dice "ya está listado" o errores de autenticación
      const msg = err.message || '';
      if (msg.includes('already listed')) return false;
      if (err?.response?.status === 401) {
        alertaError('Steam: sesión expirada', 'Actualiza las cookies en .env');
        return false;
      }
      return isRetryableHttpError(err);
    },
    onRetry: (n, err) => log.warn(`Steam listado: reintento ${n}`, { err: err.message }),
  });
}

// ── Inventario ────────────────────────────────────────────────────────────

/**
 * Obtiene el inventario CS2 del usuario.
 * @param {string} steamId64 — Steam ID del usuario
 */
export async function obtenerInventario(steamId64) {
  await rateLimitSteam();

  if (!steamId64) {
    log.warn('Steam: steamId64 no configurado, inventario no disponible');
    return [];
  }

  return withRetry(async () => {
    const resp = await httpPublico.get(
      `https://steamcommunity.com/inventory/${steamId64}/730/2`,
      {
        params: { l: 'english', count: 200 },
        headers: { Cookie: `sessionid=${STEAM.sessionId}; steamLoginSecure=${STEAM.loginSecure}` },
      }
    );

    const { assets = [], descriptions = [] } = resp.data;

    // Cruzar assets con descriptions para obtener nombres
    const descMap = new Map(
      descriptions.map(d => [`${d.classid}_${d.instanceid}`, d])
    );

    return assets.map(asset => {
      const desc = descMap.get(`${asset.classid}_${asset.instanceid}`) ?? {};
      return {
        assetId:    asset.assetid,
        classId:    asset.classid,
        nombre:     desc.market_hash_name ?? desc.name ?? 'Desconocido',
        tradable:   desc.tradable === 1,
        marketable: desc.marketable === 1,
      };
    }).filter(a => a.marketable);
  }, {
    retries: 3,
    base:    10_000,
    retryIf: isRetryableHttpError,
  });
}

// ── Snapshot de precio para logger ────────────────────────────────────────

/**
 * Obtiene y guarda el precio actual de Steam para una skin.
 * Retorna el precio mediano o null.
 */
export async function snapshotPrecioSteam(skin) {
  try {
    const datos = await obtenerPrecioSteam(skin.marketName, skin.appId);
    if (!datos) return null;

    logPrecio({
      skin_id:    skin.id,
      plataforma: 'steam',
      precio:     datos.precio_median ?? datos.precio_min,
      precio_min: datos.precio_min,
      precio_max: null,
      volumen_24h: datos.volumen,
    });

    return datos.precio_median ?? datos.precio_min;
  } catch (err) {
    log.warn(`Steam snapshot fallido para ${skin.id}`, { err: err.message });
    return null;
  }
}
