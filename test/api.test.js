'use strict';
// Pruebas de extremo a extremo de la API: flujo completo de pedido y reglas de seguridad.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-test-'));
process.env.ADMIN_PASSWORD = 'clave-de-prueba-123';
const { createApp } = require('../server/index.js');
const { chileDayRange } = require('../server/time.js');

let server, base, cookie = '', adminRouter;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function req(method, url, { json, form, auth = false, headers = {} } = {}) {
  const h = { ...headers };
  if (auth) { h.cookie = cookie; h['X-Requested-With'] = 'rucka'; }
  let body;
  if (json) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  if (form) body = form;
  const res = await fetch(base + url, { method, headers: h, body });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}
function orderForm(order, receipt) {
  const fd = new FormData();
  fd.append('order', JSON.stringify(order));
  if (receipt) fd.append('receipt', new Blob([receipt], { type: 'image/png' }), 'comprobante.png');
  return fd;
}

let menu;
const product = (name) => menu.categories.flatMap((c) => c.products).find((p) => p.name === name);

before(async () => {
  const created = createApp();
  adminRouter = created.adminRouter;
  server = created.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  menu = (await req('GET', '/api/menu')).data;
});
after(() => server.close());

test('la carta carga todos los productos con precios de prueba y modo demostración', () => {
  assert.equal(menu.settings.demoMode, true);
  const names = menu.categories.flatMap((c) => c.products.map((p) => p.name));
  for (const n of ['Papas fritas chicas', 'Papas fritas medianas', 'Papas fritas grandes', 'Completo italiano normal', 'Completo italiano grande',
    'Completo dinámico normal', 'Completo dinámico grande', 'ASS normal', 'ASS grande', 'Chorrillana chica', 'Chorrillana grande', 'Fajitas',
    'Churrasco Rucka Monkey', 'Quesadillas', 'Empanaditas de queso', 'Aros de cebolla']) assert.ok(names.includes(n), n);
  assert.ok(menu.categories.some((c) => c.name === 'Bebidas' && c.products.every((p) => p.isPlaceholder)));
  assert.ok(menu.categories.flatMap((c) => c.products).every((p) => p.priceIsTest && p.descriptionProvisional));
});

test('el panel está protegido en el servidor', async () => {
  assert.equal((await req('GET', '/api/admin/orders')).status, 401);
  assert.equal((await req('GET', '/api/admin/catalog')).status, 401);
  assert.equal((await req('POST', '/api/admin/login', { json: { password: 'mala' } })).status, 401);
  const ok = await req('POST', '/api/admin/login', { json: { password: 'clave-de-prueba-123' } });
  assert.equal(ok.status, 200);
  cookie = ok.res.headers.get('set-cookie').split(';')[0];
  assert.match(ok.res.headers.get('set-cookie'), /HttpOnly/i);
  // Sin la cabecera anti-CSRF se rechazan las modificaciones
  const noCsrf = await fetch(base + '/api/admin/settings', { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
});

test('todas las funciones internas del panel exigen sesión (no solo la pantalla)', async () => {
  const PUBLIC = new Set(['/login', '/logout', '/session']);
  const routes = adminRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => [m.toUpperCase(), l.route.path]));
  assert.ok(routes.length >= 25, `se revisaron ${routes.length} rutas`);
  for (const [method, p] of routes) {
    if (PUBLIC.has(p)) continue;
    const url = '/api/admin' + p.replace(/:id/g, '1');
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rucka' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 401, `${method} ${url} sin sesión`);
    const forged = await fetch(base + url, { method, headers: { cookie: 'rm_admin=9999999999999.abc.firmafalsa', 'X-Requested-With': 'rucka' } });
    assert.equal(forged.status, 401, `${method} ${url} con cookie falsificada`);
  }
  // La pantalla del panel se puede abrir, pero no trae datos
  const page = await (await fetch(base + '/caja')).text();
  assert.ok(page.includes('id="login"') && !page.includes('DEMO-'));
  // La carta no enlaza al panel
  const carta = (await (await fetch(base + '/')).text()) + (await (await fetch(base + '/js/menu.js')).text());
  assert.doesNotMatch(carta, /href=["'`][^"'`]*(\/caja|\/admin)/);
  assert.doesNotMatch(carta, /\/api\/admin/);
});

let order1;
test('pedido con dos unidades del mismo sándwich con indicaciones distintas', async () => {
  const ass = product('ASS normal');
  const tomate = ass.ingredients.find((g) => g.name === 'Tomate');
  const mayo = ass.ingredients.find((g) => g.name === 'Mayonesa');
  const bebida = product('Bebida en lata (ejemplo)');
  const order = {
    idempotencyKey: crypto.randomUUID(), customerName: 'Camila', paymentMethod: 'transferencia',
    expectedTotal: ass.price * 2 + bebida.price,
    items: [
      { productId: ass.id, quantity: 1, removedIngredientIds: [tomate.id], note: 'bien tostado' },
      { productId: ass.id, quantity: 1, removedIngredientIds: [mayo.id], note: 'agregar mostaza' },
      { productId: bebida.id, quantity: 1 },
    ],
  };
  const r = await req('POST', '/api/orders', { form: orderForm(order, PNG) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.code, /^DEMO-/);
  // "agregar mostaza" NO suma nada al total
  assert.equal(r.data.total, ass.price * 2 + bebida.price);
  order1 = { ...r.data, order };

  const pub = await req('GET', `/api/orders/${r.data.token}`);
  assert.equal(pub.data.status, 'pendiente');
  assert.equal(pub.data.items.length, 3);
  assert.deepEqual(pub.data.items[0].removed, ['Tomate']);
  assert.equal(pub.data.items[0].note, 'bien tostado');
  assert.deepEqual(pub.data.items[1].removed, ['Mayonesa']);
  assert.equal(pub.data.items[1].note, 'agregar mostaza');

  const list = await req('GET', '/api/admin/orders', { auth: true });
  const o = list.data.orders.find((x) => x.code === r.data.code);
  assert.ok(o.hasNotes && o.receipt && o.isDemo);
  assert.equal(o.items.filter((i) => i.productName === 'ASS normal').length, 2);
});

test('reenviar el mismo pedido no lo duplica', async () => {
  const again = await req('POST', '/api/orders', { form: orderForm(order1.order, PNG) });
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.code, order1.code);
  const list = await req('GET', '/api/admin/orders', { auth: true });
  assert.equal(list.data.orders.filter((x) => x.customerName === 'Camila').length, 1);
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'comprobantes')).length, 1);
});

