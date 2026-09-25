'use strict';
// Creación de pedidos: validación y recálculo de precios SIEMPRE en el servidor.
// El cliente solo envía qué producto, cuántas unidades, qué quitar, qué extras y la nota.
const crypto = require('node:crypto');

const MAX_LINES = 40;
const MAX_QTY = 20;
const MAX_NOTE = 140;

class OrderError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const intIds = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);

function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new OrderError(400, 'BAD_REQUEST', 'Pedido inválido');
  const key = String(raw.idempotencyKey || '');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) throw new OrderError(400, 'BAD_REQUEST', 'Falta el identificador del pedido');
  const customerName = clean(raw.customerName, 40);
  if (customerName.length < 2) throw new OrderError(400, 'NAME_REQUIRED', 'Escribe tu nombre para el pedido');
  const paymentMethod = raw.paymentMethod;
  if (!['efectivo', 'transferencia'].includes(paymentMethod)) throw new OrderError(400, 'BAD_PAYMENT', 'Elige efectivo o transferencia');
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new OrderError(400, 'EMPTY', 'El carrito está vacío');
  if (raw.items.length > MAX_LINES) throw new OrderError(400, 'TOO_MANY', 'Demasiadas líneas en el pedido');
  const items = raw.items.map((it) => {
    const quantity = Number(it?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) throw new OrderError(400, 'BAD_QTY', `Cantidad inválida (máximo ${MAX_QTY} por línea)`);
    return {
      productId: Number(it.productId),
      quantity,
      removedIngredientIds: intIds(it.removedIngredientIds),
      extraIds: intIds(it.extraIds),
      note: clean(it.note, MAX_NOTE),
    };
  });
  const expectedTotal = raw.expectedTotal == null ? null : Number(raw.expectedTotal);
  return { key, customerName, paymentMethod, items, expectedTotal };
}

function priceItems(db, items) {
  const getP = db.prepare(`SELECT p.*, c.active AS cat_active FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?`);
  const getIng = db.prepare('SELECT id, name, removable FROM ingredients WHERE product_id = ?');
  const getEx = db.prepare('SELECT id, name, price, active FROM extras WHERE product_id = ?');
  return items.map((it) => {
    const p = getP.get(it.productId);
    if (!p || !p.active || !p.cat_active) throw new OrderError(409, 'UNAVAILABLE', `Un producto del carrito ya no está disponible`, { productId: it.productId });
    const ings = new Map(getIng.all(p.id).map((g) => [g.id, g]));
    const removed = it.removedIngredientIds.map((id) => {
      const g = ings.get(id);
      if (!g || !g.removable) throw new OrderError(409, 'MENU_CHANGED', `Los ingredientes de "${p.name}" cambiaron. Revisa el carrito.`, { productId: p.id });
      return g.name;
    });
    const exMap = new Map(getEx.all(p.id).map((e) => [e.id, e]));
    const extras = it.extraIds.map((id) => {
      const e = exMap.get(id);
      if (!e || !e.active) throw new OrderError(409, 'MENU_CHANGED', `Los extras de "${p.name}" cambiaron. Revisa el carrito.`, { productId: p.id });
      return { name: e.name, price: e.price };
    });
    const unit = p.price + extras.reduce((s, e) => s + e.price, 0);
    return { productId: p.id, name: p.name, unit, quantity: it.quantity, removed, extras, note: it.note, lineTotal: unit * it.quantity };
  });
}

function payloadHash(o) {
  return crypto.createHash('sha256').update(JSON.stringify([o.customerName, o.paymentMethod, o.items])).digest('hex');
}

