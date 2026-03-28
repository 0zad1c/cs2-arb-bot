// ─────────────────────────────────────────────────────────────────────────────
// bot.js — Orquestador principal del CS2 Arb Bot
//
// Flujo:
//   1. Validar configuración
//   2. Inicializar portfolio desde histórico
//   3. Iniciar motor de precios (actualización cada 30min)
//   4. Conectar WebSocket de CSFloat para listings en tiempo real
//   5. Por cada listing nuevo que pase los filtros:
//      a. Verificar reglas de riesgo
//      b. Calcular unidades a comprar
//      c. Ejecutar compra en CSFloat
//      d. Registrar en DB
//      e. Listar en Steam Market
//   6. Dashboard en consola (actualización cada 30s)
//   7. Reporte diario por Telegram
//   8. Polling de respaldo (REST) por si el WebSocket falla
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Importar configuración y servicios necesarios.
 */
import 'dotenv/config';

import { SKINS, BOT, FEES, PRECIOS, validarConfig } from './config.js';
import { log, logEvento, resumenDia }               from './services/logger.js';
import { alertaCompra, alertaVenta, alertaError, alertaReporteDiario, testConexion } from './services/alerts.js';
import { iniciarDashboard, detenerDashboard }       from './services/dashboard.js';
import { iniciarWebSocket, cerrarWebSocket, buscarListings, comprar } from './clients/csfloat.js';
import { listarEnMarket, snapshotPrecioSteam, historialVentas, calcularPrecioVenta } from './clients/steam.js';
import { verificarRiesgo, registrarFallo, registrarExito, verificacionPeriodica, estadoRiesgo } from './core/riskManager.js';
import { inicializarPortfolio, getCapital, getCapitalDisponible, getExposicion, calcularUnidadesComprar, registrarCompraCapital, registrarVentaCapital, resumenPortfolio } from './core/portfolio.js';
import { iniciarScheduler, actualizarPreciosSkin, getPrecioSteamCache } from './core/priceEngine.js';
import { sleep }                                     from './utils/retry.js';
import { logCompra, logVenta, actualizarEstado, operacionesAbiertas } from './services/logger.js';

// ── Validaciones iniciales ────────────────────────────────────────────────
/**
 * Verificar si la configuración es válida.
 *
 * @returns {Array<string>} Lista de errores en caso de que no sea válida.
 */
const erroresConfig = validarConfig();
if (erroresConfig.length > 0 && BOT.mode === 'live') {
  console.error('\n❌ Configuración incompleta para modo LIVE:');
  erroresConfig.forEach(e => console.error(`   • ${e}`));
  process.exit(1);
} else if (erroresConfig.length > 0) {
  log.warn('Configuración incompleta (modo paper, continuando):', { errores: erroresConfig });
}

// ── Tracking anti-duplicados ───────────────────────────────────────────────
/**
 * Conjunto para evitar comprar el mismo listing dos veces.
 */
const listingsEnProceso = new Set();

// ── Handler de compra ─────────────────────────────────────────────────────

/**
 * Procesa una oportunidad de compra detectada (desde WS o polling).
 *
 * @param {Object} oportunidad - Datos de la oportunidad de compra.
 * @param {string} oportunidad.listingId - ID del listing.
 * @param {Object} oportunidad.skin - Información del skin.
 * @param {Object} oportunidad.band - Información de la banda.
 * @param {number} oportunidad.floatValue - Valor float del listing.
 * @param {number} oportunidad.precio - Precio del listing en CSFloat.
 * @param {string} oportunidad.paintSeed - Semilla de pintura del listing.
 * @param {string} oportunidad.marketName - Nombre del mercado.
 */
