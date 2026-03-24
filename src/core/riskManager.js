// ─────────────────────────────────────────────────────────────────────────────
// core/riskManager.js — Gestión de riesgo automática
//
// Implementa los "circuit breakers" que pausan el bot ante condiciones adversas:
//   1. Spread entre plataformas < umbral mínimo
//   2. Precio de Steam bajó > X% en 24h
//   3. N operaciones fallidas consecutivas
//   4. Exposición de capital excesiva
//
// El estado de riesgo persiste en memoria (se resetea si el bot reinicia).
// Para producción, considera persistirlo en SQLite.
// ─────────────────────────────────────────────────────────────────────────────
import { RIESGO, FEES }               from '../config.js';
import { log, logEvento, cambioPrecio24h, precioReciente } from '../services/logger.js';
import { alertaPausa }                from '../services/alerts.js';
import { sleep }                      from '../utils/retry.js';

// ── Estado interno ────────────────────────────────────────────────────────
const estado = {
  pausado:           false,
  motivoPausa:       null,
  ts_pausa:          null,
  fallosConsecutivos: 0,
  fallosDetalle:     [],
  // Por skin: { [skin_id]: { pausada: bool, motivo: str } }
  pausasPorSkin:     {},
};

// ── API pública ────────────────────────────────────────────────────────────

/** ¿Está el bot globalmente pausado? */
export function estaPausado() {
  return estado.pausado;
}

/** ¿Está pausado para una skin específica? */
export function skinEstaPausada(skinId) {
  return estado.pausasPorSkin[skinId]?.pausada ?? false;
}

/**
 * Verifica TODAS las reglas de riesgo para una oportunidad de compra.
 *
 * @param {object} params
 * @param {object} params.skin          — Configuración de la skin
 * @param {object} params.band          — Band de float activo
 * @param {number} params.precioCompra  — Precio de compra en CSFloat (USD)
 * @param {number} params.precioVenta   — Precio de venta estimado en Steam (USD)
 * @param {number} params.capitalActual — Capital disponible (USD)
 * @param {number} params.exposicionActual — USD actualmente en operaciones abiertas
 *
 * @returns {{ ok: boolean, motivo?: string }}
 */
export function verificarRiesgo({ skin, band, precioCompra, precioVenta, capitalActual, exposicionActual }) {

  // ── 1. Bot globalmente pausado ──────────────────────────────────────
  if (estado.pausado) {
    return { ok: false, motivo: `Bot pausado: ${estado.motivoPausa}` };
  }

  // ── 2. Skin específica pausada ──────────────────────────────────────
  if (skinEstaPausada(skin.id)) {
    return { ok: false, motivo: `Skin pausada: ${estado.pausasPorSkin[skin.id]?.motivo}` };
  }

  // ── 3. Spread mínimo ─────────────────────────────────────────────────
  const costoTotal      = precioCompra * (1 + (1 - FEES.csfloat));  // precio + fee 2%
  const ingresoNeto     = precioVenta * FEES.steam;                  // precio × 0.87
  const spreadPct       = ((ingresoNeto - costoTotal) / costoTotal) * 100;

  if (spreadPct < RIESGO.spreadMinPct) {
    return {
      ok: false,
      motivo: `Spread insuficiente: ${spreadPct.toFixed(1)}% < ${RIESGO.spreadMinPct}%`,
    };
  }

  // ── 4. Caída de precio Steam 24h ──────────────────────────────────────
  const caida24h = cambioPrecio24h(skin.id, 'steam');
  if (caida24h !== null && caida24h < -RIESGO.caida24hMaxPct) {
    return {
      ok: false,
      motivo: `Steam bajó ${Math.abs(caida24h).toFixed(1)}% en 24h (máx: ${RIESGO.caida24hMaxPct}%)`,
    };
  }

  // ── 5. Fallos consecutivos ────────────────────────────────────────────
  if (estado.fallosConsecutivos >= RIESGO.maxFallosConsecutivos) {
    return {
      ok: false,
      motivo: `${estado.fallosConsecutivos} fallos consecutivos — pausado para análisis`,
    };
  }

  // ── 6. Exposición de capital ──────────────────────────────────────────
  const exposicionTotal   = exposicionActual + costoTotal;
  const exposicionPct     = (exposicionTotal / capitalActual) * 100;
  if (exposicionPct > RIESGO.maxExposicionCapitalPct) {
    return {
      ok: false,
      motivo: `Exposición ${exposicionPct.toFixed(1)}% excede máximo ${RIESGO.maxExposicionCapitalPct}%`,
    };
  }

  // ── 7. Capital suficiente ─────────────────────────────────────────────
  if (costoTotal > capitalActual - exposicionActual) {
    return {
      ok: false,
      motivo: `Capital insuficiente: $${(capitalActual - exposicionActual).toFixed(2)} disponible, necesita $${costoTotal.toFixed(2)}`,
    };
  }

  return { ok: true, spreadPct, costoTotal, ingresoNeto };
}

