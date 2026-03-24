# CS2 Arb Bot v2.0 — CSFloat ↔ Steam Market

Bot de arbitrage profesional para skins de CS2. Detecta listings en CSFloat con precio bajo y float óptimo, los compra automáticamente y los lista en Steam Market con margen de ganancia.

---

## Arquitectura

```
cs2-arb-bot/
├── src/
│   ├── bot.js              ← Orquestador principal (punto de entrada)
│   ├── config.js           ← Toda la configuración de negocio
│   ├── clients/
│   │   ├── csfloat.js      ← WebSocket + REST API de CSFloat
│   │   └── steam.js        ← Steam Market (precios, listado, inventario)
│   ├── core/
│   │   ├── riskManager.js  ← Circuit breakers y reglas de riesgo
│   │   ├── portfolio.js    ← Gestión de capital y reinversión
│   │   └── priceEngine.js  ← Motor de precios con actualización cada 30min
│   ├── services/
│   │   ├── logger.js       ← SQLite + logs de consola estructurados
│   │   ├── alerts.js       ← Notificaciones Telegram
│   │   └── dashboard.js    ← Dashboard en consola (actualiza cada 30s)
│   └── utils/
│       └── retry.js        ← Backoff exponencial con jitter
├── extension/              ← Chrome extension mejorada (v9)
│   ├── content.js          ← Script inyectado en Steam Market
│   ├── popup.html/js       ← UI de la extensión con spread estimado
│   └── manifest.json
├── data/                   ← Base de datos SQLite (se crea automáticamente)
├── .env.example            ← Plantilla de variables de entorno
└── package.json
```

---

## Setup — Backend Bot (VPS)

### 1. Prerequisitos
```bash
node --version   # Necesitas >= 20.0.0
npm --version
```

### 2. Instalar dependencias
```bash
cd cs2-arb-bot
npm install
```

### 3. Configurar variables de entorno
```bash
cp .env.example .env
nano .env   # Rellenar todas las variables
```

**Variables críticas:**
| Variable | Cómo obtenerla |
|---|---|
| `CSFLOAT_API_KEY` | https://csfloat.com/developer |
| `STEAM_API_KEY` | https://steamcommunity.com/dev/apikey |
| `STEAM_SESSION_ID` | DevTools → Application → Cookies → steamcommunity.com |
| `STEAM_LOGIN_SECURE` | DevTools → Application → Cookies → steamcommunity.com |
| `TELEGRAM_BOT_TOKEN` | @BotFather en Telegram |
| `TELEGRAM_CHAT_ID` | Envía /start al bot, luego `https://api.telegram.org/bot<TOKEN>/getUpdates` |

### 4. Modo Paper (prueba sin dinero real)
```bash
# En .env: BOT_MODE=paper
npm start
```
El bot simula todas las compras y ventas sin tocar APIs autenticadas.

### 5. Modo Live (dinero real)
```bash
# En .env: BOT_MODE=live
npm start
```
⚠️ **Verifica que el modo paper funcione correctamente durante al menos 48h antes de activar live.**

---

## Setup — Chrome Extension

1. Abrir Chrome → `chrome://extensions/`
2. Activar **Modo desarrollador** (esquina superior derecha)
3. Click **Cargar descomprimida** → seleccionar la carpeta `extension/`
4. La extensión aparece en la barra de Chrome

---

## Despliegue en VPS 24/7

### Con PM2 (recomendado)
```bash
npm install -g pm2

# Iniciar
pm2 start src/bot.js --name cs2-bot --interpreter node

# Ver logs en tiempo real
pm2 logs cs2-bot

# Reiniciar automáticamente si el proceso crashea
pm2 startup
pm2 save

# Ver dashboard
pm2 monit
```

### Con systemd
```bash
sudo nano /etc/systemd/system/cs2-bot.service
```
```ini
[Unit]
Description=CS2 Arb Bot
After=network.target

[Service]
Type=simple
User=tu_usuario
WorkingDirectory=/ruta/a/cs2-arb-bot
ExecStart=/usr/bin/node src/bot.js
EnvironmentFile=/ruta/a/cs2-arb-bot/.env
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable cs2-bot
sudo systemctl start cs2-bot
sudo systemctl status cs2-bot
```

---

## Estrategia de negocio

### Fase 1 — $21 → $100 (M4A1-S Black Lotus FT)
- **Comprar en CSFloat** ≤ $8.00 | float < 0.20
- **Vender en Steam** ≥ $9.00
- **Ganancia estimada**: 15-20% por operación (después de fees)
- **Fee CSFloat**: 2% | **Fee Steam**: 13%

### Fase 2 — $100+ (AK-47 Redline FT)
- Se activa automáticamente cuando el capital supera $50
- **Comprar en CSFloat** ≤ $36.00 | float < 0.38
- **Vender en Steam** ≥ $44.00

### Reinversión compuesta
- Reinvertir el 100% de las ganancias hasta llegar a $100
- Al superar $100 en +40% (= $140): retirar el 25% ($35)
- Continuar con el 75% restante

---

## Reglas de riesgo (circuit breakers)

| Condición | Acción |
|---|---|
| Spread < 12% | Rechazar la operación |
| Steam bajó > 8% en 24h | Pausar la skin afectada |
| 2 fallos consecutivos | Pausar todo el bot 30 minutos |
| Exposición > 60% del capital | No abrir nuevas posiciones |
| Capital insuficiente para la compra | Rechazar |

---

## Añadir una nueva skin

1. Editar `src/config.js`
2. Agregar al array `SKINS`:
```javascript
{
  id:       'knife_tiger_tooth_ft',
  nombre:   'Karambit | Tiger Tooth (Factory New)',
  marketName: 'Karambit | Tiger Tooth (Factory New)',
  appId:    730,
  activa:   false,   // Activar cuando sea el momento
  fase:     3,
  bands: [
    {
      nombre:       'FN Premium',
      floatMin:     0.00,
      floatMax:     0.07,
      maxCompraCF:  250.00,
      minVentaSteam: 310.00,
      prioridadCompra: 1,
    },
  ],
},
```
3. Sin tocar ningún otro archivo.

---

## Renovar cookies de Steam (cada ~30 días)

Las cookies `sessionid` y `steamLoginSecure` expiran. El bot envía una alerta de Telegram cuando detecta un 401.

1. Abrir Chrome → steamcommunity.com (con sesión iniciada)
2. DevTools → Application → Cookies → steamcommunity.com
3. Copiar `sessionid` y `steamLoginSecure`
4. Actualizar `.env`
5. Reiniciar el bot: `pm2 restart cs2-bot`

---

## Logs y base de datos

```bash
# Ver últimas operaciones
sqlite3 data/operaciones.db "SELECT * FROM operaciones ORDER BY created_at DESC LIMIT 10;"

# Ganancia total
sqlite3 data/operaciones.db "SELECT ROUND(SUM(ganancia_usd),4) FROM operaciones WHERE estado='vendido';"

# Eventos recientes
sqlite3 data/operaciones.db "SELECT tipo, mensaje, datetime(ts/1000,'unixepoch') FROM eventos ORDER BY ts DESC LIMIT 20;"
```
