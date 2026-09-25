'use strict';
// Pedidos ingresados por caja (clientes sin teléfono): mismo sistema que el QR, marcados como "caja".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-mostrador-'));
process.env.ADMIN_PASSWORD = 'clave-mostrador-26';
const { createApp } = require('../server/index.js');
let server, base, cookie, menu;

before(async () => {
  server = createApp().app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'clave-mostrador-26' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  menu = await (await fetch(base + '/api/menu')).json();
});
after(() => server.close());

const H = (name = 'Ana') => ({ cookie, 'X-Requested-With': 'rucka', 'Content-Type': 'application/json', 'X-Staff-Name': encodeURIComponent(name) });
const adm = async (method, url, json, name) => { const r = await fetch(base + '/api/admin' + url, { method, headers: H(name), body: json ? JSON.stringify(json) : undefined }); return { status: r.status, data: await r.json() }; };
const P = (n) => menu.categories.flatMap((c) => c.products).find((p) => p.name === n);
const manual = (extra) => adm('POST', '/orders', { idempotencyKey: crypto.randomUUID(), paymentMethod: 'efectivo', ...extra });

test('crear un pedido en caja exige sesión', async () => {
  const r = await fetch(base + '/api/admin/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rucka' }, body: '{}' });
  assert.equal(r.status, 401);
});

let qrOrder, cajaCash, cajaTransfer;
test('pedido de caja sin nombre, con ingredientes quitados y notas; el servidor calcula el total', async () => {
  await adm('POST', '/shifts/open', { openingCash: 15000, by: 'Ana' });
  const ass = P('ASS normal');
  const sinTomate = ass.ingredients.find((g) => g.name === 'Tomate').id;
  // El navegador manda un precio falso: se ignora (no hay campo de precio) y el total esperado no calza → rechazo
  const bad = await manual({ items: [{ productId: ass.id, quantity: 1, price: 1 }], expectedTotal: 1 });
  assert.equal(bad.status, 409);
  assert.equal(bad.data.code, 'PRICE_CHANGED');
  // Efectivo cobrado en el momento: hay que marcar "recibí el efectivo"
  assert.equal((await manual({ items: [{ productId: ass.id, quantity: 1 }], payNow: true })).status, 400);
  const key = crypto.randomUUID();
  const body = { idempotencyKey: key, paymentMethod: 'efectivo', customerName: '', payNow: true, cashReceived: true, expectedTotal: ass.price * 2,
    items: [{ productId: ass.id, quantity: 1, removedIngredientIds: [sinTomate], note: 'bien tostado' }, { productId: ass.id, quantity: 1, note: 'sin mayo' }] };
  const r = await adm('POST', '/orders', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  cajaCash = r.data.order;
  assert.equal(cajaCash.source, 'caja');
  assert.equal(cajaCash.createdBy, 'Ana');
  assert.equal(cajaCash.customerName, '', 'sin nombre: se identifica por el número');
  assert.match(cajaCash.code, /^DEMO-\d{4}$/);
  assert.equal(cajaCash.status, 'pago_confirmado');
  assert.equal(cajaCash.total, ass.price * 2);
  assert.deepEqual(cajaCash.items.map((i) => [i.removed, i.note]), [[['Tomate'], 'bien tostado'], [[], 'sin mayo']]);
  assert.match(cajaCash.events[0].detail, /Ingresado por caja \(Ana\)/);
  // Doble toque en "Crear pedido": no se duplica
  const again = await adm('POST', '/orders', body);
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.order.id, cajaCash.id);
});

test('transferencia en caja: no se confirma sin verificar el abono en la cuenta', async () => {
  const p = P('Chorrillana chica');
  const noVerif = await manual({ paymentMethod: 'transferencia', customerName: 'Rosa', payNow: true, items: [{ productId: p.id, quantity: 1 }] });
  assert.equal(noVerif.status, 400);
  assert.equal(noVerif.data.code, 'BANK_NOT_VERIFIED');
  // Queda pendiente hasta que caja revise la cuenta
  const pend = await manual({ paymentMethod: 'transferencia', customerName: 'Rosa', items: [{ productId: p.id, quantity: 1 }] });
  assert.equal(pend.status, 201);
  assert.equal(pend.data.order.status, 'pendiente');
  cajaTransfer = pend.data.order;
  const cur = (await adm('GET', '/shifts/current')).data.shift.summary;
  assert.equal(cur.transferencias.confirmadas, 0, 'pendiente no cuenta como transferencia confirmada');
  const ok = await adm('POST', `/orders/${cajaTransfer.id}/status`, { status: 'pago_confirmado', bankVerified: true });
  assert.equal(ok.status, 200);
});

test('un pedido por QR y uno de caja en el mismo turno: cierre separado por origen, sin duplicar ventas', async () => {
  const p = P('Papas fritas medianas');
  const fd = new FormData();
  fd.append('order', JSON.stringify({ idempotencyKey: crypto.randomUUID(), customerName: 'Pedro', paymentMethod: 'efectivo', items: [{ productId: p.id, quantity: 1 }] }));
  const r = await (await fetch(base + '/api/orders', { method: 'POST', body: fd })).json();
  qrOrder = (await adm('GET', '/orders')).data.orders.find((o) => o.code === r.code);
  assert.equal(qrOrder.source, 'qr');
  await adm('POST', `/orders/${qrOrder.id}/status`, { status: 'pago_confirmado', cashReceived: true });

  const list = (await adm('GET', '/orders')).data.orders;
  assert.equal(list.filter((o) => o.id === cajaCash.id).length, 1, 'aparece una sola vez en la lista de pedidos');

  const ass = P('ASS normal').price;
  const chorr = P('Chorrillana chica').price;
  const s = (await adm('POST', '/shifts/close', { countedCash: 15000 + ass * 2 + p.price, by: 'Ana', pendingReviewed: true })).data.shift;
  const sum = s.summary;
  assert.deepEqual(sum.porOrigen.caja, { recibidos: 2, cobrados: 2, efectivo: ass * 2, transferencias: chorr });
  assert.deepEqual(sum.porOrigen.qr, { recibidos: 1, cobrados: 1, efectivo: p.price, transferencias: 0 });
  assert.equal(sum.efectivo.ventas, sum.porOrigen.caja.efectivo + sum.porOrigen.qr.efectivo, 'el total es la suma de ambos orígenes (sin duplicar)');
  assert.equal(sum.transferencias.confirmadas, chorr);
  assert.equal(sum.efectivo.esperado, 15000 + ass * 2 + p.price);
  assert.equal(s.difference, 0);
  assert.deepEqual(sum.cobros.map((c) => c.source).sort(), ['caja', 'caja', 'qr']);

  const k = (await adm('GET', '/stats')).data.demo;
  assert.equal(k.porOrigen.caja.pedidos, 2);
  assert.equal(k.porOrigen.qr.pedidos, 1);
  assert.equal(k.ventasConfirmadas, k.porOrigen.caja.ventas + k.porOrigen.qr.ventas);
});

test('un pedido de caja pasa por preparación como cualquier otro', async () => {
  for (const st of ['en_preparacion', 'listo', 'entregado']) assert.equal((await adm('POST', `/orders/${cajaCash.id}/status`, { status: st })).status, 200);
});
