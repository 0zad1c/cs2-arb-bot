// ─────────────────────────────────────────────────────────────────────────────
// services/dashboard.js — Dashboard en consola (actualiza cada 30s)
//
// Muestra en tiempo real:
//   - Estado del bot y modo
//   - Capital actual, exposición, ganancia
//   - Operaciones abiertas
//   - Estado de riesgo
//   - Precios actuales de las skins
//   - Últimas operaciones
// ─────────────────────────────────────────────────────────────────────────────
import chalk from 'chalk';
import { resumenPortfolio }         from '../core/portfolio.js';
import { estadoRiesgo }             from '../core/riskManager.js';
import { resumenPrecios }           from '../core/priceEngine.js';
import { resumenDia, operacionesAbiertas, historialReciente } from './logger.js';
import { BOT }                      from '../config.js';

const { bgBlack, cyan, green, yellow, red, white, gray, bold, dim } = chalk;

let intervaloId = null;

// ── Renderizado ───────────────────────────────────────────────────────────

function limpiar() {
  process.stdout.write('\x1Bc');  // Clear terminal
}

function linea(char = '─', len = 60) {
  return gray(char.repeat(len));
}

function fila(label, valor, colorFn = white) {
  const pad = 22;
  return `  ${gray(label.padEnd(pad))} ${colorFn(valor)}`;
}

function formatearMs(ms) {
  if (!ms) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderDashboard() {
  limpiar();

  const ahora   = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  const modo    = BOT.mode === 'paper' ? yellow('◆ PAPER') : green('● LIVE');
  const portfolio = resumenPortfolio();
  const riesgo    = estadoRiesgo();
  const precios   = resumenPrecios();
  const diaRes    = resumenDia();
  const abiertas  = operacionesAbiertas();
  const recientes = historialReciente(5);

  // ── Header ─────────────────────────────────────────────────────────
  console.log();
  console.log(`  ${bold(cyan('CS2 ARB BOT'))} ${dim('v2.0')}   ${modo}   ${dim(ahora)}`);
  console.log(linea('═'));

  // ── Estado del bot ──────────────────────────────────────────────────
  const estadoBot = riesgo.pausado
    ? red(`⏸ PAUSADO — ${riesgo.motivoPausa} (${riesgo.tiempoPausadoMin}m)`)
    : green('▶ ACTIVO');

  console.log();
  console.log(`  ${bold('ESTADO')}    ${estadoBot}`);
  if (riesgo.fallosConsecutivos > 0) {
    console.log(`  ${yellow(`⚠ Fallos consecutivos: ${riesgo.fallosConsecutivos}`)}`);
  }

  // ── Capital ────────────────────────────────────────────────────────
  console.log();
  console.log(`  ${bold(cyan('CAPITAL'))}`);
  console.log(linea());
  const gHoySign  = (diaRes?.ganancia_hoy ?? 0) >= 0 ? '+' : '';
  const gTotSign  = portfolio.gananciaTotal >= 0 ? '+' : '';
  console.log(fila('Capital total',     `$${portfolio.capitalTotal.toFixed(2)}`,    green));
  console.log(fila('Disponible',        `$${portfolio.capitalDisponible.toFixed(2)}`, white));
  console.log(fila('En operaciones',    `$${portfolio.exposicion.toFixed(2)}`,       yellow));
  console.log(fila('Ganancia hoy',      `${gHoySign}$${(diaRes?.ganancia_hoy ?? 0).toFixed(3)}`, (diaRes?.ganancia_hoy ?? 0) >= 0 ? green : red));
  console.log(fila('Ganancia total',    `${gTotSign}$${portfolio.gananciaTotal.toFixed(3)}`,      portfolio.gananciaTotal >= 0 ? green : red));
  console.log(fila('Ventas hoy',        `${diaRes?.ventas_hoy ?? 0}`,               cyan));

  // ── Precios ────────────────────────────────────────────────────────
  console.log();
  console.log(`  ${bold(cyan('PRECIOS'))}`);
  console.log(linea());
  for (const p of precios) {
    const estado = p.activa ? '' : dim('(inactiva)');
    const spread = p.spread !== null
      ? (p.spread >= 12 ? green(`${p.spread.toFixed(1)}%`) : red(`${p.spread.toFixed(1)}%`))
      : gray('—');
    const steam  = p.steam  ? `$${p.steam.toFixed(2)}`  : gray('—');
    const cf     = p.csfloat ? `$${p.csfloat.toFixed(2)}` : gray('—');
    const edad   = p.edad_min !== null ? dim(` (${p.edad_min}m)`) : '';

    console.log(`  ${dim('•')} ${white(p.id.padEnd(18))} Steam: ${cyan(steam)}  CF: ${cyan(cf)}  Spread: ${spread} ${estado}${edad}`);
  }

  // ── Operaciones abiertas ───────────────────────────────────────────
  console.log();
  console.log(`  ${bold(cyan('POSICIONES ABIERTAS'))} ${dim(`(${abiertas.length})`)}`);
  console.log(linea());
  if (abiertas.length === 0) {
    console.log(dim('  Sin posiciones abiertas'));
  } else {
    for (const op of abiertas) {
      const tiempoAbierta = Date.now() - op.ts_compra;
      const estadoColor   = op.estado === 'listado_steam' ? yellow : cyan;
      console.log(
        `  ${dim('#' + op.id)}  ${white(op.skin_id.padEnd(20))}` +
        `  float: ${cyan(op.float_value.toFixed(5))}` +
        `  costo: ${green('$' + op.costo_total.toFixed(2))}` +
        `  estado: ${estadoColor(op.estado)}` +
        `  ${dim(formatearMs(tiempoAbierta))}`
      );
    }
  }

  // ── Últimas operaciones cerradas ────────────────────────────────────
  const vendidas = recientes.filter(op => op.estado === 'vendido');
  if (vendidas.length > 0) {
    console.log();
    console.log(`  ${bold(cyan('ÚLTIMAS VENTAS'))}`);
    console.log(linea());
    for (const op of vendidas) {
      const gananciaColor = (op.ganancia_usd ?? 0) >= 0 ? green : red;
      const signo = (op.ganancia_usd ?? 0) >= 0 ? '+' : '';
      console.log(
        `  ${dim('#' + op.id)}  ${white(op.skin_id.padEnd(20))}` +
        `  ${signo}$${(op.ganancia_usd ?? 0).toFixed(3)} (${signo}${(op.ganancia_pct ?? 0).toFixed(1)}%)` +
        `  ${dim(formatearMs(op.tiempo_venta_ms))}`
      );
    }
  }

  // ── Footer ─────────────────────────────────────────────────────────
  console.log();
  console.log(linea('─'));
  console.log(dim(`  Ctrl+C para detener el bot | Próxima actualización: 30s`));
  console.log();
}

// ── API pública ───────────────────────────────────────────────────────────

/** Inicia el dashboard con actualización automática cada N segundos. */
export function iniciarDashboard(intervalSegundos = 30) {
  renderDashboard();
  intervaloId = setInterval(renderDashboard, intervalSegundos * 1000);
  return intervaloId;
}

/** Detiene el dashboard. */
export function detenerDashboard() {
  if (intervaloId) {
    clearInterval(intervaloId);
    intervaloId = null;
  }
}

/** Renderiza el dashboard una vez (útil para debugging). */
export { renderDashboard };