/**
 * Registra un fallo de operación. Si se supera el umbral, pausa el bot.
 */
export function registrarFallo(motivo, detalles = {}) {
  estado.fallosConsecutivos++;
  estado.fallosDetalle.push({ motivo, detalles, ts: Date.now() });
  // Mantener solo los últimos 10 fallos
  if (estado.fallosDetalle.length > 10) estado.fallosDetalle.shift();

  log.warn(`Fallo registrado (${estado.fallosConsecutivos}/${RIESGO.maxFallosConsecutivos}): ${motivo}`);

  if (estado.fallosConsecutivos >= RIESGO.maxFallosConsecutivos) {
    _pausarBot(`${estado.fallosConsecutivos} fallos consecutivos`, motivo);
  }
}

/**
 * Registra una operación exitosa — resetea el contador de fallos.
 */
export function registrarExito() {
  if (estado.fallosConsecutivos > 0) {
    log.info(`Resetando fallos consecutivos (eran ${estado.fallosConsecutivos})`);
  }
  estado.fallosConsecutivos = 0;
  estado.fallosDetalle      = [];
}

/**
 * Pausa el bot para una skin específica (no para todo).
 */
export function pausarSkin(skinId, motivo) {
  estado.pausasPorSkin[skinId] = { pausada: true, motivo, ts: Date.now() };
  log.warn(`Skin ${skinId} pausada: ${motivo}`);
  logEvento('bot_pausado', `Skin ${skinId} pausada`, { skinId, motivo });
}

/**
 * Reanuda el bot manualmente (o automáticamente tras cooldown).
 */
export function reanudar(motivo = 'Manual') {
  if (!estado.pausado) return;
  estado.pausado     = false;
  estado.motivoPausa = null;
  estado.ts_pausa    = null;
  estado.fallosConsecutivos = 0;
  log.ok(`Bot reanudado: ${motivo}`);
  logEvento('bot_reanudado', motivo);
}

/**
 * Obtiene el resumen del estado de riesgo para el dashboard.
 */
export function estadoRiesgo() {
  return {
    pausado:           estado.pausado,
    motivoPausa:       estado.motivoPausa,
    fallosConsecutivos: estado.fallosConsecutivos,
    tiempoPausadoMin:  estado.ts_pausa
      ? Math.floor((Date.now() - estado.ts_pausa) / 60_000)
      : 0,
  };
}

/**
 * Tarea programada: verifica condiciones de mercado periódicamente.
 * Llama esto desde el bot principal cada 5 minutos.
 */
export async function verificacionPeriodica(skins) {
  for (const skin of skins.filter(s => s.activa)) {
    const caida = cambioPrecio24h(skin.id, 'steam');
    if (caida !== null && caida < -RIESGO.caida24hMaxPct) {
      const motivo = `${skin.nombre}: Steam bajó ${Math.abs(caida).toFixed(1)}% en 24h`;
      pausarSkin(skin.id, motivo);
      await alertaPausa({
        motivo,
        detalles: `Caída detectada: ${caida.toFixed(1)}%`,
        cooldownMin: RIESGO.cooldownRiesgoBotMs / 60_000,
      });
    }
  }
}

// ── Privado ───────────────────────────────────────────────────────────────
async function _pausarBot(motivo, detalles) {
  estado.pausado     = true;
  estado.motivoPausa = motivo;
  estado.ts_pausa    = Date.now();

  log.error(`🔴 BOT PAUSADO: ${motivo}`);
  logEvento('bot_pausado', motivo, { detalles });

  await alertaPausa({
    motivo,
    detalles,
    cooldownMin: RIESGO.cooldownRiesgoBotMs / 60_000,
  });

  // Cooldown automático — reanudar después de N minutos
  setTimeout(() => {
    reanudar('Cooldown automático expirado');
  }, RIESGO.cooldownRiesgoBotMs);
}
