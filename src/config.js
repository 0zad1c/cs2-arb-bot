// ─────────────────────────────────────────────────────────────────────────────
// config.js — Configuración centralizada del bot
// Toda la lógica de negocio vive aquí. Para añadir una skin nueva,
// solo agrégala al array SKINS. No hace falta tocar ningún otro archivo.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';

// ── Fees de plataformas ────────────────────────────────────────────────────
export const FEES = {
  steam:   0.87,   // Steam cobra 13% al vendedor  → recibes 87% del precio listado
  csfloat: 0.98,   // CSFloat cobra 2% al comprador → pagas 2% extra sobre el precio
};

// ── Skins activas para arbitrage ───────────────────────────────────────────
// Cada skin puede tener múltiples "bands" (rangos de float) con distintos umbrales
export const SKINS = [
  {
    id:       'black_lotus_ft',
    nombre:   'M4A1-S | Black Lotus (Field-Tested)',
    marketName: 'M4A1-S | Black Lotus (Field-Tested)',
    appId:    730,
    activa:   true,
    fase:     1,
    bands: [
      {
        nombre:       'Rango bajo FT',
        floatMin:     0.15,
        floatMax:     0.20,
        maxCompraCF:  8.00,   // Precio máximo de compra en CSFloat (USD)
        minVentaSteam: 9.00,  // Precio mínimo aceptable en Steam Market (USD)
        prioridadCompra: 1,   // 1 = primera oportunidad
      },
    ],
  },
  {
    id:       'redline_ft',
    nombre:   'AK-47 | Redline (Field-Tested)',
    marketName: 'AK-47 | Redline (Field-Tested)',
    appId:    730,
    activa:   false,   // Fase 2 — activar cuando el capital supere $50
    fase:     2,
    bands: [
      {
        nombre:       'FT estándar',
        floatMin:     0.15,
        floatMax:     0.38,
        maxCompraCF:  36.00,
        minVentaSteam: 44.00,
        prioridadCompra: 1,
      },
    ],
  },
];

// ── Gestión de riesgo ──────────────────────────────────────────────────────
export const RIESGO = {
  // Pausa el bot si el spread entre plataformas cae por debajo de este %
  spreadMinPct:          12,

  // Pausa si Steam bajó más de este % en las últimas 24h
  caida24hMaxPct:         8,

  // Pausa tras N operaciones fallidas consecutivas
  maxFallosConsecutivos:  2,

  // Nunca exponer más de este % del capital en operaciones abiertas a la vez
  maxExposicionCapitalPct: 60,

  // Si el bot se pausa por riesgo, espera este tiempo antes de reanudar (ms)
  cooldownRiesgoBotMs:    30 * 60 * 1000,  // 30 minutos
};

// ── Estrategia de reinversión ─────────────────────────────────────────────
export const REINVERSION = {
  // Capital objetivo para empezar a retirar
  umbralRetiro:           100.00,

  // % a retirar cada vez que el capital supere el umbral en +40%
  pctRetiro:              0.25,

  // % de ganancia sobre el umbral que dispara un retiro
  pctGananciaParaRetirar: 0.40,

  // Máximo de unidades simultáneas de la misma skin
  maxUnidadesSimultaneas:  3,
};

// ── Precios: frecuencia de actualización ──────────────────────────────────
export const PRECIOS = {
  // Cada cuántos ms actualizar precios de Steam Market
  actualizarCadaMs: 30 * 60 * 1000,   // 30 minutos

  // Cuántas ventas recientes mirar para calcular el precio actual
  ventasRecentesN:  20,

  // % de descuento sobre el precio de mercado para fijar el precio de venta
  // (listar ligeramente por debajo para vender más rápido)
  descuentoListadoPct: 0.02,
};

// ── CSFloat API ─────────────────────────────────────────────────────────────
export const CSFLOAT = {
  baseUrl:    'https://csfloat.com/api/v1',
  wsUrl:      'wss://csfloat.com/api/v1/socket',
  apiKey:     process.env.CSFLOAT_API_KEY || '',
  // Delay entre peticiones HTTP a CSFloat para no superar rate limits
  rateLimitMs: 1200,
};

// ── Steam API ───────────────────────────────────────────────────────────────
export const STEAM = {
  apiKey:         process.env.STEAM_API_KEY || '',
  sessionId:      process.env.STEAM_SESSION_ID || '',
  loginSecure:    process.env.STEAM_LOGIN_SECURE || '',
  parental:       process.env.STEAM_PARENTAL || '',
  marketBaseUrl:  'https://steamcommunity.com/market',
  rateLimitMs:    3000,   // Steam es muy agresivo con rate limits
};

// ── Telegram ────────────────────────────────────────────────────────────────
export const TELEGRAM = {
  token:  process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID   || '',
};

// ── General ────────────────────────────────────────────────────────────────
export const BOT = {
  mode:          process.env.BOT_MODE || 'paper',   // 'paper' | 'live'
  capitalInicial: parseFloat(process.env.CAPITAL_INICIAL || '21'),
  dbPath:         process.env.DB_PATH || './data/operaciones.db',
  logLevel:       process.env.LOG_LEVEL || 'info',
  // Intervalo del reporte diario (ms desde medianoche)
  reporteDiarioHora: 8,   // 8:00 AM
};

// ── Validación al inicio ────────────────────────────────────────────────────
export function validarConfig() {
  const errores = [];
  if (!CSFLOAT.apiKey)   errores.push('CSFLOAT_API_KEY no configurado');
  if (!STEAM.apiKey)     errores.push('STEAM_API_KEY no configurado');
  if (BOT.mode === 'live') {
    if (!STEAM.sessionId)   errores.push('STEAM_SESSION_ID requerido en modo live');
    if (!STEAM.loginSecure) errores.push('STEAM_LOGIN_SECURE requerido en modo live');
  }
  return errores;
}