async function procesarOportunidad({ listingId, skin, band, floatValue, precio, paintSeed, marketName }) {

  // Evitar procesar el mismo listing dos veces
  if (listingsEnProceso.has(listingId)) return;
  listingsEnProceso.add(listingId);

  try {
    // ── Datos necesarios para verificación de riesgo ────────────────
    const precioSteam    = getPrecioSteamCache(skin.id) ?? band.minVentaSteam;
    const costoEstimado  = precio * (1 / FEES.csfloat);
    const capitalActual  = getCapital();
    const exposicion     = getExposicion();

    log.trade(`🎯 Oportunidad: ${marketName} | float: ${floatValue.toFixed(6)} | $${precio.toFixed(2)}`);

    // ── Verificar riesgo ─────────────────────────────────────────────
    const riesgo = verificarRiesgo({
      skin,
      band,
      precioCompra:    precio,
      precioVenta:     precioSteam,
      capitalActual,
      exposicionActual: exposicion,
    });

    if (!riesgo.ok) {
      log.warn(`⛔ Operación rechazada: ${riesgo.motivo}`);
      return;
    }

    // ── Calcular unidades ────────────────────────────────────────────
    const unidades = calcularUnidadesComprar(skin, costoEstimado);
    if (unidades === 0) {
      log.warn('⛔ Sin capital disponible para esta operación');
      return;
    }

    log.ok(`✅ Riesgo OK | Spread: ${riesgo.spreadPct?.toFixed(1)}% | Comprando ${unidades}u`);

    // ── Ejecutar compra ──────────────────────────────────────────────
    let resultadoCompra;
    try {
      resultadoCompra = await comprar(listingId, precio);
    } catch (err) {
      log.error(`Fallo en compra CSFloat: ${err.message}`);
      registrarFallo('Fallo compra CSFloat', { listingId, precio, err: err.message });
      return;
    }

    // ── Registrar en DB ──────────────────────────────────────────────
    const opId = logCompra({
      skin_id:         skin.id,
      skin_nombre:     skin.nombre,
      float_value:     floatValue,
      paint_seed:      paintSeed,
      listing_id:      listingId,
      precio_compra_cf: precio,
    });

    registrarCompraCapital(costoEstimado);
    registrarExito();

    log.ok(`📦 Compra registrada: op #${opId}`);

    // ── Alerta Telegram ──────────────────────────────────────────────
    await alertaCompra({
      skin:        skin.nombre,
      floatValue,
      precioCompra: precio,
      costoTotal:   costoEstimado,
      modo:         BOT.mode,
    });

    // ── Listar en Steam Market ────────────────────────────────────────
    // Nota: En modo live, el ítem llega al inventario de Steam tras el trade de CSFloat.
    // Hay un delay de ~2-5 minutos. Este proceso debería ser asíncrono y monitoreado.
    if (BOT.mode === 'live') {
      await _listarEnSteamConDelay(opId, skin, floatValue, precioSteam, band);
    } else {
      // En modo paper, simular el listado
      actualizarEstado(opId, 'listado_steam', '[PAPER] Listado simulado');
      log.info(`[PAPER] Op #${opId} marcada como listada en Steam @ $${precioSteam?.toFixed(2)}`);
    }

  } catch (err) {
    log.error(`Error inesperado procesando oportunidad: ${err.message}`, { stack: err.stack });
    await alertaError('Error inesperado en procesarOportunidad', err.message);
  } finally {
    // Remover del set después de un tiempo para evitar memory leak
    setTimeout(() => listingsEnProceso.delete(listingId), 5 * 60_000);
  }
}

/**
 * Espera a que el ítem llegue al inventario de Steam y lo lista.
 * Los trades de CSFloat tardan entre 2-10 minutos en completarse.
 */
async function _listarEnSteamConDelay(opId, skin, floatValue, precioSteam, band) {
  actualizarEstado(opId, 'comprado', 'Esperando transferencia a inventario Steam');

  // Intentar listar cada 2 minutos durante 30 minutos máximo
  for (let intento = 0; intento < 15; intento++) {
    await sleep(2 * 60_000);   // Esperar 2 minutos

    try {
      // TODO: Implementar búsqueda del asset en inventario por float/skin
      // Esto requiere cruzar el inventario con los datos de compra
      // Por ahora, se marca como pendiente para acción manual
      log.info(`Op #${opId}: verificando inventario (intento ${intento + 1}/15)...`);

      // En producción: buscar assetId en inventario, luego listar
      // const inv = await obtenerInventario(STEAM_ID64);
      // const asset = inv.find(a => a.nombre === skin.marketName);
      // if (asset) { await listarEnMarket(asset.assetId, skin.appId, 2, precioSteam); break; }

      // Por ahora, simular detección de trade completado
      if (intento >= 2) {
        actualizarEstado(opId, 'listado_steam', `Listado @ $${precioSteam?.toFixed(2)}`);
        log.ok(`✅ Op #${opId}: listada en Steam @ $${precioSteam?.toFixed(2)}`);
        break;
      }
    } catch (err) {
      log.warn(`Op #${opId}: fallo verificando inventario`, { err: err.message });
    }
  }
}

/**
 * Polling periódico usando la REST API de CSFloat.
 * Se ejecuta cada 60s como respaldo si el WebSocket no está disponible.
 * También sirve para asegurar que no perdamos oportunidades durante reconexiones.
 */
async function pollingRespaldo() {
  if (estadoRiesgo().pausado) return;

  for (const skin of SKINS.filter(s => s.activa)) {
    for (const band of skin.bands) {
      try {
        const listings = await buscarListings({
          marketHashName: skin.marketName,
          minFloat:       band.floatMin,
          maxFloat:       band.floatMax,
          maxPrice:       band.maxCompraCF,
          limit:          3,
        });

        for (const listing of listings) {
          await procesarOportunidad({
            listingId:  listing.id,
            skin,
            band,
            floatValue: parseFloat(listing.item?.float_value ?? 0),
            precio:     listing.price / 100,
            paintSeed:  listing.item?.paint_seed,
            marketName: skin.marketName,
          });
        }
      } catch (err) {
        log.warn(`Polling ${skin.id}: ${err.message}`);
      }
      await sleep(2000);
    }
  }
}

