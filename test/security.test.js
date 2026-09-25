'use strict';
// Pruebas de la capa de seguridad: IP real, límites, Turnstile (con un verificador simulado),
// sesiones que se invalidan al salir, comprobantes privados y candado de origen.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const PASSWORD = 'clave-seguridad-2026';
let server, verifier, base;
const verifyCalls = [];

before(async () => {
  // Verificador falso de Turnstile: acepta "ok-<accion>" y responde la acción, como Cloudflare.
  verifier = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      verifyCalls.push(Object.fromEntries(p));
      const tok = p.get('response') || '';
      const ok = p.get('secret') === 'secreto-de-prueba' && tok.startsWith('ok-');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(ok ? { success: true, action: tok.slice(3), hostname: 'rucka-monkey-demo.onrender.com' } : { success: false, 'error-codes': ['invalid-input-response'] }));
    });
  });
  verifier.listen(0);
  await new Promise((r) => verifier.once('listening', r));

  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-sec-'));
  process.env.ADMIN_PASSWORD = PASSWORD;
  process.env.CLIENT_IP_HEADER = 'cf-connecting-ip';
  process.env.TURNSTILE_SITE_KEY = 'clave-sitio-publica';
  process.env.TURNSTILE_SECRET_KEY = 'secreto-de-prueba';
  process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${verifier.address().port}/siteverify`;
  process.env.TURNSTILE_HOSTNAMES = 'rucka-monkey-demo.onrender.com';
  const { createApp } = require('../server/index.js');
  server = createApp().app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); verifier.close(); });

const login = (ip, body) => fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) });
async function sessionCookie(ip = '198.51.100.9') {
  const r = await login(ip, { password: PASSWORD, turnstileToken: 'ok-login' });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}
async function order(ip, extra = {}) {
  const menu = await (await fetch(base + '/api/menu')).json();
  const p = menu.categories[0].products[0];
  const fd = new FormData();
  const o = { idempotencyKey: extra.key || crypto.randomUUID(), customerName: 'Cliente Prueba', paymentMethod: 'efectivo', items: [{ productId: p.id, quantity: 1 }] };
  fd.append('order', JSON.stringify(o));
  if (extra.turnstile) fd.append('turnstile', extra.turnstile);
  if (extra.file) fd.append('receipt', new Blob([extra.file]), 'x.png');
  const r = await fetch(base + '/api/orders', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: fd });
  return { status: r.status, data: await r.json(), key: o.idempotencyKey };
}

test('Turnstile es obligatorio para iniciar sesión y se valida en el servidor', async () => {
  const session = await (await fetch(base + '/api/admin/session')).json();
  assert.equal(session.turnstileSiteKey, 'clave-sitio-publica');
  assert.equal(session.loggedIn, false);
  let r = await login('203.0.113.1', { password: PASSWORD });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'TURNSTILE_FAILED');
  r = await login('203.0.113.1', { password: PASSWORD, turnstileToken: 'token-falso' });
  assert.equal(r.status, 400);
  r = await login('203.0.113.1', { password: PASSWORD, turnstileToken: 'ok-pedido' }); // token de otra acción
  assert.equal(r.status, 400);
  r = await login('203.0.113.1', { password: PASSWORD, turnstileToken: 'ok-login' });
  assert.equal(r.status, 200);
  const call = verifyCalls.at(-1);
  assert.equal(call.remoteip, '203.0.113.1');
  assert.equal(call.secret, 'secreto-de-prueba');
});

test('los intentos fallidos se limitan por IP real del cliente, sin bloquear a los demás', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await login('203.0.113.50', { password: 'mala', turnstileToken: 'ok-login' })).status, 401);
  const blocked = await login('203.0.113.50', { password: PASSWORD, turnstileToken: 'ok-login' });
  assert.equal(blocked.status, 429, 'incluso con la contraseña correcta, esa IP espera');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await login('203.0.113.51', { password: PASSWORD, turnstileToken: 'ok-login' })).status, 200, 'otra IP entra normal');
});

test('cerrar sesión invalida la cookie en el servidor', async () => {
  const cookie = await sessionCookie();
  const h = { cookie, 'X-Requested-With': 'rucka' };
  assert.equal((await fetch(base + '/api/admin/orders', { headers: h })).status, 200);
  await fetch(base + '/api/admin/logout', { method: 'POST', headers: h });
  assert.equal((await fetch(base + '/api/admin/orders', { headers: h })).status, 401, 'la cookie robada ya no sirve');
  const weird = await fetch(base + '/api/admin/orders', { headers: { cookie: 'rm_admin=%E0%A4%A' } });
  assert.equal(weird.status, 401, 'cookie mal formada no provoca error 500');
});

test('pedidos: los primeros pasan sin desafío; desde el 5.º se pide Turnstile solo a esa conexión', async () => {
  const ip = '192.0.2.10';
  const firsts = [];
  for (let i = 0; i < 4; i++) { const r = await order(ip); assert.equal(r.status, 201, JSON.stringify(r.data)); firsts.push(r.key); }
  const fifth = await order(ip);
  assert.equal(fifth.status, 428);
  assert.equal(fifth.data.code, 'TURNSTILE_REQUIRED');
  assert.equal(fifth.data.siteKey, 'clave-sitio-publica');
  assert.equal((await order(ip, { turnstile: 'basura' })).status, 428);
  assert.equal((await order(ip, { turnstile: 'ok-pedido' })).status, 201);
  // Reenviar un pedido ya creado (mala señal) nunca pide verificación ni cuenta
  const again = await order(ip, { key: firsts[0] });
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  // Otro cliente, otra IP: sin desafío
  assert.equal((await order('192.0.2.11')).status, 201);
});

test('los comprobantes solo se ven con sesión, con cabeceras que impiden ejecutar contenido', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const menu = await (await fetch(base + '/api/menu')).json();
  const fd = new FormData();
  fd.append('order', JSON.stringify({ idempotencyKey: crypto.randomUUID(), customerName: 'Con comprobante', paymentMethod: 'transferencia', items: [{ productId: menu.categories[0].products[0].id, quantity: 1 }] }));
  fd.append('receipt', new Blob([png], { type: 'image/png' }), 'c.png');
  const r = await fetch(base + '/api/orders', { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.77' }, body: fd });
  assert.equal(r.status, 201);
  const cookie = await sessionCookie();
  const list = await (await fetch(base + '/api/admin/orders', { headers: { cookie } })).json();
  const o = list.orders.find((x) => x.customerName === 'Con comprobante');
  assert.equal((await fetch(base + o.receipt)).status, 401);
  assert.equal((await fetch(base + `/api/admin/orders/${o.id}/receipt`, { headers: { cookie: 'rm_admin=1.2.3' } })).status, 401);
  const ok = await fetch(base + o.receipt, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-security-policy'), /sandbox/);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  // Estado público del pedido: no revela el comprobante
  const pub = await (await fetch(`${base}/api/orders/${(await r.json()).token}`)).json();
  assert.equal(pub.receipt, undefined);
  assert.equal(pub.receiptAttached, true);
});

test('adjuntos: solo imágenes JPG/PNG/WEBP de hasta 8 MB', async () => {
  const menu = await (await fetch(base + '/api/menu')).json();
  const send = (buf, name) => {
    const fd = new FormData();
    fd.append('order', JSON.stringify({ idempotencyKey: crypto.randomUUID(), customerName: 'Adjunto', paymentMethod: 'transferencia', items: [{ productId: menu.categories[0].products[0].id, quantity: 1 }] }));
    fd.append('receipt', new Blob([buf]), name);
    return fetch(base + '/api/orders', { method: 'POST', headers: { 'cf-connecting-ip': `192.0.2.${100 + Math.floor(Math.random() * 100)}` }, body: fd });
  };
  assert.equal((await send(Buffer.from('<svg onload=alert(1)></svg>'), 'x.png')).status, 400, 'SVG disfrazado de PNG');
  assert.equal((await send(Buffer.from('%PDF-1.4 ...'), 'x.jpg')).status, 400, 'PDF');
  const big = Buffer.alloc(9 * 1024 * 1024);
  big.set([0xff, 0xd8, 0xff], 0);
  const r = await send(big, 'grande.jpg');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /8 MB/);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'comprobantes')).length, 1, 'no quedaron archivos rechazados en disco');
});

test('la política de contenido permite Turnstile solo desde Cloudflare', async () => {
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('diagnóstico de seguridad solo para caja y con la IP real', async () => {
  assert.equal((await fetch(base + '/api/admin/security')).status, 401);
  const cookie = await sessionCookie();
  const d = await (await fetch(base + '/api/admin/security', { headers: { cookie, 'cf-connecting-ip': '198.51.100.9' } })).json();
  assert.equal(d.ipDetectada, '198.51.100.9');
  assert.equal(d.fuenteIp, 'cf-connecting-ip');
  assert.equal(d.turnstile, true);
});

test('límite general de la API por cliente', async () => {
  let last;
  for (let i = 0; i < 301; i++) last = await fetch(base + '/api/menu', { headers: { 'cf-connecting-ip': '192.0.2.200' } });
  assert.equal(last.status, 429);
  assert.equal((await fetch(base + '/api/menu', { headers: { 'cf-connecting-ip': '192.0.2.201' } })).status, 200);
  assert.equal((await fetch(base + '/api/health', { headers: { 'cf-connecting-ip': '192.0.2.200' } })).status, 200, 'el chequeo de salud del hosting no se bloquea');
});

test('candado de origen (para cuando haya dominio propio en Cloudflare)', async () => {
  process.env.ORIGIN_SECRET = 'secreto-origen-largo-123';
  try {
    assert.equal((await fetch(base + '/api/menu', { headers: { 'cf-connecting-ip': '192.0.2.30' } })).status, 403);
    assert.equal((await fetch(base + '/api/menu', { headers: { 'cf-connecting-ip': '192.0.2.30', 'x-origin-secret': 'secreto-origen-largo-123' } })).status, 200);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    process.env.PUBLIC_BASE_URL = 'https://carta.ejemplo.cl';
    const r = await fetch(base + '/caja?x=1', { redirect: 'manual' });
    assert.equal(r.status, 308);
    assert.equal(r.headers.get('location'), 'https://carta.ejemplo.cl/caja?x=1');
  } finally {
    delete process.env.ORIGIN_SECRET;
    delete process.env.PUBLIC_BASE_URL;
  }
  assert.equal((await fetch(base + '/api/menu', { headers: { 'cf-connecting-ip': '192.0.2.31' } })).status, 200, 'sin la variable, todo funciona como antes');
});