function createOrder(db, settings, raw, receipt) {
  const o = normalize(raw);
  const hash = payloadHash(o);

  // Evita pedidos duplicados: el mismo identificador devuelve el pedido ya creado.
  const existing = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(o.key);
  if (existing) {
    if (existing.payload_hash !== hash) throw new OrderError(409, 'KEY_REUSED', 'Este pedido ya fue enviado con otro contenido');
    return { order: existing, duplicate: true };
  }

  const lines = priceItems(db, o.items);
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  if (o.expectedTotal != null && o.expectedTotal !== total) {
    throw new OrderError(409, 'PRICE_CHANGED', 'Los precios cambiaron desde que abriste la carta. Revisa el carrito antes de enviar.', { total });
  }
  const hasNotes = lines.some((l) => l.note || l.removed.length) ? 1 : 0;
  const isDemo = settings.get('demo_mode') === '1' ? 1 : 0;
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const n = Number(settings.get('order_counter') || 0) + 1;
    settings.set('order_counter', String(n));
    const code = (isDemo ? 'DEMO-' : 'RM-') + String(n).padStart(4, '0');
    const token = crypto.randomBytes(18).toString('base64url');
    const { lastInsertRowid: orderId } = db.prepare(`
      INSERT INTO orders (code, public_token, idempotency_key, payload_hash, customer_name, payment_method, total,
                          has_notes, receipt_file, receipt_mime, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      code, token, o.key, hash, o.customerName, o.paymentMethod, total, hasNotes,
      receipt?.file ?? null, receipt?.mime ?? null, isDemo, now, now);
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, removed_json, extras_json, note, line_total, sort)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((l, idx) => insItem.run(orderId, l.productId, l.name, l.unit, l.quantity, JSON.stringify(l.removed), JSON.stringify(l.extras), l.note, l.lineTotal, idx));
    db.prepare('INSERT INTO order_events (order_id, status, detail, at) VALUES (?, ?, ?, ?)').run(orderId, 'pendiente', 'Pedido recibido', now);
    db.exec('COMMIT');
    return { order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId), duplicate: false };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function itemsOf(db, orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort').all(orderId).map((r) => ({
    productName: r.product_name,
    unitPrice: r.unit_price,
    quantity: r.quantity,
    removed: JSON.parse(r.removed_json),
    extras: JSON.parse(r.extras_json),
    note: r.note,
    lineTotal: r.line_total,
  }));
}

// Flujo de estados. Solo caja puede moverlos.
const TRANSITIONS = {
  pendiente: ['pago_confirmado', 'rechazado'],
  pago_confirmado: ['en_preparacion', 'rechazado'],
  en_preparacion: ['listo', 'rechazado'],
  listo: ['entregado'],
  entregado: [],
  rechazado: ['pendiente'],
};

function changeStatus(db, id, body) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new OrderError(404, 'NOT_FOUND', 'Pedido no encontrado');
  const next = body?.status;
  if (!(TRANSITIONS[order.status] || []).includes(next)) {
    throw new OrderError(409, 'BAD_TRANSITION', `No se puede pasar de "${order.status}" a "${next}"`);
  }
  let detail = '';
  const now = Date.now();
  if (next === 'pago_confirmado') {
    if (order.has_notes && !order.notes_reviewed && body.notesReviewed !== true) {
      throw new OrderError(409, 'NOTES_NOT_REVIEWED', 'Revisa las indicaciones del pedido antes de confirmarlo');
    }
    if (order.payment_method === 'transferencia' && body.bankVerified !== true) {
      throw new OrderError(409, 'BANK_NOT_VERIFIED', 'Confirma que verificaste el abono en la cuenta bancaria. El comprobante por sí solo no confirma el pago.');
    }
    if (order.payment_method === 'efectivo' && body.cashReceived !== true) {
      throw new OrderError(409, 'CASH_NOT_RECEIVED', 'Confirma que recibiste el efectivo');
    }
    detail = order.payment_method === 'transferencia' ? 'Abono verificado en la cuenta bancaria' : 'Efectivo recibido';
  }
  if (next === 'rechazado') detail = clean(body.reason, 200) || 'Rechazado por caja';
  if (next === 'pendiente') detail = 'Reabierto por caja';
  db.prepare(`UPDATE orders SET status = ?, updated_at = ?,
                notes_reviewed = CASE WHEN ? THEN 1 ELSE notes_reviewed END,
                paid_at = CASE WHEN ? = 'pago_confirmado' THEN ? WHEN ? = 'pendiente' THEN NULL ELSE paid_at END
              WHERE id = ?`).run(next, now, next === 'pago_confirmado' ? 1 : 0, next, now, next, id);
  db.prepare('INSERT INTO order_events (order_id, status, detail, at) VALUES (?, ?, ?, ?)').run(id, next, detail, now);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

module.exports = { createOrder, itemsOf, changeStatus, OrderError, TRANSITIONS };
