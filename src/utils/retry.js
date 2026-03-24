// ─────────────────────────────────────────────────────────────────────────────
// utils/retry.js — Reintentos con backoff exponencial + jitter
//
// Uso:
//   const result = await withRetry(() => fetch(...), { retries: 5, base: 1000 });
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Ejecuta `fn` con reintentos automáticos.
 *
 * @param {Function} fn        - Función async a reintentar
 * @param {Object}   opts
 * @param {number}   opts.retries   - Número máximo de reintentos (default: 5)
 * @param {number}   opts.base      - Delay base en ms (default: 1000)
 * @param {number}   opts.maxDelay  - Delay máximo en ms (default: 60_000)
 * @param {number}   opts.factor    - Factor multiplicativo (default: 2)
 * @param {Function} opts.onRetry   - Callback (intento, error, nextDelay) llamado antes de reintentar
 * @param {Function} opts.retryIf   - Predicate: solo reintenta si retorna true (default: siempre)
 * @returns {Promise<any>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    retries  = 5,
    base     = 1000,
    maxDelay = 60_000,
    factor   = 2,
    onRetry  = null,
    retryIf  = () => true,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt >= retries) break;
      if (!retryIf(err, attempt)) throw err;

      // Exponential backoff con jitter aleatorio (±20%)
      const exponential = Math.min(base * Math.pow(factor, attempt), maxDelay);
      const jitter      = exponential * (0.8 + Math.random() * 0.4);
      const delay       = Math.floor(jitter);

      if (onRetry) onRetry(attempt + 1, err, delay);

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Detecta si un error HTTP es un rate limit (429) o error de servidor (5xx).
 * Útil como predicate para `retryIf`.
 */
export function isRetryableHttpError(err) {
  const status = err?.response?.status;
  if (!status) return true;                        // Error de red → reintentar
  if (status === 429) return true;                 // Rate limit → reintentar
  if (status >= 500 && status < 600) return true;  // Error de servidor → reintentar
  return false;                                    // 4xx cliente → no reintentar
}

/**
 * Extrae el Retry-After de una respuesta 429.
 * @returns {number} ms a esperar (default 60s si no hay header)
 */
export function getRetryAfterMs(err) {
  const header = err?.response?.headers?.['retry-after'];
  if (!header) return 60_000;
  const seconds = parseInt(header, 10);
  return isNaN(seconds) ? 60_000 : seconds * 1000;
}

export { sleep };
