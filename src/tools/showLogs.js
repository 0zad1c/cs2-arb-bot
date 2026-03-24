#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/showLogs.js — Herramienta CLI para consultar la base de datos
//
// Uso:
//   node src/tools/showLogs.js              → Resumen general
//   node src/tools/showLogs.js ops          → Últimas 20 operaciones
//   node src/tools/showLogs.js abiertas     → Posiciones abiertas
//   node src/tools/showLogs.js eventos      → Últimos 30 eventos del sistema
//   node src/tools/showLogs.js ganancia     → Ganancia total y por día
//   node src/tools/showLogs.js precios      → Últimos precios registrados
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { DatabaseSync as Database } from 'node:sqlite';
import chalk    from 'chalk';
import { BOT }  from '../config.js';
import fs       from 'fs';

if (!fs.existsSync(BOT.dbPath)) {
  console.error(chalk.red(`\nBase de datos no encontrada: ${BOT.dbPath}`));
  console.error(chalk.dim('¿El bot ha corrido al menos una vez?\n'));
  process.exit(1);
}

const db  = new Database(BOT.dbPath, { readOnly: true });
const cmd = process.argv[2] || 'resumen';

const { bgBlack, cyan, green, yellow, red, white, gray, bold, dim } = chalk;

function tabla(filas, cols) {
  if (!filas.length) { console.log(dim('  (sin datos)')); return; }
  const anchos = cols.map(c => Math.max(c.label.length, ...filas.map(f => String(f[c.key] ?? '—').length)));
  const sep    = anchos.map(w => '─'.repeat(w + 2)).join('┼');

  // Header
  console.log('  ┌' + anchos.map(w => '─'.repeat(w + 2)).join('┬') + '┐');
  console.log('  │' + cols.map((c, i) => ' ' + bold(cyan(c.label.padEnd(anchos[i]))) + ' ').join('│') + '│');
  console.log('  ├' + sep + '┤');

  // Filas
  for (const fila of filas) {
    console.log('  │' + cols.map((c, i) => {
      let val = String(fila[c.key] ?? '—');
      const colorFn = c.color ? c.color(fila[c.key], fila) : white;
      return ' ' + colorFn(val.padEnd(anchos[i])) + ' ';
    }).join('│') + '│');
  }
  console.log('  └' + anchos.map(w => '─'.repeat(w + 2)).join('┴') + '┘');
}

function fmt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }).slice(0, 16);
}

