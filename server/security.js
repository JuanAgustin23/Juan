'use strict';
// Capa de seguridad del servidor: IP real del cliente, límites de solicitudes,
// verificación de Cloudflare Turnstile y candado de origen (para usar con un dominio propio en Cloudflare).
// Todo se activa con variables de entorno; sin ellas, la app funciona igual que antes.
const crypto = require('node:crypto');

const env = (k) => (process.env[k] || '').trim();

// ---------- IP del cliente ----------
// En Render el tráfico pasa por Cloudflare y por su balanceador: req.ip sería la IP de un intermediario
// (compartida por muchos clientes). CLIENT_IP_HEADER=cf-connecting-ip toma la IP que Cloudflare ya validó.
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;
function clientIp(req) {
  const h = env('CLIENT_IP_HEADER').toLowerCase();
  if (h) {
    const v = String(req.headers[h] || '').split(',')[0].trim();
    if (IP_RE.test(v)) return v;
  }
  return req.ip || req.socket?.remoteAddress || 'desconocida';
}
function ipSource(req) {
  const h = env('CLIENT_IP_HEADER').toLowerCase();
  return h && IP_RE.test(String(req.headers[h] || '').split(',')[0].trim()) ? h : 'conexión/X-Forwarded-For';
}

// ---------- Límite de solicitudes (ventana deslizante en memoria) ----------
class RateLimiter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map();
    // Limpia claves viejas para no acumular memoria
    setInterval(() => {
      const now = Date.now();
      for (const [k, arr] of this.hits) if (!arr.length || now - arr[arr.length - 1] > this.windowMs) this.hits.delete(k);
    }, Math.min(windowMs, 60_000)).unref();
  }
  count(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, arr);
    return arr.length;
  }
  add(key) { this.count(key); this.hits.get(key).push(Date.now()); }
  reset(key) { this.hits.delete(key); }
  retryAfter(key) {
    const arr = this.hits.get(key) || [];
    return arr.length ? Math.max(1, Math.ceil((arr[0] + this.windowMs - Date.now()) / 1000)) : 0;
  }
}

// ---------- Cloudflare Turnstile ----------
const turnstile = {
  siteKey: () => env('TURNSTILE_SITE_KEY'),
  enabled: () => !!(env('TURNSTILE_SITE_KEY') && env('TURNSTILE_SECRET_KEY')),
  // Valida el token en el servidor de Cloudflare. Devuelve { ok, reason }.
  async verify(token, ip, expectedAction) {
    if (!turnstile.enabled()) return { ok: true, reason: 'desactivado' };
    if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, reason: 'sin-token' };
    const body = new URLSearchParams({ secret: env('TURNSTILE_SECRET_KEY'), response: token, idempotency_key: crypto.randomUUID() });
    if (ip && ip !== 'desconocida') body.set('remoteip', ip);
    try {
      const r = await fetch(env('TURNSTILE_VERIFY_URL') || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body, signal: AbortSignal.timeout(8000),
      });
      const d = await r.json();
      if (!d.success) return { ok: false, reason: (d['error-codes'] || []).join(',') || 'rechazado' };
      if (expectedAction && d.action && d.action !== expectedAction) return { ok: false, reason: 'accion-distinta' };
      const hosts = env('TURNSTILE_HOSTNAMES').split(',').map((s) => s.trim()).filter(Boolean);
      if (hosts.length && d.hostname && !hosts.includes(d.hostname)) return { ok: false, reason: 'hostname-distinto' };
      return { ok: true, reason: 'ok' };
    } catch {
      return { ok: false, reason: 'sin-conexion-con-cloudflare' };
    }
  },
};

// ---------- Candado de origen ----------
// Con un dominio propio en Cloudflare, una "Transform Rule" agrega la cabecera X-Origin-Secret a cada
// solicitud. Si ORIGIN_SECRET está definido, quien entre directo a la dirección de onrender.com
// (saltándose Cloudflare) es redirigido al dominio público o rechazado.
function originGuard(req, res, next) {
  const secret = env('ORIGIN_SECRET');
  if (!secret || req.path === '/api/health') return next();
  const got = Buffer.from(String(req.headers['x-origin-secret'] || ''));
  const want = Buffer.from(secret);
  if (got.length === want.length && crypto.timingSafeEqual(got, want)) return next();
  const pub = env('PUBLIC_BASE_URL');
  if (pub && (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')) return res.redirect(308, pub.replace(/\/+$/, '') + req.originalUrl);
  res.status(403).json({ error: 'Acceso directo no permitido. Usa la dirección pública del local.' });
}

module.exports = { clientIp, ipSource, RateLimiter, turnstile, originGuard };