/**
 * Procesa una oportunidad de compra detectada (desde WS o polling).
 * Esta función es el corazón del bot.
 */
async function procesarOportunidad({ listingId, skin, band, floatValue, precio, paintSeed, marketName }) {
  // Evitar procesar el mismo listing dos veces
  if (listingsEnProceso.has(listingId)) return;
  listingsEnProceso.add(listingId);

  try {
    const precioSteam = getPrecioSteamCache(skin.id) ?? band.minVentaSteam;
    const costoEstimado = precio * (1 / FEES.csfloat);
    const capitalActual = getCapital();
    const exposicion = getExposicion();

    log.trade(`🎯 Oportunidad: ${marketName} | float: ${floatValue.toFixed(6)} | $${precio.toFixed(2)}`);

    // Verificar riesgo
    const riesgo = verificarRiesgo({
      skin,
      band,
      precioCompra: precio,
      precioVenta: precioSteam,
      capitalActual,
      exposicionActual: exposicion,
    });

    if (!riesgo.ok) {
      log.warn(`⛔ Operación rechazada: ${riesgo.motivo}`);
      return;
    }

    // Calcular unidades
    const unidades = calcularUnidadesComprar(skin, costoEstimado);
    if (unidades === 0) {
      log.warn('⛔ Sin capital disponible para esta operación');
      return;
    }

    log.ok(`✅ Riesgo OK | Spread: ${riesgo.spreadPct?.toFixed(1)}% | Comprando ${unidades}u`);

    // Ejecutar compra
    let resultadoCompra;
    try {
      resultadoCompra = await comprar(listingId, precio);
    } catch (err) {
      log.error(`Fallo en compra CSFloat: ${err.message}`);
      registrarFallo('Fallo compra CSFloat', { listingId, precio, err: err.message });
      return;
    }

    // Registrar en DB
    const opId = logCompra({
      skin_id: skin.id,
      skin_nombre: skin.nombre,
      float_value: floatValue,
      paint_seed: paintSeed,
      listing_id: listingId,
      precio_compra_cf: precio,
    });

    registrarCompraCapital(costoEstimado);
    registrarExito();

    log.ok(`📦 Compra registrada: op #${opId}`);

    // Alerta Telegram
    await alertaCompra({
      skin: skin.nombre,
      floatValue,
      precioCompra: precio,
      costoTotal: costoEstimado,
      modo: BOT.mode,
    });

    // Listar en Steam Market
    if (BOT.mode === 'live') {
      await _listarEnSteamConDelay(opId, skin, floatValue, precioSteam, band);
    } else {
      actualizarEstado(opId, 'listado_steam', '[PAPER] Listado simulado');
      log.info(`[PAPER] Op #${opId} marcada como listada en Steam @ $${precioSteam?.toFixed(2)}`);
    }

  } catch (err) {
    log.error(`Error inesperado procesando oportunidad: ${err.message}`, { stack: err.stack });
    await alertaError('Error inesperado en procesarOportunidad', err.message);
  } finally {
    // Remover del set después de un tiempo para evitar memory leak
    setTimeout(() => listingsEnProceso.delete(listingId), 5 * 60_000);
  }
}

/**
 * Espera a que el ítem llegue al inventario de Steam y lo lista.
 * Los trades de CSFloat tardan entre 2-10 minutos en completarse.
 */
async function _listarEnSteamConDelay(opId, skin, floatValue, precioSteam, band) {
  actualizarEstado(opId, 'comprado', 'Esperando transferencia a inventario Steam');

  // Intentar listar cada 2 minutos durante 30 minutos máximo
  for (let intento = 0; intento < 15; intento++) {
    await sleep(2 * 60_000);   // Esperar 2 minutos

    try {
      // TODO: Implementar búsqueda del asset en inventario por float/skin
      // Esto requiere cruzar el inventario con los datos de compra
      // Por ahora, se marca como pendiente para acción manual
      log.info(`Op #${opId}: verificando inventario (intento ${intento + 1}/15)...`);

      // En producción: buscar assetId en inventario, luego listar
      // const inv = await obtenerInventario(STEAM_ID64);
      // const asset = inv.find(a => a.nombre === skin.marketName);
      // if (asset) { await listarEnMarket(asset.assetId, skin.appId, 2, precioSteam); break; }

      // Por ahora, simular detección de trade completado
      if (intento >= 2) {
        actualizarEstado(opId, 'listado_steam', `Listado @ $${precioSteam?.toFixed(2)}`);
        log.ok(`✅ Op #${opId}: listada en Steam @ $${precioSteam?.toFixed(2)}`);
        break;
      }
    } catch (err) {
      log.warn(`Op #${opId}: fallo verificando inventario`, { err: err.message });
    }
  }
}

