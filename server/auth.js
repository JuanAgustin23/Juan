'use strict';
// Protección del panel de caja/administración en el servidor.
// - Contraseña guardada como hash scrypt en la base de datos.
// - Sesión en cookie HttpOnly + SameSite=Strict firmada con HMAC.
// - Cada sesión también queda registrada en la base: cerrar sesión la invalida de verdad.
// - Las rutas que modifican datos exigen además la cabecera X-Requested-With (anti-CSRF).
// - Intentos de acceso limitados por IP real del cliente (+ Cloudflare Turnstile si está configurado).
const crypto = require('node:crypto');
const { clientIp, RateLimiter, turnstile } = require('./security');

const COOKIE = 'rm_admin';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 horas

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function createAuth(settings, db) {
  db.exec('CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  const sessionHash = (id) => crypto.createHash('sha256').update(id).digest('hex');
  // Inicializa la contraseña: ADMIN_PASSWORD manda; si no existe, se genera una y se muestra una sola vez.
  if (process.env.ADMIN_PASSWORD) {
    const cur = settings.get('admin_pass_hash');
    if (!cur || !verifyPassword(process.env.ADMIN_PASSWORD, cur)) {
      settings.set('admin_pass_hash', hashPassword(process.env.ADMIN_PASSWORD));
      settings.set('session_secret', crypto.randomBytes(32).toString('hex'));
      db.exec('DELETE FROM admin_sessions');
    }
  } else if (!settings.get('admin_pass_hash')) {
    const pw = crypto.randomBytes(9).toString('base64url');
    settings.set('admin_pass_hash', hashPassword(pw));
    console.log('\n=====================================================');
    console.log(' Contraseña inicial del panel de caja:  ' + pw);
    console.log(' (cámbiala desde el panel o define ADMIN_PASSWORD)');
    console.log('=====================================================\n');
  }
  if (!settings.get('session_secret')) settings.set('session_secret', crypto.randomBytes(32).toString('hex'));

  const sign = (data) => crypto.createHmac('sha256', settings.get('session_secret')).update(data).digest('base64url');

  function issue(res, secure) {
    const exp = Date.now() + SESSION_MS;
    const id = crypto.randomBytes(18).toString('base64url');
    const data = `${exp}.${id}`;
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)').run(sessionHash(id), exp);
    res.cookie(COOKIE, `${data}.${sign(data)}`, {
      httpOnly: true, sameSite: 'strict', secure, maxAge: SESSION_MS, path: '/',
    });
  }

  function isValid(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw || raw.length > 200) return false;
    const idx = raw.lastIndexOf('.');
    const data = raw.slice(0, idx);
    const sig = raw.slice(idx + 1);
    const expected = sign(data);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const [exp, id] = data.split('.');
    if (!(Number(exp) > Date.now()) || !id) return false;
    return !!db.prepare('SELECT 1 FROM admin_sessions WHERE id = ? AND expires_at > ?').get(sessionHash(id), Date.now());
  }
  function sessionId(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE] || '';
    return raw.split('.')[1] || '';
  }

  function requireAdmin(req, res, next) {
    if (!isValid(req)) return res.status(401).json({ error: 'No autorizado' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Requested-With') !== 'rucka') {
      return res.status(403).json({ error: 'Solicitud rechazada' });
    }
    next();
  }

  // Límite de intentos: 8 fallos por IP cada 15 minutos. Si llegan muchos fallos desde muchas IP
  // (ataque distribuido), se agrega una espera a cada intento en vez de bloquear al cajero.
  const failsByIp = new RateLimiter(15 * 60 * 1000);
  const failsGlobal = new RateLimiter(15 * 60 * 1000);
  const MAX_IP = 8;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function login(req, res) {
    const ip = clientIp(req);
    if (failsByIp.count(ip) >= MAX_IP) {
      res.set('Retry-After', String(failsByIp.retryAfter(ip)));
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.' });
    }
    if (failsGlobal.count('all') >= 50) await sleep(2000);
    if (turnstile.enabled()) {
      const t = await turnstile.verify(req.body?.turnstileToken, ip, 'login');
      if (!t.ok) return res.status(400).json({ error: 'No se pudo verificar que eres una persona. Recarga la página e inténtalo de nuevo.', code: 'TURNSTILE_FAILED' });
    }
    const pw = String(req.body?.password || '').slice(0, 200);
    if (!verifyPassword(pw, settings.get('admin_pass_hash'))) {
      failsByIp.add(ip);
      failsGlobal.add('all');
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    failsByIp.reset(ip);
    issue(res, req.secure);
    res.json({ ok: true });
  }

  function logout(req, res) {
    const id = sessionId(req);
    if (id) db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sessionHash(id));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }

  function changePassword(req, res) {
    const { current, next } = req.body || {};
    const ip = clientIp(req);
    if (failsByIp.count(ip) >= MAX_IP) return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos.' });
    if (!verifyPassword(String(current || '').slice(0, 200), settings.get('admin_pass_hash'))) { failsByIp.add(ip); return res.status(400).json({ error: 'La contraseña actual no es correcta' }); }
    if (typeof next === 'string' && next.length > 200) return res.status(400).json({ error: 'La nueva contraseña es demasiado larga' });
    if (typeof next !== 'string' || next.length < 10) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres' });
    settings.set('admin_pass_hash', hashPassword(next));
    settings.set('session_secret', crypto.randomBytes(32).toString('hex')); // cierra otras sesiones
    db.exec('DELETE FROM admin_sessions');
    issue(res, req.secure);
    res.json({ ok: true });
  }

  return { requireAdmin, isValid, login, logout, changePassword };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie mal formada: se ignora */ }
  }
  return out;
}

module.exports = { createAuth };