test('el servidor recalcula precios e ignora precios enviados por el cliente', async () => {
  const p = product('Chorrillana grande');
  const r = await req('POST', '/api/orders', { form: orderForm({ idempotencyKey: crypto.randomUUID(), customerName: 'Tramposo', paymentMethod: 'efectivo', expectedTotal: 1, items: [{ productId: p.id, quantity: 1, price: 1 }] }) });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'PRICE_CHANGED');
  const r2 = await req('POST', '/api/orders', { form: orderForm({ idempotencyKey: crypto.randomUUID(), customerName: 'Sin total', paymentMethod: 'efectivo', items: [{ productId: p.id, quantity: 2, unitPrice: 1 }] }) });
  assert.equal(r2.data.total, p.price * 2);
  // No se puede quitar un ingrediente base
  const base2 = p.ingredients.find((g) => !g.removable);
  const r3 = await req('POST', '/api/orders', { form: orderForm({ idempotencyKey: crypto.randomUUID(), customerName: 'Otro', paymentMethod: 'efectivo', items: [{ productId: p.id, quantity: 1, removedIngredientIds: [base2.id] }] }) });
  assert.equal(r3.status, 409);
});

test('comprobantes privados y validados', async () => {
  const list = await req('GET', '/api/admin/orders', { auth: true });
  const o = list.data.orders.find((x) => x.code === order1.code);
  assert.equal((await req('GET', o.receipt)).status, 401);
  const ok = await fetch(base + o.receipt, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  const file = fs.readdirSync(path.join(process.env.DATA_DIR, 'comprobantes'))[0];
  assert.equal((await fetch(`${base}/comprobantes/${file}`)).status, 404);
  assert.equal((await fetch(`${base}/data/comprobantes/${file}`)).status, 404);
  // Un archivo que no es imagen se rechaza
  const fake = orderForm({ idempotencyKey: crypto.randomUUID(), customerName: 'X y', paymentMethod: 'transferencia', items: [{ productId: product('Fajitas').id, quantity: 1 }] }, Buffer.from('<html>no soy imagen</html>'));
  assert.equal((await req('POST', '/api/orders', { form: fake })).status, 400);
});

test('caja debe revisar indicaciones y verificar el abono antes de preparar', async () => {
  const list = await req('GET', '/api/admin/orders', { auth: true });
  const o = list.data.orders.find((x) => x.code === order1.code);
  const st = (json) => req('POST', `/api/admin/orders/${o.id}/status`, { auth: true, json });
  assert.equal((await st({ status: 'en_preparacion' })).status, 409, 'no se puede saltar a preparación sin pago');
  assert.equal((await st({ status: 'pago_confirmado', bankVerified: true })).data.code, 'NOTES_NOT_REVIEWED');
  assert.equal((await st({ status: 'pago_confirmado', notesReviewed: true })).data.code, 'BANK_NOT_VERIFIED');
  assert.equal((await st({ status: 'pago_confirmado', notesReviewed: true, bankVerified: true })).status, 200);
  assert.equal((await st({ status: 'en_preparacion' })).status, 200);
  assert.equal((await st({ status: 'listo' })).status, 200);
  assert.equal((await st({ status: 'entregado' })).status, 200);
  assert.equal((await req('GET', `/api/orders/${order1.token}`)).data.status, 'entregado');
});

test('indicadores del día separan pedidos reales de demostración', async () => {
  const s = (await req('GET', '/api/admin/stats', { auth: true })).data;
  assert.equal(s.zonaHoraria, 'America/Santiago');
  assert.equal(s.real.pedidosDelDia, 0);
  assert.equal(s.demo.ventasConfirmadas, order1.total);
  assert.equal(s.demo.ticketPromedio, order1.total);
  assert.equal(s.demo.pendientes, 1); // el pedido "Sin total" en efectivo
});

test('extras configurados en administración sí se cobran', async () => {
  const p = product('Quesadillas');
  const put = await req('PUT', `/api/admin/products/${p.id}/extras`, { auth: true, json: { extras: [{ name: 'Extra queso', price: 800 }] } });
  assert.equal(put.status, 200);
  menu = (await req('GET', '/api/menu')).data;
  const q = product('Quesadillas');
  const r = await req('POST', '/api/orders', { form: orderForm({ idempotencyKey: crypto.randomUUID(), customerName: 'Pedro', paymentMethod: 'efectivo', expectedTotal: q.price + 800, items: [{ productId: q.id, quantity: 1, extraIds: [q.extras[0].id] }] }) });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, q.price + 800);
});

