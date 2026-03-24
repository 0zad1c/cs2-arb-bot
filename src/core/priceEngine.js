// ─────────────────────────────────────────────────────────────────────────────
// core/priceEngine.js — Motor de precios en tiempo real
//
// Actualiza los umbrales de compra/venta cada 30 minutos basado en:
//   - Precio actual en Steam Market (mediana de ventas recientes)
//   - Precio mínimo actual en CSFloat
//   - Cálculo automático del spread y margen de ganancia
// ─────────────────────────────────────────────────────────────────────────────
import { SKINS, PRECIOS, FEES, RIESGO } from '../config.js';
import { snapshotPrecioSteam, historialVentas, calcularPrecioVenta, obtenerPrecioSteam } from '../clients/steam.js';
import { buscarListings, obtenerPreciosMercado }  from '../clients/csfloat.js';
import { log, logPrecio, precioReciente }          from '../services/logger.js';
import { sleep }                                   from '../utils/retry.js';

// Cache de precios en memoria (reducir llamadas a DB)
const cachePrecios = new Map();  // skinId → { steam, csfloat, ts }
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutos

// ── Actualización de precios ──────────────────────────────────────────────

/**
 * Actualiza precios de Steam y CSFloat para TODAS las skins activas.
 * Llama esto periódicamente (default: cada 30 min).
 */
export async function actualizarTodosLosPrecios() {
  const skinsActivas = SKINS.filter(s => s.activa);
  log.info(`Motor de precios: actualizando ${skinsActivas.length} skins...`);

  for (const skin of skinsActivas) {
    try {
      await actualizarPreciosSkin(skin);
      // Esperar entre skins para no golpear los rate limits
      await sleep(PRECIOS.actualizarCadaMs / skinsActivas.length / 10);
    } catch (err) {
      log.warn(`Error actualizando precios de ${skin.id}`, { err: err.message });
    }
  }
  log.ok('Motor de precios: actualización completa ✅');
}

/**
 * Actualiza precios de una skin específica.
 * Retorna { precioSteam, precioCsfloatMin, spreadPct, ok }
 */
export async function actualizarPreciosSkin(skin) {
  // ── Steam ─────────────────────────────────────────────────────
  let precioSteam = null;
  try {
    const datosSteam = await obtenerPrecioSteam(skin.marketName, skin.appId);
    precioSteam = datosSteam?.precio_median ?? datosSteam?.precio_min;

    if (precioSteam) {
      logPrecio({
        skin_id:    skin.id,
        plataforma: 'steam',
        precio:     precioSteam,
        precio_min: datosSteam.precio_min,
        volumen_24h: datosSteam.volumen,
      });
    }
  } catch (err) {
    log.warn(`${skin.id}: fallo precio Steam`, { err: err.message });
    precioSteam = precioReciente(skin.id, 'steam');  // Usar último conocido
  }

  // ── CSFloat ────────────────────────────────────────────────────
  let precioCsfloatMin = null;
  try {
    // Buscar el listing más barato para calibrar el umbral
    for (const band of skin.bands) {
      const listings = await buscarListings({
        marketHashName: skin.marketName,
        minFloat:       band.floatMin,
        maxFloat:       band.floatMax,
        maxPrice:       band.maxCompraCF * 1.5,   // Buscar un rango amplio
        limit:          5,
      });

      if (listings.length > 0) {
        const minPrecio = Math.min(...listings.map(l => l.price / 100));
        precioCsfloatMin = minPrecio;

        logPrecio({
          skin_id:    skin.id,
          plataforma: 'csfloat',
          precio:     minPrecio,
          precio_min: minPrecio,
        });
        break;
      }
      await sleep(1500);
    }
  } catch (err) {
    log.warn(`${skin.id}: fallo precio CSFloat`, { err: err.message });
    precioCsfloatMin = precioReciente(skin.id, 'csfloat');
  }

  // ── Calcular spread ────────────────────────────────────────────
  let spreadPct = null;
  if (precioSteam && precioCsfloatMin) {
    const costoTotal  = precioCsfloatMin * (1 / FEES.csfloat);  // Incluye fee CF
    const ingresoNeto = precioSteam * FEES.steam;
    spreadPct = ((ingresoNeto - costoTotal) / costoTotal) * 100;
  }

  // Actualizar cache
  cachePrecios.set(skin.id, {
    steam:       precioSteam,
    csfloat:     precioCsfloatMin,
    spreadPct,
    ts:          Date.now(),
  });

  if (precioSteam && precioCsfloatMin) {
    const alert = spreadPct >= RIESGO.spreadMinPct ? '✅' : '⚠️';
    log.info(
      `${alert} ${skin.id} | Steam: $${precioSteam?.toFixed(2)} | CF min: $${precioCsfloatMin?.toFixed(2)} | Spread: ${spreadPct?.toFixed(1)}%`
    );
  }

  return { precioSteam, precioCsfloatMin, spreadPct };
}

