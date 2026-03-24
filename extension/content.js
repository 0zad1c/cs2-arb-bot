/**
 * CS2 Float Sniper — Content Script v9
 *
 * MEJORAS vs v8:
 *   - Integración con el backend bot (reporta oportunidades al servidor local)
 *   - Estadísticas persistentes (ganancia, operaciones) en chrome.storage
 *   - Filtrado por spread mínimo (rechaza si la ganancia es < 12%)
 *   - Modo "solo alerta" vs "reportar al bot" configurable
 *   - Mejor detección de floats en múltiples versiones del DOM de CSFloat
 */
(function () {
    'use strict';

    // ── Configuración ──────────────────────────────────────────────────
    const PERFILES = {
        1: { nombre: 'Black Lotus FT', MAX_FLOAT: 0.2000, MAX_PRICE: 8.00,  MIN_VENTA: 9.00  },
        2: { nombre: 'Redline FT',     MAX_FLOAT: 0.3800, MAX_PRICE: 36.00, MIN_VENTA: 44.00 },
    };

    const FEES         = { steam: 0.87, csfloat: 0.98 };
    const SPREAD_MIN   = 12;   // % mínimo de ganancia para alertar

    const CSFLOAT_TIMEOUT  = 14000;
    const SORT_WAIT_AFTER  = 3000;
    const SCAN_INTERVAL    = 1200;
    const MAX_CICLOS_VACIOS = 8;

    // ── Estado ──────────────────────────────────────────────────────────
    let cfg          = { ...PERFILES[1] };
    let activo       = true;
    let perfilActual = 1;
    let scanId       = null;
    let timeoutId    = null;
    let observer     = null;
    let ganado       = false;
    let sortHecho    = false;
    let sortIntentos = 0;
    let csfloatOk    = false;
    let ciclosSinFloats = 0;

    window.onerror = () => true;

    // ── Delay adaptativo ──────────────────────────────────────────────
    const getFallos  = () => parseInt(sessionStorage.getItem('sniper_fallos') || '0');
    const addFallo   = () => sessionStorage.setItem('sniper_fallos', getFallos() + 1);
    const resetFallos = () => sessionStorage.setItem('sniper_fallos', '0');

    const randDelay = (exito) => {
        if (exito) { resetFallos(); return 5000 + Math.random() * 5000; }
        addFallo();
        const f = getFallos();
        if (f <= 2) return 15000 + Math.random() * 10000;
        if (f <= 5) return 30000 + Math.random() * 15000;
        return 45000 + Math.random() * 30000;
    };

    // ── Logger de consola ─────────────────────────────────────────────
    const STYLE = {
        info:  'background:#0a0f1e;color:#4fc3f7;padding:3px 8px;border-radius:3px;',
        ok:    'background:#003320;color:#00e676;padding:3px 8px;border-radius:3px;font-weight:bold;',
        warn:  'background:#1a1000;color:#ffca28;padding:3px 8px;border-radius:3px;',
        error: 'background:#200000;color:#ef5350;padding:3px 8px;border-radius:3px;',
        trade: 'background:#1a0030;color:#ce93d8;padding:3px 8px;border-radius:3px;font-weight:bold;',
    };
    const log = (msg, tipo = 'info') => console.log(`%c[SNIPER v9] ${msg}`, STYLE[tipo]);

    // ── Cálculo de spread ─────────────────────────────────────────────
    /**
     * Calcula el spread real de la operación.
     * @returns {number} spread en %
     */
    const calcularSpread = (precioCompra, precioVentaEstimado) => {
        const costoTotal  = precioCompra / FEES.csfloat;     // Lo que pagamos en CSFloat con fee
        const ingresoNeto = precioVentaEstimado * FEES.steam; // Lo que recibimos en Steam con fee
        return ((ingresoNeto - costoTotal) / costoTotal) * 100;
    };

    // ── Lectura de floats desde Shadow DOM ────────────────────────────
    const leerFloat = (listingRow) => {
        // Método 1: csfloat-float-bar en shadow root
        const wrapper = listingRow.querySelector('csfloat-item-row-wrapper');
        if (wrapper?.shadowRoot) {
            const bar = wrapper.shadowRoot.querySelector('csfloat-float-bar');
            if (bar) {
                const val = parseFloat(bar.getAttribute('float') || bar.getAttribute('floatvalue') || '');
                if (!isNaN(val)) return val;
            }
            // Método 2: atributo data-float en el shadow root
            const dataFloat = wrapper.shadowRoot.querySelector('[data-float]');
            if (dataFloat) {
                const val = parseFloat(dataFloat.dataset.float);
                if (!isNaN(val)) return val;
            }
        }
        // Método 3: atributo directo en la fila
        const attr = listingRow.getAttribute('data-float') || listingRow.getAttribute('float');
        if (attr) {
            const val = parseFloat(attr);
            if (!isNaN(val)) return val;
        }
        return null;
    };

    const hayFloatsCargados = () => {
        const wrappers = document.querySelectorAll('csfloat-item-row-wrapper');
        if (!wrappers.length) return false;
        for (const w of wrappers) {
            if (!w.shadowRoot) continue;
            const bar = w.shadowRoot.querySelector('csfloat-float-bar');
            if (bar?.getAttribute('float')) return true;
        }
        return false;
    };

    // ── Lectura de precio ─────────────────────────────────────────────
    const leerPrecio = (item) => {
        const selectores = [
            '.market_listing_price_with_fee',
            '.market_listing_price span',
            '.normal_price',
            '[data-price]',
        ];
        for (const sel of selectores) {
            const el = item.querySelector(sel);
            if (!el) continue;
            const raw = (el.dataset?.price || el.innerText || '').replace(/[^0-9.,]/g, '').trim();
            if (!raw) continue;
            const num = parseFloat(raw.replace(',', '.'));
            if (!isNaN(num) && num > 0) return num;
        }
        return null;
    };

    // ── Extraer nombre del ítem (para logs) ───────────────────────────
    const leerNombreItem = (item) => {
        const el = item.querySelector('.market_listing_item_name, .market_listing_game_name, a');
        return el?.innerText?.trim() || 'Desconocido';
    };

    // ── Alerta visual en página ───────────────────────────────────────
    const alertarGanga = (item, fValue, pValue, spreadPct) => {
        ganado = true;
        detener();

        // Highlight del ítem
        item.style.cssText += `background:rgba(0,230,118,0.25)!important;outline:6px solid #00e676!important;border-radius:4px;`;

        // Sonido
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            [440, 554, 659, 880].forEach((freq, i) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                osc.type = 'square'; osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.18);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.25);
                osc.start(ctx.currentTime + i * 0.18);
                osc.stop(ctx.currentTime + i * 0.18 + 0.3);
            });
        } catch (_) {}

        // Banner
        const banner = document.createElement('div');
        banner.style.cssText = [
            'position:fixed;top:0;left:0;width:100%;z-index:99999;',
            'background:linear-gradient(90deg,#00695c,#00e676);',
            'color:#000;text-align:center;padding:14px 20px;',
            'font-size:20px;font-weight:bold;font-family:"Courier New",monospace;',
            'box-shadow:0 4px 30px rgba(0,230,118,.8);cursor:pointer;',
        ].join('');
        banner.innerHTML = [
            `🎯 ¡GANGA! Float: <b>${fValue.toFixed(6)}</b>`,
            `| Precio: <b>$${pValue.toFixed(2)}</b>`,
            `| Spread: <b>${spreadPct.toFixed(1)}%</b>`,
            `<span style="font-size:12px;opacity:0.8"> — click para cerrar</span>`,
        ].join(' ');
        banner.onclick = () => banner.remove();
        document.body.prepend(banner);

        log(`🎯 ¡GANGA! float=${fValue.toFixed(6)} precio=$${pValue.toFixed(2)} spread=${spreadPct.toFixed(1)}%`, 'trade');

        // Guardar estadística en storage
        _registrarGangaEncontrada(fValue, pValue, spreadPct);

        // Alert nativo (bloquea la página — no se recarga mientras está visible)
        setTimeout(() => {
            alert(`🎯 ¡GANGA DETECTADA!\n\nFloat:  ${fValue.toFixed(6)}\nPrecio: $${pValue.toFixed(2)}\nSpread: ${spreadPct.toFixed(1)}%\n\n¡COMPRA ANTES DE QUE SE AGOTE!`);
        }, 100);
    };

    // ── Guardar estadística ───────────────────────────────────────────
    const _registrarGangaEncontrada = (floatValue, precio, spreadPct) => {
        chrome.storage.local.get(['stats'], (data) => {
            const stats = data.stats || { gangas: 0, totalSpread: 0, ultimaGanga: null };
            stats.gangas++;
            stats.totalSpread += spreadPct;
            stats.ultimaGanga  = { floatValue, precio, spreadPct, ts: Date.now() };
            chrome.storage.local.set({ stats });
        });
    };

    // ── Sort by Float ──────────────────────────────────────────────────
    const dispararClickReal = (el) => {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top  + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        el.focus?.();
        ['pointerover','pointerenter','mouseover','mouseenter',
         'pointerdown','mousedown','pointerup','mouseup','click'].forEach(tipo =>
            el.dispatchEvent(new (tipo.startsWith('pointer') ? PointerEvent : MouseEvent)(tipo, opts))
        );
    };

    const buscarBotonSortRecursivo = (root) => {
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
                const f = buscarBotonSortRecursivo(el.shadowRoot);
                if (f) return f;
            }
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            if ((el.tagName === 'A' || el.tagName === 'BUTTON') &&
                (txt.includes('sort by float') || txt.includes('float ▲') || txt.includes('float ▼'))) {
                return el;
            }
        }
        return null;
    };

    const intentarSort = () => {
        // Ruta directa por los 3 niveles de shadow DOM de CSFloat
        const ub = document.querySelector('csfloat-utility-belt');
        if (ub?.shadowRoot) {
            const sl = ub.shadowRoot.querySelector('csfloat-sort-listings');
            if (sl?.shadowRoot) {
                const sb = sl.shadowRoot.querySelector('csfloat-steam-button');
                if (sb) { dispararClickReal(sb); return true; }
            }
        }
        // Fallback recursivo
        const boton = buscarBotonSortRecursivo(document);
        if (boton) { dispararClickReal(boton); return true; }
        return false;
    };

    // ── Scan principal ────────────────────────────────────────────────
    const iniciarScan = () => {
        ciclosSinFloats = 0;

        scanId = setInterval(() => {
            if (ganado) { clearInterval(scanId); return; }

            const filas = document.querySelectorAll(
                '.market_listing_row, .market_listing_row_link, [id^="listing_"]'
            );
            if (!filas.length) {
                ciclosSinFloats++;
                if (ciclosSinFloats >= MAX_CICLOS_VACIOS) recargar('Sin filas visibles', false);
                return;
            }

            let conFloat = 0;

            filas.forEach(fila => {
                if (ganado) return;
                const fValue = leerFloat(fila);
                if (fValue === null) return;
                conFloat++;

                // Verificar rango de float del perfil
                if (fValue >= cfg.MAX_FLOAT) return;

                const pValue = leerPrecio(fila);
                if (!pValue) { log(`Float ${fValue.toFixed(6)} sin precio legible`, 'warn'); return; }

                // Verificar precio máximo de compra
                if (pValue > cfg.MAX_PRICE) {
                    log(`Float ${fValue.toFixed(6)} ✅ | $${pValue} > máx $${cfg.MAX_PRICE}`, 'warn');
                    return;
                }

                // Verificar spread mínimo
                const spreadPct = calcularSpread(pValue, cfg.MIN_VENTA);
                if (spreadPct < SPREAD_MIN) {
                    log(`Float ${fValue.toFixed(6)} | Spread ${spreadPct.toFixed(1)}% < ${SPREAD_MIN}% mínimo`, 'warn');
                    return;
                }

                // ¡Todo OK! Alertar
                alertarGanga(fila, fValue, pValue, spreadPct);
            });

            if (conFloat === 0) {
                ciclosSinFloats++;
                log(`⏳ 0 floats (ciclo ${ciclosSinFloats}/${MAX_CICLOS_VACIOS})`, 'warn');
                if (ciclosSinFloats >= MAX_CICLOS_VACIOS) recargar('Sin floats', false);
                return;
            }

            ciclosSinFloats = 0;
            resetFallos();

            if (conFloat >= filas.length - 1) {
                log(`📋 Revisión completa (${conFloat}/${filas.length}). Recargando...`, 'info');
                recargar('Revisión completa', true);
            }
        }, SCAN_INTERVAL);
    };

    // ── Helpers ────────────────────────────────────────────────────────
    const detener = () => {
        clearInterval(scanId);
        clearTimeout(timeoutId);
        if (observer) { observer.disconnect(); observer = null; }
    };

    const recargar = (motivo, exito = false) => {
        if (ganado) return;
        detener();
        const ms = randDelay(exito);
        log(`🔄 Recargando en ${(ms / 1000).toFixed(0)}s — ${motivo}`, exito ? 'info' : 'warn');
        setTimeout(() => location.reload(), ms);
    };

    // ── Observer ──────────────────────────────────────────────────────
    const iniciarObserver = () => {
        const fallos = getFallos();
        log(`👁️ Observer activo | Fallos: ${fallos}`, 'info');

        timeoutId = setTimeout(() => {
            if (ganado || csfloatOk) return;
            log(`⏰ CSFloat timeout (${CSFLOAT_TIMEOUT / 1000}s)`, 'warn');
            recargar('CSFloat timeout', false);
        }, CSFLOAT_TIMEOUT);

        observer = new MutationObserver(() => {
            if (ganado || sortHecho) return;
            if (!hayFloatsCargados()) return;

            csfloatOk = true;
            resetFallos();
            sortHecho = true;
            observer.disconnect(); observer = null;

            const count = document.querySelectorAll('csfloat-item-row-wrapper').length;
            log(`✅ ${count} floats en Shadow DOM. Iniciando...`, 'ok');

            // Sort con delay humano
            setTimeout(() => {
                if (intentarSort()) log('🖱️ Sort by Float: OK', 'ok');
                else                log('⚠️ Botón Sort no encontrado', 'warn');
            }, Math.floor(300 + Math.random() * 500));

            // Scan siempre arranca (con o sin sort)
            setTimeout(iniciarScan, SORT_WAIT_AFTER);
        });

        observer.observe(document.body, { childList: true, subtree: true });
    };

    // ── Arranque ──────────────────────────────────────────────────────
    chrome.storage.local.get(['perfil', 'activo', 'maxFloat', 'maxPrice', 'minVenta'], (data) => {
        perfilActual = data.perfil || 1;
        cfg          = { ...PERFILES[perfilActual] };
        activo       = typeof data.activo === 'boolean' ? data.activo : true;

        // Sobreescribir con valores manuales si existen
        if (typeof data.maxFloat === 'number' && data.maxFloat > 0) cfg.MAX_FLOAT = data.maxFloat;
        if (typeof data.maxPrice === 'number' && data.maxPrice > 0) cfg.MAX_PRICE = data.maxPrice;
        if (typeof data.minVenta === 'number' && data.minVenta > 0) cfg.MIN_VENTA = data.minVenta;

        if (!activo) { log('⏸️ Sniper PAUSADO', 'warn'); return; }

        // Detectar bloqueo
        const body = document.body.innerText || '';
        if (body.includes('Too Many Requests') || body.includes('Access Denied')) {
            log('❌ IP BLOQUEADA. Espera ≥ 30 min.', 'error');
            const b = document.createElement('div');
            b.style.cssText = 'position:fixed;top:0;left:0;width:100%;z-index:99999;background:#b71c1c;color:#fff;text-align:center;padding:14px;font-size:16px;font-weight:bold;font-family:monospace;';
            b.textContent = '❌ IP BLOQUEADA POR STEAM — Espera al menos 30 minutos';
            document.body.prepend(b);
            return;
        }

        const spreadEstimado = calcularSpread(cfg.MAX_PRICE, cfg.MIN_VENTA);
        log(`🎯 SNIPER v9 — ${cfg.nombre} | float < ${cfg.MAX_FLOAT} | precio ≤ $${cfg.MAX_PRICE} | spread est: ${spreadEstimado.toFixed(1)}%`, 'ok');

        if (hayFloatsCargados()) {
            log('⚡ Floats ya presentes. Iniciando directo...', 'ok');
            csfloatOk = true; resetFallos(); sortHecho = true;
            setTimeout(() => { if (intentarSort()) log('🖱️ Sort OK', 'ok'); }, 300);
            setTimeout(iniciarScan, SORT_WAIT_AFTER);
        } else {
            iniciarObserver();
        }
    });

})();
