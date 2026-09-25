'use strict';
// Apertura y cierre de caja: turno completo, cálculo del efectivo esperado, correcciones posteriores,
// separación demostración / real, autorización y persistencia tras reinicio.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PASSWORD = 'clave-caja-turnos-26';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-caja-'));
process.env.ADMIN_PASSWORD = PASSWORD;
const { createApp } = require('../server/index.js');

let app, server, base, cookie, menu;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function start() {
  app = createApp();
  server = app.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  menu = await (await fetch(base + '/api/menu')).json();
}
const stop = () => new Promise((r) => server.close(r));
before(start);
after(stop);

const staff = (name = 'Juan') => ({ cookie, 'X-Requested-With': 'rucka', 'X-Staff-Name': encodeURIComponent(name) });
async function adm(method, url, json, name) {
  const r = await fetch(base + '/api/admin' + url, { method, headers: { ...staff(name), 'Content-Type': 'application/json' }, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, data: await r.json() };
}
const product = (n) => menu.categories.flatMap((c) => c.products).find((p) => p.name === n);
async function order(name, pay, items, receipt) {
  const fd = new FormData();
  fd.append('order', JSON.stringify({ idempotencyKey: crypto.randomUUID(), customerName: name, paymentMethod: pay, items }));
  if (receipt) fd.append('receipt', new Blob([receipt], { type: 'image/png' }), 'c.png');
  const r = await fetch(base + '/api/orders', { method: 'POST', body: fd });
  const d = await r.json();
  const list = (await adm('GET', '/orders')).data.orders;
  return list.find((o) => o.code === d.code);
}
const st = (o, json, name) => adm('POST', `/orders/${o.id}/status`, json, name);

test('solo personal con sesión puede abrir, mover o cerrar caja', async () => {
  for (const [m, u] of [['GET', '/shifts/current'], ['POST', '/shifts/open'], ['POST', '/shifts/movements'], ['POST', '/shifts/close'], ['GET', '/shifts'], ['GET', '/shifts/1']]) {
    const r = await fetch(base + '/api/admin' + u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rucka' }, body: m === 'POST' ? '{"openingCash":1,"by":"x"}' : undefined });
    assert.equal(r.status, 401, `${m} ${u}`);
  }
  // Con sesión pero sin la cabecera anti-CSRF tampoco
  const r = await fetch(base + '/api/admin/shifts/open', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"openingCash":1000,"by":"x"}' });
  assert.equal(r.status, 403);
});

let shiftId, oCash, oTransfer;
test('turno completo: efectivo inicial, venta en efectivo, transferencia confirmada, retiro y conteo con diferencia', async () => {
  // Sin turno no se pueden anotar movimientos
  assert.equal((await adm('POST', '/shifts/movements', { kind: 'retiro', amount: 1000, reason: 'prueba', by: 'Juan' })).status, 409);

  // 1) Apertura con $20.000 para vuelto
  const op = await adm('POST', '/shifts/open', { openingCash: 20000, by: 'Juan' });
  assert.equal(op.status, 201, JSON.stringify(op.data));
  shiftId = op.data.shift.id;
  assert.equal(op.data.shift.isDemo, true, 'en modo demostración el turno es de demostración');
  assert.equal((await adm('POST', '/shifts/open', { openingCash: 5000, by: 'Otro' })).status, 409, 'un solo turno abierto a la vez');

  // 2) Pedido en efectivo: 1 Completo italiano normal ($2.500), cobrado
  oCash = await order('Cliente efectivo', 'efectivo', [{ productId: product('Completo italiano normal').id, quantity: 1 }]);
  assert.equal((await st(oCash, { status: 'pago_confirmado', cashReceived: true })).status, 200);

  // 3) Transferencia con comprobante: 2 ASS normal ($9.000). El comprobante solo NO cuenta.
  oTransfer = await order('Cliente transferencia', 'transferencia', [{ productId: product('ASS normal').id, quantity: 2 }], PNG);
  let cur = (await adm('GET', '/shifts/current')).data.shift.summary;
  assert.equal(cur.transferencias.confirmadas, 0, 'un comprobante adjunto no es una transferencia confirmada');
  assert.equal((await st(oTransfer, { status: 'pago_confirmado', bankVerified: true })).status, 200);

  // Un pedido que queda pendiente y otro rechazado (para los conteos)
  const oPend = await order('Cliente pendiente', 'transferencia', [{ productId: product('Aros de cebolla').id, quantity: 1 }], PNG);
  const oRej = await order('Cliente rechazado', 'efectivo', [{ productId: product('Quesadillas').id, quantity: 1 }]);
  await st(oRej, { status: 'rechazado', reason: 'Producto agotado' });
  // Avanza el de efectivo hasta entregado
  for (const s of ['en_preparacion', 'listo', 'entregado']) await st(oCash, { status: s });

  // 4) Retiro de $5.000 para comprar pan
  const mv = await adm('POST', '/shifts/movements', { kind: 'retiro', amount: 5000, reason: 'Compra de pan en el almacén', by: 'Juan' });
  assert.equal(mv.status, 201, JSON.stringify(mv.data));
  assert.equal((await adm('POST', '/shifts/movements', { kind: 'retiro', amount: 999999, reason: 'demasiado', by: 'Juan' })).status, 409, 'no se retira más de lo que hay');

  cur = (await adm('GET', '/shifts/current')).data.shift.summary;
  assert.deepEqual(cur.pedidos, { recibidos: 4, cobrados: 2, entregados: 1, rechazados: 1, pendientes: 1, enCurso: 1 });
  assert.equal(cur.efectivo.esperado, 20000 + 2500 + 0 - 5000 - 0);
  assert.equal(cur.pendientes[0].code, oPend.code);

  // 5) Cierre: hay un pendiente, hay que confirmar que se revisó
  const noRev = await adm('POST', '/shifts/close', { countedCash: 17000, by: 'Juan' });
  assert.equal(noRev.status, 409);
  assert.equal(noRev.data.code, 'PENDING_NOT_REVIEWED');
  assert.equal(noRev.data.pendientes.length, 1);
  const cl = await adm('POST', '/shifts/close', { countedCash: 17000, by: 'Juan', pendingReviewed: true });
  assert.equal(cl.status, 200, JSON.stringify(cl.data));
  const s = cl.data.shift;
  const e = s.summary.efectivo;

  // Cálculo paso a paso
  const pasos = [
    ['Efectivo inicial', e.inicial, 20000],
    ['+ Ventas cobradas en efectivo', e.ventas, 2500],
    ['+ Ingresos manuales', e.ingresos, 0],
    ['− Retiros manuales', e.retiros, 5000],
    ['− Devoluciones en efectivo', e.devoluciones, 0],
    ['= Efectivo esperado', e.esperado, 17500],
    ['Efectivo contado', s.countedCash, 17000],
    ['Diferencia (contado − esperado)', s.difference, -500],
  ];
  console.log('\n  Cálculo del cierre:');
  for (const [label, got, want] of pasos) { assert.equal(got, want, label); console.log(`    ${label.padEnd(34)} $${got.toLocaleString('es-CL')}`); }
  assert.equal(s.summary.cierre.resultado, 'faltante');
  assert.equal(s.summary.transferencias.confirmadas, 9000, 'transferencias van separadas del efectivo');
  console.log(`    Resultado: FALTANTE de $500 · Transferencias confirmadas (aparte): $${s.summary.transferencias.confirmadas.toLocaleString('es-CL')}\n`);
  assert.equal(s.openedBy, 'Juan');
  assert.equal(s.closedBy, 'Juan');
  assert.ok(s.closedAt >= s.openedAt);
});

test('corregir un pedido después del cierre deja registro y no cambia el cierre guardado', async () => {
  const beforeFix = (await adm('GET', `/shifts/${shiftId}`)).data.shift;
  // María rechaza la transferencia que estaba incluida en el cierre (el banco la revirtió)
  const r = await st(oTransfer, { status: 'rechazado', reason: 'El banco revirtió el abono' }, 'María');
  assert.equal(r.status, 200);
  const d = (await adm('GET', `/shifts/${shiftId}`)).data.shift;
  assert.deepEqual(d.summary, beforeFix.summary, 'la foto del cierre no cambia');
  assert.equal(d.difference, -500);
  assert.equal(d.corrections.length, 1);
  const c = d.corrections[0];
  assert.equal(c.by, 'María');
  assert.equal(c.transferDelta, -9000);
  assert.match(c.detail, /Pago confirmado → Rechazado/);
  assert.ok(c.session.length === 8, 'se guarda la huella de la sesión que hizo el cambio');
  assert.equal(d.current.transferencias.confirmadas, 0, 'las cifras recalculadas hoy se muestran aparte');
});

test('devolución en efectivo al rechazar un pedido ya cobrado', async () => {
  const op = await adm('POST', '/shifts/open', { openingCash: 10000, by: 'María' }, 'María');
  const o = await order('Devuelve', 'efectivo', [{ productId: product('Papas fritas chicas').id, quantity: 1 }]);
  await st(o, { status: 'pago_confirmado', cashReceived: true }, 'María');
  await st(o, { status: 'rechazado', reason: 'Cliente se arrepintió', cashRefunded: true }, 'María');
  const cur = (await adm('GET', '/shifts/current')).data.shift.summary;
  assert.equal(cur.efectivo.ventas, 2000);
  assert.equal(cur.efectivo.devoluciones, 2000);
  assert.equal(cur.efectivo.esperado, 10000, '10.000 + 2.000 − 2.000');
  assert.equal(cur.movimientos.find((m) => m.kind === 'devolucion').by, 'María');
  assert.equal((await adm('POST', '/shifts/close', { countedCash: 10000, by: 'María', pendingReviewed: true })).data.shift.summary.cierre.resultado, 'cuadra');
  void op;
});

test('historial por día (hora de Chile) y turnos numerados', async () => {
  const cur = await adm('GET', '/shifts/current');
  const list = (await adm('GET', `/shifts?date=${cur.data.today}`)).data.shifts;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((s) => s.turno), [1, 2]);
  assert.equal(list[0].difference, -500);
  assert.equal(list[0].corrections, 1);
  assert.equal((await adm('GET', '/shifts?date=2020-01-01')).data.shifts.length, 0);
  assert.equal((await adm('GET', '/shifts?date=ayer')).status, 400);
});

test('los pedidos y turnos de demostración no se mezclan con la operación real', async () => {
  app.settings.set('demo_mode', '0'); // simula operación real (en la app, se exige la lista de revisión)
  try {
    const real = await adm('GET', '/shifts/current');
    assert.equal(real.data.shift, null, 'el turno de demostración no aparece como turno real');
    assert.equal((await adm('GET', `/shifts?date=${real.data.today}`)).data.shifts.length, 0, 'el historial real está vacío');
    const op = await adm('POST', '/shifts/open', { openingCash: 30000, by: 'Juan' });
    assert.equal(op.data.shift.isDemo, false);
    const s = op.data.shift.summary;
    assert.equal(s.pedidos.recibidos, 0, 'no cuenta pedidos de demostración');
    assert.equal(s.pedidos.pendientes, 0);
    assert.equal(s.efectivo.esperado, 30000);
    assert.equal((await adm('POST', '/demo-mode', { enabled: true })).status, 409, 'no se cambia de modo con un turno abierto');
    await adm('POST', '/shifts/close', { countedCash: 30000, by: 'Juan' });
  } finally {
    app.settings.set('demo_mode', '1');
  }
});

test('los cierres sobreviven a un reinicio del servidor (mismo disco de datos)', async () => {
  const today = (await adm('GET', '/shifts/current')).data.today;
  const antes = (await adm('GET', `/shifts/${shiftId}`)).data.shift;
  await stop();
  await start(); // nuevo proceso de la app sobre la misma carpeta de datos (DATA_DIR)
  const despues = (await adm('GET', `/shifts/${shiftId}`)).data.shift;
  assert.deepEqual(despues.summary, antes.summary);
  assert.equal(despues.corrections.length, 1);
  assert.equal((await adm('GET', `/shifts?date=${today}`)).data.shifts.length, 2);
});
