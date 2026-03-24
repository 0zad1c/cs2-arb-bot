// popup.js v2 — Integración con config de arbitrage real
const PERFILES = {
    1: { nombre: 'Black Lotus FT', MAX_FLOAT: 0.2000, MAX_PRICE: 8.00,  MIN_VENTA: 9.00  },
    2: { nombre: 'Redline FT',     MAX_FLOAT: 0.3800, MAX_PRICE: 36.00, MIN_VENTA: 44.00 },
};

const FEES = { steam: 0.87, csfloat: 0.98 };
const $ = (id) => document.getElementById(id);

// Calcula spread estimado
function calcularSpread(precioCompra, precioVenta) {
    if (!precioCompra || !precioVenta) return null;
    const costoTotal  = precioCompra / FEES.csfloat;
    const ingresoNeto = precioVenta * FEES.steam;
    return ((ingresoNeto - costoTotal) / costoTotal) * 100;
}

// Cargar estado guardado
chrome.storage.local.get(['perfil', 'activo', 'maxFloat', 'maxPrice', 'minVenta', 'stats'], (data) => {
    const perfil   = data.perfil  || 1;
    const activo   = typeof data.activo === 'boolean' ? data.activo : true;
    const def      = PERFILES[perfil];
    const maxFloat = typeof data.maxFloat === 'number' ? data.maxFloat : def.MAX_FLOAT;
    const maxPrice = typeof data.maxPrice === 'number' ? data.maxPrice : def.MAX_PRICE;
    const minVenta = typeof data.minVenta === 'number' ? data.minVenta : def.MIN_VENTA;

    document.querySelectorAll('.perfil-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.perfil) === perfil);
    });
    $('toggleActivo').checked  = activo;
    $('maxFloatInput').value   = maxFloat.toFixed(3);
    $('maxPriceInput').value   = maxPrice.toFixed(2);
    $('minVentaInput').value   = minVenta.toFixed(2);

    actualizarUI(perfil, activo, maxFloat, maxPrice, minVenta);
    actualizarStats(data.stats);
});

// Click perfil
document.querySelectorAll('.perfil-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const perfil = parseInt(btn.dataset.perfil);
        document.querySelectorAll('.perfil-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const def = PERFILES[perfil];
        $('maxFloatInput').value = def.MAX_FLOAT.toFixed(3);
        $('maxPriceInput').value = def.MAX_PRICE.toFixed(2);
        $('minVentaInput').value = def.MIN_VENTA.toFixed(2);
        chrome.storage.local.get(['activo'], (data) => {
            const activo = typeof data.activo === 'boolean' ? data.activo : true;
            chrome.storage.local.set({ perfil, maxFloat: def.MAX_FLOAT, maxPrice: def.MAX_PRICE, minVenta: def.MIN_VENTA },
                () => actualizarUI(perfil, activo, def.MAX_FLOAT, def.MAX_PRICE, def.MIN_VENTA));
        });
    });
});

// Toggle activo
$('toggleActivo').addEventListener('change', (e) => {
    const activo = e.target.checked;
    chrome.storage.local.get(['perfil', 'maxFloat', 'maxPrice', 'minVenta'], (data) => {
        const perfil   = data.perfil  || 1;
        const maxFloat = typeof data.maxFloat === 'number' ? data.maxFloat : PERFILES[perfil].MAX_FLOAT;
        const maxPrice = typeof data.maxPrice === 'number' ? data.maxPrice : PERFILES[perfil].MAX_PRICE;
        const minVenta = typeof data.minVenta === 'number' ? data.minVenta : PERFILES[perfil].MIN_VENTA;
        chrome.storage.local.set({ activo }, () => actualizarUI(perfil, activo, maxFloat, maxPrice, minVenta));
    });
});

// Guardar parámetros manuales
$('saveBtn').addEventListener('click', () => {
    const maxFloat = parseFloat($('maxFloatInput').value);
    const maxPrice = parseFloat($('maxPriceInput').value);
    const minVenta = parseFloat($('minVentaInput').value);

    const error = (id) => {
        $(id).style.borderBottomColor = '#ef5350';
        setTimeout(() => $(id).style.borderBottomColor = '', 1500);
    };

    if (isNaN(maxFloat) || maxFloat <= 0 || maxFloat > 1)  { error('maxFloatInput'); return; }
    if (isNaN(maxPrice) || maxPrice <= 0)                  { error('maxPriceInput'); return; }
    if (isNaN(minVenta) || minVenta <= maxPrice)            { error('minVentaInput'); return; }

    chrome.storage.local.get(['perfil', 'activo'], (data) => {
        const perfil = data.perfil || 1;
        const activo = typeof data.activo === 'boolean' ? data.activo : true;
        chrome.storage.local.set({ maxFloat, maxPrice, minVenta }, () => {
            actualizarUI(perfil, activo, maxFloat, maxPrice, minVenta);
            const msg = $('savedMsg');
            msg.classList.add('show');
            setTimeout(() => msg.classList.remove('show'), 2000);
        });
    });
});

function actualizarStats(stats) {
    if (!stats) return;
    const el = $('statsBox');
    if (!el) return;
    el.innerHTML = `Gangas detectadas: <span class="val">${stats.gangas || 0}</span>`;
    if (stats.ultimaGanga) {
        const ug = stats.ultimaGanga;
        const ts = new Date(ug.ts).toLocaleTimeString('es-MX');
        el.innerHTML += `<br>Última: float <span class="val">${ug.floatValue.toFixed(5)}</span> @ $${ug.precio.toFixed(2)} — spread <span class="speed">${ug.spreadPct.toFixed(1)}%</span> <span style="color:#555">${ts}</span>`;
    }
}

function actualizarUI(perfil, activo, maxFloat, maxPrice, minVenta) {
    $('infoNombre').textContent = PERFILES[perfil]?.nombre || '—';
    $('infoFloat').textContent  = maxFloat.toFixed(4);
    $('infoPrecio').textContent = `$${maxPrice.toFixed(2)}`;

    const spreadEl = $('infoSpread');
    if (spreadEl) {
        const sp = calcularSpread(maxPrice, minVenta);
        if (sp !== null) {
            spreadEl.textContent = `${sp.toFixed(1)}%`;
            spreadEl.style.color = sp >= 12 ? '#00e676' : '#ef5350';
        }
    }

    const dot   = $('statusDot'), badge = $('statusBadge');
    dot.className   = activo ? 'dot'          : 'dot off';
    badge.className = activo ? 'status-badge on' : 'status-badge off';
    badge.textContent = activo ? 'ACTIVO' : 'PAUSADO';
}