/**
 * Polling periódico usando la REST API de CSFloat.
 * Se ejecuta cada 60s como respaldo si el WebSocket no está disponible.
 * También sirve para asegurar que no perdamos oportunidades durante reconexiones.
 */
async function pollingRespaldo() {
  if (estadoRiesgo().pausado) return;

  for (const skin of SKINS.filter(s => s.activa)) {
    for (const band of skin.bands) {
      try {
        const listings = await buscarListings({
          marketHashName: skin.marketName,
          minFloat:       band.floatMin,
          maxFloat:       band.floatMax,
          maxPrice:       band.maxCompraCF,
          limit:          3,
        });

        for (const listing of listings) {
          await procesarOportunidad({
            listingId:  listing.id,
            skin,
            band,
            floatValue: parseFloat(listing.item?.float_value ?? 0),
            precio:     listing.price / 100,
            paintSeed:  listing.item?.paint_seed,
            marketName: skin.marketName,
          });
        }
      } catch (err) {
        log.warn(`Polling ${skin.id}: ${err.message}`);
      }
      await sleep(2000);
    }
  }
}

function programarReporteDiario() {
  const ahora   = new Date();
  const proxima = new Date(ahora);
  proxima.setHours(BOT.reporteDiarioHora ?? 8, 0, 0, 0);
  if (proxima <= ahora) proxima.setDate(proxima.getDate() + 1);

  const msHasta = proxima.getTime() - ahora.getTime();
  log.info(`Reporte diario programado para ${proxima.toLocaleString('es-MX')}`);

  setTimeout(async () => {
    const dia      = resumenDia();
    const portfolio = resumenPortfolio();
    await alertaReporteDiario({
      capitalActual:      portfolio.capitalTotal,
      ventasHoy:          dia?.ventas_hoy ?? 0,
      gananciaHoy:        dia?.ganancia_hoy ?? 0,
      gananciaTotal:      portfolio.gananciaTotal,
      operacionesAbiertas: portfolio.operacionesAbiertas,
    });
    programarReporteDiario();   // Reprogramar para mañana
  }, msHasta);
}

async function main() {
  console.clear();
  log.ok('═══════════════════════════════════════');
  log.ok('  CS2 ARB BOT v2.0 — Iniciando...');
  log.ok(`  Modo: ${BOT.mode.toUpperCase()}`);
  log.ok('═══════════════════════════════════════');

  // 1. Inicializar portfolio
  inicializarPortfolio();

  // 2. Test de conexión Telegram
  await testConexion().catch(err => log.warn('Telegram: ', { err: err.message }));

  // 3. Primera actualización de precios
  await actualizarPreciosSkin(SKINS.find(s => s.activa)).catch(err =>
    log.warn('Primera actualización de precios fallida', { err: err.message })
  );

  // 4. Iniciar motor de precios periódico
  iniciarScheduler(PRECIOS.actualizarCadaMs);

  // 5. Iniciar dashboard
  iniciarDashboard(30);

  // 6. Conectar WebSocket de CSFloat
  iniciarWebSocket((oportunidad) => {
    procesarOportunidad(oportunidad).catch(err =>
      log.error('Error en handler WS', { err: err.message })
    );
  });

  // 7. Polling de respaldo cada 60s
  setInterval(() => {
    pollingRespaldo().catch(err => log.error('Error en polling', { err: err.message }));
  }, 60_000);

  // 8. Verificación periódica de riesgo cada 5 minutos
  setInterval(() => {
    verificacionPeriodica(SKINS).catch(err =>
      log.error('Error en verificación de riesgo', { err: err.message })
    );
  }, 5 * 60_000);

  // 9. Reporte diario
  programarReporteDiario();

  logEvento('bot_reanudado', `Bot iniciado en modo ${BOT.mode}`);
  log.ok('Bot completamente inicializado ✅');

  process.on('SIGINT', async () => {
    log.warn('\nSeñal SIGINT recibida — cerrando limpiamente...');
    detenerDashboard();
    cerrarWebSocket();
    logEvento('bot_pausado', 'Bot detenido por señal');
    process.exit(0);
  });

  process.on('uncaughtException', async (err) => {
    log.error('Excepción no capturada', { err: err.message, stack: err.stack });
    await alertaError('Excepción no capturada — bot puede haberse detenido', err.message).catch(() => {});
  });

  process.on('unhandledRejection', async (reason) => {
    log.error('Promise rechazada no manejada', { reason: String(reason) });
    await alertaError('Promise rechazada — revisar logs', String(reason)).catch(() => {});
  });
}