// ── Calibración de umbrales ───────────────────────────────────────────────

/**
 * Dado el precio actual de Steam, calcula el precio máximo de compra en CSFloat
 * para garantizar el spread mínimo objetivo.
 *
 * Fórmula:
 *   maxCompraCF = (precioSteam × feeSteam) / ((1 + spreadObj/100) × (1/feeCF))
 *
 * @param {number} precioSteam   — Precio mediano en Steam (USD)
 * @param {number} spreadObj     — Spread objetivo en % (e.g., 18)
 * @returns {number} — Precio máximo de compra en CSFloat
 */
export function calcularMaxCompraCF(precioSteam, spreadObj = 18) {
  const ingresoNeto    = precioSteam * FEES.steam;
  const factorSpread   = 1 + spreadObj / 100;
  const factorFee      = 1 / FEES.csfloat;
  return ingresoNeto / (factorSpread * factorFee);
}

/**
 * Obtiene el precio de Steam cacheado para una skin.
 * Útil para decisiones rápidas sin llamar a la API.
 */
export function getPrecioSteamCache(skinId) {
  const cache = cachePrecios.get(skinId);
  if (!cache) return null;
  if (Date.now() - cache.ts > CACHE_TTL_MS) return null;  // Expirado
  return cache.steam;
}

/**
 * Obtiene el spread cacheado para una skin.
 */
export function getSpreadCache(skinId) {
  const cache = cachePrecios.get(skinId);
  if (!cache) return null;
  if (Date.now() - cache.ts > CACHE_TTL_MS) return null;
  return cache.spreadPct;
}

/**
 * Verifica si el spread actual es mayor al mínimo requerido.
 */
export function spreadEsViable(skinId) {
  const spread = getSpreadCache(skinId);
  if (spread === null) return true;   // Sin datos → no bloquear por esto
  return spread >= RIESGO.spreadMinPct;
}

/**
 * Retorna un resumen de precios de todas las skins para el dashboard.
 */
export function resumenPrecios() {
  return SKINS.map(skin => {
    const cache = cachePrecios.get(skin.id);
    return {
      id:       skin.id,
      nombre:   skin.nombre,
      activa:   skin.activa,
      steam:    cache?.steam    ?? null,
      csfloat:  cache?.csfloat  ?? null,
      spread:   cache?.spreadPct ?? null,
      edad_min: cache ? Math.floor((Date.now() - cache.ts) / 60_000) : null,
    };
  });
}

// ── Scheduler ────────────────────────────────────────────────────────────

/**
 * Inicia el ciclo automático de actualización de precios.
 * @param {number} intervalMs — Intervalo en ms (default: config)
 */
export function iniciarScheduler(intervalMs = PRECIOS.actualizarCadaMs) {
  // Primera actualización inmediata
  actualizarTodosLosPrecios().catch(err => log.error('Price scheduler error', { err: err.message }));

  // Luego periódicamente
  const id = setInterval(() => {
    actualizarTodosLosPrecios().catch(err => log.error('Price scheduler error', { err: err.message }));
  }, intervalMs);

  log.info(`Motor de precios iniciado — actualiza cada ${intervalMs / 60_000} minutos`);
  return id;
}
