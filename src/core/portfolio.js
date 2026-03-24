// ─────────────────────────────────────────────────────────────────────────────
// core/portfolio.js — Gestión de capital y reinversión inteligente
//
// Responsabilidades:
//   - Rastrear capital disponible en tiempo real
//   - Calcular cuántas unidades comprar según capital disponible
//   - Implementar la estrategia de reinversión compuesta
//   - Detectar cuando hacer retiros
// ─────────────────────────────────────────────────────────────────────────────
import { BOT, REINVERSION, FEES }          from '../config.js';
import { operacionesAbiertas, historialReciente, logEvento } from '../services/logger.js';
import { alertaRetiro }                    from '../services/alerts.js';
import { log }                             from '../services/logger.js';

// ── Estado del portfolio ──────────────────────────────────────────────────
// En un sistema real, esto debería persistirse en DB y recuperarse al reinicio
let capitalActual = BOT.capitalInicial;
let gananciaTotal = 0;
let retiresTotales = 0;

// Actualizar capital desde el historial de operaciones al inicio
export function inicializarPortfolio() {
  const ops = historialReciente(1000);

  // Recalcular capital desde operaciones históricas
  let capital = BOT.capitalInicial;
  for (const op of ops.reverse()) {   // cronológico
    if (op.estado === 'comprado' || op.estado === 'listado_steam') {
      capital -= op.costo_total;       // Dinero inmovilizado
    }
    if (op.estado === 'vendido' && op.ganancia_usd !== null) {
      capital += op.costo_total + op.ganancia_usd;  // Recuperamos inversión + ganancia
      gananciaTotal += op.ganancia_usd;
    }
  }
  capitalActual = Math.max(0, capital);
  log.ok(`Portfolio inicializado: capital=$${capitalActual.toFixed(2)}, ganancia total=$${gananciaTotal.toFixed(2)}`);
}

// ── Capital disponible ────────────────────────────────────────────────────

/** Capital total actual (disponible + inmovilizado en ops abiertas). */
export function getCapital() {
  return capitalActual;
}

/** Capital disponible para nuevas compras (excluye exposición en ops abiertas). */
export function getCapitalDisponible() {
  const abiertas    = operacionesAbiertas();
  const expuesto    = abiertas.reduce((sum, op) => sum + op.costo_total, 0);
  return Math.max(0, capitalActual - expuesto);
}

/** Capital actualmente inmovilizado en operaciones abiertas. */
export function getExposicion() {
  const abiertas = operacionesAbiertas();
  return abiertas.reduce((sum, op) => sum + op.costo_total, 0);
}

/** Actualiza el capital tras una compra. */
export function registrarCompraCapital(costoTotal) {
  // El capital no cambia inmediatamente — el dinero sigue "en el inventario"
  // Solo tracking de exposición
  log.info(`Capital tracking: compra $${costoTotal.toFixed(2)} | disponible $${getCapitalDisponible().toFixed(2)}`);
}

/** Actualiza el capital tras una venta confirmada. */
export function registrarVentaCapital(costoTotal, gananciaUsd) {
  capitalActual += gananciaUsd;
  gananciaTotal += gananciaUsd;
  const signo = gananciaUsd >= 0 ? '+' : '';
  log.ok(`Capital actualizado: ${signo}$${gananciaUsd.toFixed(3)} | Total: $${capitalActual.toFixed(2)}`);
  logEvento('venta_completada', `Capital actualizado a $${capitalActual.toFixed(2)}`, { gananciaUsd, capitalActual });
  _verificarRetiro();
}

// ── Cálculo de unidades a comprar ─────────────────────────────────────────

