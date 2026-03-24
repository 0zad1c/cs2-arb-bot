// ─────────────────────────────────────────────────────────────────────────────
// services/alerts.js — Sistema de alertas vía Telegram
//
// Requisitos:
//   1. Crear un bot con @BotFather → obtener token
//   2. Escribirle al bot → obtener chat_id con /getUpdates
//   3. Poner ambos en .env
//
// Funciona en modo "fire and forget" — los errores de Telegram no crashean el bot
// ─────────────────────────────────────────────────────────────────────────────
import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM, BOT } from '../config.js';
import { log }           from './logger.js';

let bot = null;
let alertasActivas = true;

// Inicializar solo si hay token configurado
function getBot() {
  if (bot) return bot;
  if (!TELEGRAM.token) return null;
  try {
    bot = new TelegramBot(TELEGRAM.token, { polling: false });
    return bot;
  } catch (err) {
    log.warn('Telegram: no se pudo inicializar el bot', { err: err.message });
    return null;
  }
}

async function enviar(mensaje) {
  if (!alertasActivas) return;
  const b = getBot();
  if (!b || !TELEGRAM.chatId) return;

  try {
    await b.sendMessage(TELEGRAM.chatId, mensaje, { parse_mode: 'HTML' });
  } catch (err) {
    // Silencio — no queremos que un fallo de Telegram detenga el bot
    log.warn('Telegram: fallo al enviar alerta', { err: err.message });
  }
}

// ── Tipos de alerta ────────────────────────────────────────────────────────

/**
 * Disparo cuando se detecta y ejecuta una compra en CSFloat.
 */
export async function alertaCompra({ skin, floatValue, precioCompra, costoTotal, modo }) {
  const modoTag = modo === 'paper' ? '🧻 <b>PAPER TRADE</b>' : '💰 <b>COMPRA REAL</b>';
  const msg = `
🎯 ${modoTag} — COMPRA EJECUTADA

🔫 Skin: <code>${skin}</code>
📊 Float: <code>${floatValue.toFixed(6)}</code>
💵 Precio CF: <b>$${precioCompra.toFixed(2)}</b>
💳 Costo total: <b>$${costoTotal.toFixed(2)}</b>

⏱ ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}
  `.trim();
  await enviar(msg);
  log.trade(`📱 Alerta compra enviada a Telegram`);
}

/**
 * Disparo cuando se confirma una venta en Steam.
 */
export async function alertaVenta({ skin, floatValue, precioVenta, gananciaUsd, gananciaPct, tiempoHoras }) {
  const emoji = gananciaUsd >= 0 ? '✅' : '❌';
  const msg = `
${emoji} VENTA COMPLETADA — Steam Market

🔫 Skin: <code>${skin}</code>
📊 Float: <code>${floatValue.toFixed(6)}</code>
💵 Precio venta: <b>$${precioVenta.toFixed(2)}</b>
📈 Ganancia: <b>$${gananciaUsd.toFixed(3)}</b> (<b>${gananciaPct.toFixed(1)}%</b>)
⏱ Tiempo: ${tiempoHoras.toFixed(1)}h

${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}
  `.trim();
  await enviar(msg);
  log.trade(`📱 Alerta venta enviada a Telegram`);
}

/**
 * Disparo cuando el bot se pausa por reglas de riesgo.
 */
export async function alertaPausa({ motivo, detalles, cooldownMin }) {
  const msg = `
⚠️ BOT PAUSADO — Gestión de riesgo activada

🔴 Motivo: <b>${motivo}</b>
📋 Detalles: ${detalles}
⏳ Cooldown: ${cooldownMin} minutos

El bot se reanudará automáticamente.
${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}
  `.trim();
  await enviar(msg);
  log.warn(`📱 Alerta pausa enviada a Telegram: ${motivo}`);
}

/**
 * Reporte diario de ganancias.
 */
export async function alertaReporteDiario({ capitalActual, ventasHoy, gananciaHoy, gananciaTotal, operacionesAbiertas }) {
  const signo = gananciaHoy >= 0 ? '+' : '';
  const msg = `
📊 REPORTE DIARIO — ${new Date().toLocaleDateString('es-MX')}

💼 Capital actual: <b>$${capitalActual.toFixed(2)}</b>
📈 Ganancia hoy:   <b>${signo}$${gananciaHoy.toFixed(3)}</b>
🏆 Ganancia total: <b>$${gananciaTotal.toFixed(3)}</b>

📦 Ventas hoy: ${ventasHoy}
🔓 Posiciones abiertas: ${operacionesAbiertas}

${BOT.mode === 'paper' ? '🧻 Modo PAPER — sin trades reales' : '🟢 Modo LIVE'}
  `.trim();
  await enviar(msg);
}

/**
 * Alerta cuando se acerca el umbral de retiro.
 */
export async function alertaRetiro({ capitalActual, umbral, pctRetiro }) {
  const aRetirar = capitalActual * pctRetiro;
  const msg = `
💸 UMBRAL DE RETIRO ALCANZADO

💼 Capital actual: <b>$${capitalActual.toFixed(2)}</b>
🎯 Umbral: <b>$${umbral.toFixed(2)}</b>
📤 Retiro sugerido (${(pctRetiro * 100).toFixed(0)}%): <b>$${aRetirar.toFixed(2)}</b>

Considera hacer un retiro manual desde Steam Wallet.
  `.trim();
  await enviar(msg);
}

/** Alerta de error crítico. */
export async function alertaError(mensaje, detalles = '') {
  const msg = `🚨 ERROR CRÍTICO\n\n${mensaje}\n${detalles}\n\n${new Date().toISOString()}`;
  await enviar(msg);
}

/** Desactivar/activar alertas temporalmente. */
export function setAlertasActivas(activo) {
  alertasActivas = activo;
}

/** Test rápido del canal de Telegram. */
export async function testConexion() {
  await enviar('✅ CS2 Arb Bot conectado y funcionando.');
  log.ok('Telegram: test de conexión enviado');
}
