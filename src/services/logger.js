// ─────────────────────────────────────────────────────────────────────────────
// services/logger.js — Registro de operaciones en SQLite + logs de consola
//
// USA EL MÓDULO NATIVO DE NODE.JS (node:sqlite) — disponible desde Node v22.5
// Sin dependencias externas. No necesita compilación.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import chalk  from 'chalk';
import fs     from 'fs';
import path   from 'path';
import { BOT } from '../config.js';

// Crear directorio data/ si no existe
const dbDir = path.dirname(BOT.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(BOT.dbPath);

// ── Pragmas para rendimiento ──────────────────────────────────────────────
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA synchronous  = NORMAL`);
db.exec(`PRAGMA foreign_keys = ON`);

// ── Esquema ───────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS operaciones (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    skin_id             TEXT    NOT NULL,
    skin_nombre         TEXT    NOT NULL,
    float_value         REAL    NOT NULL,
    paint_seed          INTEGER,
    csfloat_listing_id  TEXT,
    precio_compra_cf    REAL NOT NULL,
    fee_cf              REAL NOT NULL,
    costo_total         REAL NOT NULL,
    ts_compra           INTEGER NOT NULL,
    precio_venta_steam  REAL,
    precio_recibido     REAL,
    ts_venta            INTEGER,
    ganancia_usd        REAL,
    ganancia_pct        REAL,
    tiempo_venta_ms     INTEGER,
    estado              TEXT NOT NULL DEFAULT 'comprado',
    notas               TEXT,
    modo                TEXT NOT NULL DEFAULT 'paper',
    created_at          INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS precios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    skin_id     TEXT    NOT NULL,
    plataforma  TEXT    NOT NULL,
    precio      REAL    NOT NULL,
    precio_min  REAL,
    precio_max  REAL,
    volumen_24h INTEGER,
    ts          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS eventos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo       TEXT NOT NULL,
    mensaje    TEXT,
    datos_json TEXT,
    ts         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_operaciones_estado ON operaciones(estado);
  CREATE INDEX IF NOT EXISTS idx_operaciones_skin   ON operaciones(skin_id);
  CREATE INDEX IF NOT EXISTS idx_precios_skin       ON precios(skin_id, plataforma);
  CREATE INDEX IF NOT EXISTS idx_eventos_tipo       ON eventos(tipo);
`);

// ── Statements precompilados ──────────────────────────────────────────────
// node:sqlite usa $nombre para parámetros nombrados
const stmts = {
  insertarOperacion: db.prepare(`
    INSERT INTO operaciones
      (skin_id, skin_nombre, float_value, paint_seed, csfloat_listing_id,
       precio_compra_cf, fee_cf, costo_total, ts_compra, modo)
    VALUES
      ($skin_id, $skin_nombre, $float_value, $paint_seed, $csfloat_listing_id,
       $precio_compra_cf, $fee_cf, $costo_total, $ts_compra, $modo)
  `),

  actualizarVenta: db.prepare(`
    UPDATE operaciones SET
      precio_venta_steam = $precio_venta_steam,
      precio_recibido    = $precio_recibido,
      ts_venta           = $ts_venta,
      ganancia_usd       = $ganancia_usd,
      ganancia_pct       = $ganancia_pct,
      tiempo_venta_ms    = $ts_venta - ts_compra,
      estado             = 'vendido',
      notas              = $notas
    WHERE id = $id
  `),

  actualizarEstado: db.prepare(`
    UPDATE operaciones SET estado = $estado, notas = $notas WHERE id = $id
  `),

  insertarPrecio: db.prepare(`
    INSERT INTO precios (skin_id, plataforma, precio, precio_min, precio_max, volumen_24h, ts)
    VALUES ($skin_id, $plataforma, $precio, $precio_min, $precio_max, $volumen_24h, $ts)
  `),

  insertarEvento: db.prepare(`
    INSERT INTO eventos (tipo, mensaje, datos_json)
    VALUES ($tipo, $mensaje, $datos_json)
  `),

  resumenDia: db.prepare(`
    SELECT
      COUNT(CASE WHEN estado = 'vendido' THEN 1 END) AS ventas_hoy,
      ROUND(SUM(CASE WHEN estado = 'vendido' THEN ganancia_usd ELSE 0 END), 4) AS ganancia_hoy,
      COUNT(CASE WHEN estado IN ('comprado','listado_steam') THEN 1 END) AS abiertas
    FROM operaciones
    WHERE created_at >= $inicio_dia
  `),

  operacionesAbiertas: db.prepare(`
    SELECT * FROM operaciones
    WHERE estado IN ('comprado', 'listado_steam')
    ORDER BY ts_compra ASC
  `),

  historialReciente: db.prepare(`
    SELECT * FROM operaciones ORDER BY created_at DESC LIMIT $n
  `),

  precioReciente: db.prepare(`
    SELECT precio FROM precios
    WHERE skin_id = $skin_id AND plataforma = $plataforma
    ORDER BY ts DESC LIMIT 1
  `),

  precioCambio24h: db.prepare(`
    SELECT precio FROM precios
    WHERE skin_id = $skin_id AND plataforma = $plataforma
      AND ts >= $hace_24h
    ORDER BY ts ASC LIMIT 1
  `),

  getOperacion: db.prepare(`SELECT * FROM operaciones WHERE id = $id`),
};

// ── API pública ───────────────────────────────────────────────────────────