test('administración edita precios, desactiva y crea productos', async () => {
  const p = product('Fajitas');
  await req('PATCH', `/api/admin/products/${p.id}`, { auth: true, json: { price: 6100, priceIsTest: false, description: 'Nueva descripción', descriptionProvisional: false } });
  const bebidas = menu.categories.find((c) => c.name === 'Bebidas');
  const lata = product('Bebida en lata (ejemplo)');
  await req('PATCH', `/api/admin/products/${lata.id}`, { auth: true, json: { active: false } });
  const c = await req('POST', '/api/admin/products', { auth: true, json: { categoryId: bebidas.id, name: 'Bebida real 350 ml', price: 1500 } });
  assert.equal(c.status, 201);
  menu = (await req('GET', '/api/menu')).data;
  assert.equal(product('Fajitas').price, 6100);
  assert.equal(product('Fajitas').priceIsTest, false);
  assert.equal(product('Bebida en lata (ejemplo)'), undefined);
  assert.ok(product('Bebida real 350 ml'));
  // Un producto desactivado ya no se puede pedir
  const r = await req('POST', '/api/orders', { form: orderForm({ idempotencyKey: crypto.randomUUID(), customerName: 'Ana', paymentMethod: 'efectivo', items: [{ productId: lata.id, quantity: 1 }] }) });
  assert.equal(r.data.code, 'UNAVAILABLE');
});

test('no se puede salir del modo demostración con datos provisionales', async () => {
  const r = await req('POST', '/api/admin/demo-mode', { auth: true, json: { enabled: false } });
  assert.equal(r.status, 409);
  assert.ok(r.data.blockers.length > 0);
  const qr = await req('GET', '/api/admin/qr?type=final', { auth: true });
  assert.equal(qr.status, 409);
  const qrTest = await req('GET', '/api/admin/qr?type=prueba&base=https://demo.ejemplo.cl', { auth: true });
  assert.equal(qrTest.data.url, 'https://demo.ejemplo.cl/?origen=qr-prueba');
  assert.match(qrTest.data.svg, /^<svg/);
  const png = await fetch(base + qrTest.data.png, { headers: { cookie } });
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition'), /attachment; filename="QR-PRUEBA/);
  assert.equal((await fetch(base + qrTest.data.png)).status, 401);
});

test('día de Chile con cambio de horario', () => {
  // 2026-09-06: Chile pasa a horario de verano (UTC-3). El día anterior es UTC-4.
  const winter = chileDayRange(Date.UTC(2026, 6, 15, 12));
  assert.equal(new Date(winter.start).toISOString(), '2026-07-15T04:00:00.000Z');
  const summer = chileDayRange(Date.UTC(2026, 11, 15, 12));
  assert.equal(new Date(summer.start).toISOString(), '2026-12-15T03:00:00.000Z');
  // Justo antes de medianoche en Chile sigue siendo el mismo día
  const late = chileDayRange(Date.UTC(2026, 11, 16, 2, 59));
  assert.equal(late.label, '15-12-2026');
});