function fmtMs(ms) {
  if (!ms) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Comandos ──────────────────────────────────────────────────────────────

if (cmd === 'resumen') {
  console.log('\n' + bold(cyan('═══ CS2 ARB BOT — RESUMEN ═══')) + '\n');

  const total = db.prepare(`
    SELECT COUNT(*) as n,
           ROUND(SUM(CASE WHEN estado='vendido' THEN ganancia_usd ELSE 0 END), 4) as ganancia,
           COUNT(CASE WHEN estado='vendido' THEN 1 END) as vendidas,
           COUNT(CASE WHEN estado IN ('comprado','listado_steam') THEN 1 END) as abiertas
    FROM operaciones
  `).get();

  const hoy = db.prepare(`
    SELECT COUNT(CASE WHEN estado='vendido' THEN 1 END) as ventas_hoy,
           ROUND(SUM(CASE WHEN estado='vendido' THEN ganancia_usd ELSE 0 END), 4) as ganancia_hoy
    FROM operaciones
    WHERE created_at >= strftime('%s','now','start of day') * 1000
  `).get();

  console.log(white(`  Ganancia total:   `) + (total.ganancia >= 0 ? green : red)(`$${(total.ganancia || 0).toFixed(4)}`));
  console.log(white(`  Ops totales:      `) + white(total.n));
  console.log(white(`  Ops vendidas:     `) + white(total.vendidas));
  console.log(white(`  Posic. abiertas:  `) + yellow(total.abiertas));
  console.log(white(`  Ganancia hoy:     `) + (hoy.ganancia_hoy >= 0 ? green : red)(`$${(hoy.ganancia_hoy || 0).toFixed(4)}`));
  console.log(white(`  Ventas hoy:       `) + white(hoy.ventas_hoy || 0));

  const ultimo = db.prepare(`SELECT * FROM eventos ORDER BY ts DESC LIMIT 1`).get();
  if (ultimo) {
    console.log(white(`  Último evento:    `) + dim(`${ultimo.tipo} — ${fmt(ultimo.ts)}`));
  }
  console.log();
}

else if (cmd === 'ops') {
  console.log('\n' + bold(cyan('═══ ÚLTIMAS 20 OPERACIONES ═══')) + '\n');
  const ops = db.prepare(`SELECT * FROM operaciones ORDER BY created_at DESC LIMIT 20`).all()
    .map(o => ({
      id:      o.id,
      skin:    o.skin_id,
      float:   o.float_value?.toFixed(5),
      compra:  `$${o.precio_compra_cf?.toFixed(2)}`,
      venta:   o.precio_venta_steam ? `$${o.precio_venta_steam.toFixed(2)}` : '—',
      ganancia: o.ganancia_usd != null ? `${o.ganancia_usd >= 0 ? '+' : ''}$${o.ganancia_usd.toFixed(3)}` : '—',
      pct:     o.ganancia_pct != null ? `${o.ganancia_pct.toFixed(1)}%` : '—',
      tiempo:  fmtMs(o.tiempo_venta_ms),
      estado:  o.estado,
      modo:    o.modo,
    }));

  tabla(ops, [
    { key: 'id',       label: '#',        color: () => dim },
    { key: 'skin',     label: 'Skin',     color: () => white },
    { key: 'float',    label: 'Float',    color: () => cyan },
    { key: 'compra',   label: 'Compra',   color: () => white },
    { key: 'venta',    label: 'Venta',    color: () => white },
    { key: 'ganancia', label: 'Ganancia', color: (v) => (v && v.startsWith('+') ? green : red) },
    { key: 'pct',      label: '%',        color: () => yellow },
    { key: 'tiempo',   label: 'Tiempo',   color: () => dim },
    { key: 'estado',   label: 'Estado',   color: (v) => v === 'vendido' ? green : v === 'comprado' ? yellow : white },
    { key: 'modo',     label: 'Modo',     color: (v) => v === 'paper' ? yellow : green },
  ]);
  console.log();
}

else if (cmd === 'abiertas') {
  console.log('\n' + bold(cyan('═══ POSICIONES ABIERTAS ═══')) + '\n');
  const ops = db.prepare(`
    SELECT *, (unixepoch() * 1000 - ts_compra) as tiempo_abierta_ms
    FROM operaciones WHERE estado IN ('comprado','listado_steam')
    ORDER BY ts_compra ASC
  `).all().map(o => ({
    id:       o.id,
    skin:     o.skin_id,
    float:    o.float_value?.toFixed(5),
    costo:    `$${o.costo_total?.toFixed(2)}`,
    estado:   o.estado,
    abierta:  fmtMs(o.tiempo_abierta_ms),
    comprado: fmt(o.ts_compra),
    modo:     o.modo,
  }));

  if (!ops.length) { console.log(dim('  Sin posiciones abiertas\n')); process.exit(0); }

  tabla(ops, [
    { key: 'id',       label: '#' },
    { key: 'skin',     label: 'Skin',    color: () => white },
    { key: 'float',    label: 'Float',   color: () => cyan },
    { key: 'costo',    label: 'Costo',   color: () => yellow },
    { key: 'estado',   label: 'Estado',  color: (v) => v === 'listado_steam' ? green : cyan },
    { key: 'abierta',  label: 'Tiempo',  color: () => dim },
    { key: 'comprado', label: 'Comprado' },
    { key: 'modo',     label: 'Modo',    color: (v) => v === 'paper' ? yellow : green },
  ]);
  console.log();
}

else if (cmd === 'eventos') {
  console.log('\n' + bold(cyan('═══ ÚLTIMOS 30 EVENTOS ═══')) + '\n');
  const evs = db.prepare(`SELECT * FROM eventos ORDER BY ts DESC LIMIT 30`).all()
    .map(e => ({ ts: fmt(e.ts), tipo: e.tipo, msg: (e.mensaje || '').slice(0, 60) }));

  tabla(evs, [
    { key: 'ts',   label: 'Timestamp', color: () => dim },
    { key: 'tipo', label: 'Tipo',      color: (v) => v?.includes('error') || v?.includes('pausado') ? red : v?.includes('ok') || v?.includes('venta') || v?.includes('reanudado') ? green : cyan },
    { key: 'msg',  label: 'Mensaje',   color: () => white },
  ]);
  console.log();
}

else if (cmd === 'ganancia') {
  console.log('\n' + bold(cyan('═══ GANANCIA POR DÍA ═══')) + '\n');
  const dias = db.prepare(`
    SELECT
      date(ts_venta / 1000, 'unixepoch') as dia,
      COUNT(*) as ventas,
      ROUND(SUM(ganancia_usd), 4) as ganancia,
      ROUND(AVG(ganancia_pct), 2) as pct_promedio,
      ROUND(MIN(ganancia_pct), 2) as pct_min,
      ROUND(MAX(ganancia_pct), 2) as pct_max
    FROM operaciones
    WHERE estado = 'vendido' AND ts_venta IS NOT NULL
    GROUP BY dia
    ORDER BY dia DESC
    LIMIT 30
  `).all();

  tabla(dias, [
    { key: 'dia',          label: 'Día' },
    { key: 'ventas',       label: 'Ventas',   color: () => cyan },
    { key: 'ganancia',     label: 'Ganancia', color: (v) => (v >= 0 ? green : red) },
    { key: 'pct_promedio', label: 'Spread%',  color: () => yellow },
    { key: 'pct_min',      label: 'Min%',     color: () => dim },
    { key: 'pct_max',      label: 'Max%',     color: () => dim },
  ]);
  console.log();
}

else if (cmd === 'precios') {
  console.log('\n' + bold(cyan('═══ ÚLTIMOS PRECIOS REGISTRADOS ═══')) + '\n');
  const precios = db.prepare(`
    SELECT p.skin_id, p.plataforma, p.precio, p.precio_min, p.volumen_24h, p.ts
    FROM precios p
    INNER JOIN (
      SELECT skin_id, plataforma, MAX(ts) as max_ts
      FROM precios GROUP BY skin_id, plataforma
    ) latest ON p.skin_id = latest.skin_id AND p.plataforma = latest.plataforma AND p.ts = latest.max_ts
    ORDER BY p.skin_id, p.plataforma
  `).all().map(p => ({
    skin:      p.skin_id,
    platform:  p.plataforma,
    precio:    `$${p.precio?.toFixed(2)}`,
    min:       p.precio_min ? `$${p.precio_min.toFixed(2)}` : '—',
    vol:       p.volumen_24h ?? '—',
    ts:        fmt(p.ts),
  }));

  tabla(precios, [
    { key: 'skin',     label: 'Skin' },
    { key: 'platform', label: 'Plataforma', color: (v) => v === 'steam' ? blue : cyan },
    { key: 'precio',   label: 'Precio',     color: () => green },
    { key: 'min',      label: 'Mínimo',     color: () => white },
    { key: 'vol',      label: 'Volumen 24h',color: () => dim },
    { key: 'ts',       label: 'Actualizado',color: () => dim },
  ]);
  console.log();
}

else {
  console.log(yellow('\nComandos disponibles:'));
  console.log(dim('  node src/tools/showLogs.js resumen   ← Resumen general'));
  console.log(dim('  node src/tools/showLogs.js ops       ← Últimas 20 operaciones'));
  console.log(dim('  node src/tools/showLogs.js abiertas  ← Posiciones abiertas'));
  console.log(dim('  node src/tools/showLogs.js eventos   ← Últimos 30 eventos'));
  console.log(dim('  node src/tools/showLogs.js ganancia  ← Ganancia por día'));
  console.log(dim('  node src/tools/showLogs.js precios   ← Últimos precios\n'));
}

db.close();
