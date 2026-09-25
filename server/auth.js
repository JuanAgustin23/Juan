'use strict';
// Protección del panel de caja/administración en el servidor.
// - Contraseña guardada como hash scrypt en la base de datos.
// - Sesión en cookie HttpOnly + SameSite=Strict firmada con HMAC.
// - Las rutas que modifican datos exigen además la cabecera X-Requested-With (anti-CSRF).
const crypto = require('node:crypto');

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

function createAuth(settings) {
  // Inicializa la contraseña: ADMIN_PASSWORD manda; si no existe, se genera una y se muestra una sola vez.
  if (process.env.ADMIN_PASSWORD) {
    const cur = settings.get('admin_pass_hash');
    if (!cur || !verifyPassword(process.env.ADMIN_PASSWORD, cur)) {
      settings.set('admin_pass_hash', hashPassword(process.env.ADMIN_PASSWORD));
      settings.set('session_secret', crypto.randomBytes(32).toString('hex'));
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
    const data = `${exp}.${crypto.randomBytes(8).toString('hex')}`;
    res.cookie(COOKIE, `${data}.${sign(data)}`, {
      httpOnly: true, sameSite: 'strict', secure, maxAge: SESSION_MS, path: '/',
    });
  }

  function isValid(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return false;
    const idx = raw.lastIndexOf('.');
    const data = raw.slice(0, idx);
    const sig = raw.slice(idx + 1);
    const expected = sign(data);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    return Number(data.split('.')[0]) > Date.now();
  }

  function requireAdmin(req, res, next) {
    if (!isValid(req)) return res.status(401).json({ error: 'No autorizado' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Requested-With') !== 'rucka') {
      return res.status(403).json({ error: 'Solicitud rechazada' });
    }
    next();
  }

  // Límite de intentos de inicio de sesión por IP.
  const attempts = new Map();
  function tooManyAttempts(ip) {
    const now = Date.now();
    const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
    attempts.set(ip, a);
    return a.length >= 8;
  }
  function recordFailure(ip) { attempts.get(ip)?.push(Date.now()) ?? attempts.set(ip, [Date.now()]); }

  function login(req, res) {
    const ip = req.ip;
    if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
    const ok = verifyPassword(String(req.body?.password || ''), settings.get('admin_pass_hash'));
    if (!ok) { recordFailure(ip); return res.status(401).json({ error: 'Contraseña incorrecta' }); }
    attempts.delete(ip);
    issue(res, req.secure);
    res.json({ ok: true });
  }

  function logout(_req, res) {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }

  function changePassword(req, res) {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), settings.get('admin_pass_hash'))) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    if (typeof next !== 'string' || next.length < 10) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres' });
    settings.set('admin_pass_hash', hashPassword(next));
    settings.set('session_secret', crypto.randomBytes(32).toString('hex')); // cierra otras sesiones
    issue(res, req.secure);
    res.json({ ok: true });
  }

  return { requireAdmin, isValid, login, logout, changePassword };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { createAuth };