/** Registra una nueva compra en CSFloat. Retorna el id de la fila creada. */
export function logCompra(datos) {
  const feeCf  = datos.precio_compra_cf * 0.02;
  const result = stmts.insertarOperacion.run({
    $skin_id:            datos.skin_id,
    $skin_nombre:        datos.skin_nombre,
    $float_value:        datos.float_value,
    $paint_seed:         datos.paint_seed ?? null,
    $csfloat_listing_id: datos.listing_id ?? null,
    $precio_compra_cf:   datos.precio_compra_cf,
    $fee_cf:             feeCf,
    $costo_total:        datos.precio_compra_cf + feeCf,
    $ts_compra:          Date.now(),
    $modo:               BOT.mode,
  });
  logEvento(
    'compra_ejecutada',
    `Compra ${datos.skin_nombre} @ $${datos.precio_compra_cf} | float: ${datos.float_value}`,
    datos
  );
  return Number(result.lastInsertRowid);
}

/** Registra la venta completada en Steam. */
export function logVenta(id, datos) {
  const op = stmts.getOperacion.get({ $id: id });
  if (!op) throw new Error(`Operación ${id} no encontrada`);
  const ganancia = datos.precio_recibido - op.costo_total;
  stmts.actualizarVenta.run({
    $id:                 id,
    $precio_venta_steam: datos.precio_venta,
    $precio_recibido:    datos.precio_recibido,
    $ts_venta:           Date.now(),
    $ganancia_usd:       ganancia,
    $ganancia_pct:       (ganancia / op.costo_total) * 100,
    $notas:              datos.notas ?? null,
  });
  logEvento('venta_completada', `Venta ${op.skin_nombre} | Ganancia: $${ganancia.toFixed(3)}`, datos);
}

/** Actualiza el estado de una operación abierta. */
export function actualizarEstado(id, estado, notas = null) {
  stmts.actualizarEstado.run({ $id: id, $estado: estado, $notas: notas });
}

/** Guarda un snapshot de precio de una plataforma. */
export function logPrecio(datos) {
  stmts.insertarPrecio.run({
    $skin_id:     datos.skin_id,
    $plataforma:  datos.plataforma,
    $precio:      datos.precio,
    $precio_min:  datos.precio_min  ?? null,
    $precio_max:  datos.precio_max  ?? null,
    $volumen_24h: datos.volumen_24h ?? null,
    $ts:          Date.now(),
  });
}

/** Registra un evento del sistema. */
export function logEvento(tipo, mensaje, datos = null) {
  stmts.insertarEvento.run({
    $tipo:       tipo,
    $mensaje:    mensaje,
    $datos_json: datos ? JSON.stringify(datos) : null,
  });
}

/** Resumen del día actual. */
export function resumenDia() {
  const inicioDia = new Date();
  inicioDia.setHours(0, 0, 0, 0);
  return stmts.resumenDia.get({ $inicio_dia: inicioDia.getTime() });
}

/** Operaciones actualmente abiertas. */
export function operacionesAbiertas() {
  return stmts.operacionesAbiertas.all();
}

/** Retorna el último precio registrado de una skin en una plataforma. */
export function precioReciente(skin_id, plataforma) {
  const row = stmts.precioReciente.get({ $skin_id: skin_id, $plataforma: plataforma });
  return row?.precio ?? null;
}

/** Calcula la variación de precio en las últimas 24h. Retorna % (negativo = baja). */
export function cambioPrecio24h(skin_id, plataforma) {
  const hace24h = Date.now() - 24 * 60 * 60 * 1000;
  const antiguo = stmts.precioCambio24h.get({
    $skin_id: skin_id, $plataforma: plataforma, $hace_24h: hace24h,
  });
  const actual = precioReciente(skin_id, plataforma);
  if (!antiguo || !actual) return null;
  return ((actual - antiguo.precio) / antiguo.precio) * 100;
}

/** Historial reciente de operaciones. */
export function historialReciente(n = 10) {
  return stmts.historialReciente.all({ $n: n });
}

// ── Consola estructurada ──────────────────────────────────────────────────
const LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NUM = LEVELS[BOT.logLevel] ?? 1;

const prefijos = {
  debug: chalk.gray('[DEBUG]'),
  info:  chalk.cyan('[INFO] '),
  warn:  chalk.yellow('[WARN] '),
  error: chalk.red('[ERROR]'),
  ok:    chalk.green('[OK]   '),
  trade: chalk.magenta('[TRADE]'),
};

function timestamp() {
  return chalk.dim(new Date().toISOString().replace('T', ' ').slice(0, 19));
}

export const log = {
  debug: (msg, data) => { if (LEVEL_NUM <= 0) _print('debug', msg, data); },
  info:  (msg, data) => { if (LEVEL_NUM <= 1) _print('info',  msg, data); },
  warn:  (msg, data) => { if (LEVEL_NUM <= 2) _print('warn',  msg, data); },
  error: (msg, data) => { if (LEVEL_NUM <= 3) _print('error', msg, data); },
  ok:    (msg, data) => _print('ok',    msg, data),
  trade: (msg, data) => _print('trade', msg, data),
};

function _print(level, msg, data) {
  const base = `${timestamp()} ${prefijos[level]} ${msg}`;
  if (data) console.log(base, chalk.dim(JSON.stringify(data)));
  else      console.log(base);
}

export default db;