/**
 * Calcula cuántas unidades de una skin comprar maximizando el número de
 * operaciones simultáneas sin sobreexponer el capital.
 *
 * Estrategia:
 *   - No más de maxUnidadesSimultaneas de la misma skin
 *   - No más de maxExposicionCapitalPct% del capital total en una sola skin
 *   - Siempre dejar al menos 15% del capital como buffer
 *
 * @param {object} skin      — Configuración de la skin
 * @param {number} costoUnit — Costo por unidad (precio + fee)
 * @returns {number} — Número de unidades a comprar (0 si no hay capital)
 */
export function calcularUnidadesComprar(skin, costoUnit) {
  const disponible = getCapitalDisponible();
  const buffer     = capitalActual * 0.15;   // 15% de reserva
  const comprable  = Math.max(0, disponible - buffer);

  if (comprable < costoUnit) return 0;

  // Cuántas unidades caben en el capital disponible
  const porCapital = Math.floor(comprable / costoUnit);

  // Cuántas ya tenemos abiertas de esta skin
  const abiertas = operacionesAbiertas();
  const yaAbiertas = abiertas.filter(op => op.skin_id === skin.id).length;
  const libres = REINVERSION.maxUnidadesSimultaneas - yaAbiertas;

  if (libres <= 0) return 0;

  const unidades = Math.min(porCapital, libres, 1);  // Comprar de 1 en 1 por seguridad
  log.debug(`Unidades: capital_disponible=$${disponible.toFixed(2)}, costo=$${costoUnit.toFixed(2)}, unidades=${unidades}`);
  return unidades;
}

// ── Reinversión compuesta ─────────────────────────────────────────────────

/**
 * Determina si la Fase 2 debe activarse (capital >= $50).
 * En el archivo config.js están marcadas las skins de fase 2 como inactivas.
 * Esta función debe llamarse en el bot principal para actualizar el estado.
 */
export function evaluarActivacionFase2(skins) {
  if (capitalActual < 50) return false;
  const fase2 = skins.filter(s => s.fase === 2 && !s.activa);
  if (fase2.length === 0) return false;

  log.ok(`💰 Capital $${capitalActual.toFixed(2)} — Evaluando activación Fase 2...`);
  // Retorna true para que el bot principal habilite las skins de fase 2
  return true;
}

/** Resumen del portfolio para el dashboard. */
export function resumenPortfolio() {
  const abiertas    = operacionesAbiertas();
  const expuesto    = abiertas.reduce((sum, op) => sum + op.costo_total, 0);
  const disponible  = getCapitalDisponible();

  return {
    capitalTotal:    capitalActual,
    capitalDisponible: disponible,
    exposicion:      expuesto,
    gananciaTotal,
    retiresTotales,
    operacionesAbiertas: abiertas.length,
    modo:            BOT.mode,
  };
}

// ── Privado ───────────────────────────────────────────────────────────────

/** Verifica si se debe hacer un retiro según la estrategia de reinversión. */
async function _verificarRetiro() {
  const { umbralRetiro, pctRetiro, pctGananciaParaRetirar } = REINVERSION;

  if (capitalActual < umbralRetiro) return;

  // Superar el umbral en el % de ganancia objetivo
  const umbralConGanancia = umbralRetiro * (1 + pctGananciaParaRetirar);
  if (capitalActual < umbralConGanancia) return;

  const aRetirar = capitalActual * pctRetiro;
  log.ok(`💸 RETIRO SUGERIDO: $${aRetirar.toFixed(2)} (capital: $${capitalActual.toFixed(2)})`);
  logEvento('retiro_sugerido', `$${aRetirar.toFixed(2)}`, { capitalActual, aRetirar });

  await alertaRetiro({ capitalActual, umbral: umbralRetiro, pctRetiro });

  // Simular retiro en modo paper
  if (BOT.mode === 'paper') {
    capitalActual -= aRetirar;
    retiresTotales += aRetirar;
    log.info(`[PAPER] Retiro simulado: -$${aRetirar.toFixed(2)} | Capital restante: $${capitalActual.toFixed(2)}`);
  }
  // En modo live, el retiro es manual (el usuario lo hace en Steam)
}
