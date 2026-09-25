'use strict';
// Apertura y cierre de caja (turnos).
// - Un turno se abre con el efectivo inicial para vuelto. Solo puede haber un turno abierto a la vez
//   (por separado para demostración y operación real).
// - Un cobro pertenece al turno que estaba abierto cuando caja confirmó el pago (orders.paid_shift_id).
//   Un comprobante adjunto NO es un cobro: solo cuenta cuando caja marca "verifiqué el abono".
// - Ingresos, retiros y devoluciones de efectivo se anotan con monto, motivo, hora y responsable.
// - Al cerrar se guarda una "foto" (snapshot) inmutable de todas las cifras. Si después se corrige un
//   pedido de ese turno, el cierre NO se modifica: se agrega una corrección con quién, cuándo y cuánto.
const { OrderError } = require('./orders');
const { chileDateRange, chileDateStr } = require('./time');

const MAX_AMOUNT = 10_000_000;
const LABEL = { pendiente: 'Pendiente', pago_confirmado: 'Pago confirmado', en_preparacion: 'En preparación', listo: 'Listo', entregado: 'Entregado', rechazado: 'Rechazado' };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cash_shifts (
      id INTEGER PRIMARY KEY,
      is_demo INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto','cerrado')),
      opened_at INTEGER NOT NULL,
      opened_by TEXT NOT NULL,
      opening_cash INTEGER NOT NULL CHECK (opening_cash >= 0),
      closed_at INTEGER,
      closed_by TEXT,
      counted_cash INTEGER,
      expected_cash INTEGER,
      difference INTEGER,
      close_note TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON cash_shifts(is_demo) WHERE status = 'abierto';

    CREATE TABLE IF NOT EXISTS cash_movements (
      id INTEGER PRIMARY KEY,
      shift_id INTEGER NOT NULL REFERENCES cash_shifts(id),
      kind TEXT NOT NULL CHECK (kind IN ('ingreso','retiro','devolucion','devolucion_transferencia')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      reason TEXT NOT NULL,
      order_id INTEGER,
      order_code TEXT,
      by_name TEXT NOT NULL,
      by_session TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shift_corrections (
      id INTEGER PRIMARY KEY,
      shift_id INTEGER NOT NULL REFERENCES cash_shifts(id),
      order_id INTEGER,
      order_code TEXT,
      detail TEXT NOT NULL,
      cash_delta INTEGER NOT NULL DEFAULT 0,
      transfer_delta INTEGER NOT NULL DEFAULT 0,
      by_name TEXT NOT NULL,
      by_session TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
  `);
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('paid_shift_id')) db.exec('ALTER TABLE orders ADD COLUMN paid_shift_id INTEGER');
}

function money(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT) throw new OrderError(400, 'BAD_AMOUNT', `${field}: escribe un monto en pesos, sin puntos (ej.: 20000)`);
  return n;
}

function createShifts(db, { isDemo }) {
  migrate(db);
  const openShift = (demo = isDemo()) => db.prepare("SELECT * FROM cash_shifts WHERE status = 'abierto' AND is_demo = ?").get(demo ? 1 : 0);
  const getShift = (id) => db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(id);

  // Cifras de un turno calculadas desde los pedidos y movimientos guardados.
  function summarize(shift, until = shift.closed_at || Date.now()) {
    const demo = shift.is_demo;
    const from = shift.opened_at;
    const paid = db.prepare(`SELECT id, code, customer_name, payment_method, total, status, paid_at, source FROM orders
                             WHERE paid_shift_id = ? ORDER BY paid_at`).all(shift.id);
    const cashOrders = paid.filter((o) => o.payment_method === 'efectivo');
    // Efectivo: todo lo cobrado entró a la caja (si luego se devuelve, se anota como devolución).
    // Transferencias: si el pedido se rechazó después, el abono se revirtió o devolvió y no se cuenta.
    const transferOrders = paid.filter((o) => o.payment_method === 'transferencia' && o.status !== 'rechazado');
    const sum = (arr) => arr.reduce((s, o) => s + o.total, 0);
    const moves = db.prepare('SELECT * FROM cash_movements WHERE shift_id = ? ORDER BY at, id').all(shift.id);
    const mv = (k) => moves.filter((m) => m.kind === k).reduce((s, m) => s + m.amount, 0);
    const countEvents = (status) => db.prepare(`SELECT COUNT(DISTINCT e.order_id) AS n FROM order_events e JOIN orders o ON o.id = e.order_id
                                                WHERE o.is_demo = ? AND e.status = ? AND e.at >= ? AND e.at < ?`).get(demo, status, from, until + 1).n;
    const received = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE is_demo = ? AND created_at >= ? AND created_at < ?').get(demo, from, until + 1).n;
    const pendingList = db.prepare(`SELECT id, code, customer_name, payment_method, total, created_at, source, receipt_file IS NOT NULL AS has_receipt
                                    FROM orders WHERE is_demo = ? AND status = 'pendiente' ORDER BY created_at`).all(demo)
      .map((o) => ({ id: o.id, code: o.code, customerName: o.customer_name, paymentMethod: o.payment_method, total: o.total, createdAt: o.created_at, receiptAttached: !!o.has_receipt, source: o.source || 'qr' }));
    const inProgress = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE is_demo = ? AND status IN ('pago_confirmado','en_preparacion','listo')`).get(demo).n;

    const cashSales = sum(cashOrders);
    // Por origen: QR (el cliente desde la carta) o ingresado por caja. Suman lo mismo que los totales.
    const receivedBy = (src) => db.prepare('SELECT COUNT(*) AS n FROM orders WHERE is_demo = ? AND source = ? AND created_at >= ? AND created_at < ?').get(demo, src, from, until + 1).n;
    const porOrigen = Object.fromEntries(['qr', 'caja'].map((src) => [src, {
      recibidos: receivedBy(src),
      cobrados: paid.filter((o) => (o.source || 'qr') === src).length,
      efectivo: sum(cashOrders.filter((o) => (o.source || 'qr') === src)),
      transferencias: sum(transferOrders.filter((o) => (o.source || 'qr') === src)),
    }]));
    const ingresos = mv('ingreso');
    const retiros = mv('retiro');
    const devoluciones = mv('devolucion');
    const expected = shift.opening_cash + cashSales + ingresos - retiros - devoluciones;
    return {
      pedidos: { recibidos: received, cobrados: paid.length, entregados: countEvents('entregado'), rechazados: countEvents('rechazado'), pendientes: pendingList.length, enCurso: inProgress },
      efectivo: { inicial: shift.opening_cash, ventas: cashSales, ventasCantidad: cashOrders.length, ingresos, retiros, devoluciones, esperado: expected },
      transferencias: { confirmadas: sum(transferOrders), cantidad: transferOrders.length, devueltas: mv('devolucion_transferencia') },
      porOrigen,
      cobros: paid.map((o) => ({ id: o.id, code: o.code, customerName: o.customer_name, paymentMethod: o.payment_method, total: o.total, paidAt: o.paid_at, status: o.status, source: o.source || 'qr' })),
      movimientos: moves.map((m) => ({ id: m.id, kind: m.kind, amount: m.amount, reason: m.reason, orderCode: m.order_code, by: m.by_name, session: m.by_session, at: m.at })),
      pendientes: pendingList,
    };
  }

  function view(shift, { live = false } = {}) {
    if (!shift) return null;
    const base = {
      id: shift.id, isDemo: !!shift.is_demo, status: shift.status, date: chileDateStr(shift.opened_at),
      openedAt: shift.opened_at, openedBy: shift.opened_by, openingCash: shift.opening_cash,
      closedAt: shift.closed_at, closedBy: shift.closed_by, countedCash: shift.counted_cash,
      expectedCash: shift.expected_cash, difference: shift.difference, closeNote: shift.close_note,
    };
    const corrections = db.prepare('SELECT * FROM shift_corrections WHERE shift_id = ? ORDER BY at, id').all(shift.id)
      .map((c) => ({ id: c.id, orderCode: c.order_code, detail: c.detail, cashDelta: c.cash_delta, transferDelta: c.transfer_delta, by: c.by_name, session: c.by_session, at: c.at }));
    if (shift.status === 'abierto') return { ...base, summary: summarize(shift), corrections };
    const snapshot = JSON.parse(shift.snapshot_json);
    return { ...base, summary: snapshot, corrections, current: live && corrections.length ? summarize(shift) : undefined };
  }

  function open({ openingCash, by, session }) {
    const name = clean(by, 40);
    if (name.length < 2) throw new OrderError(400, 'NAME', 'Escribe el nombre de quien abre la caja');
    const cash = money(openingCash, 'Efectivo inicial');
    if (openShift()) throw new OrderError(409, 'ALREADY_OPEN', 'Ya hay un turno abierto. Ciérralo antes de abrir otro.');
    const id = Number(db.prepare('INSERT INTO cash_shifts (is_demo, opened_at, opened_by, opening_cash) VALUES (?, ?, ?, ?)')
      .run(isDemo() ? 1 : 0, Date.now(), name, cash).lastInsertRowid);
    void session;
    return view(getShift(id));
  }

  function addMovement({ kind, amount, reason, by, session }) {
    const shift = openShift();
    if (!shift) throw new OrderError(409, 'NO_SHIFT', 'No hay un turno abierto. Abre la caja primero.');
    if (!['ingreso', 'retiro'].includes(kind)) throw new OrderError(400, 'BAD_KIND', 'Tipo de movimiento inválido');
    const amt = money(amount, 'Monto');
    if (amt <= 0) throw new OrderError(400, 'BAD_AMOUNT', 'El monto debe ser mayor que cero');
    const why = clean(reason, 120);
    if (why.length < 3) throw new OrderError(400, 'REASON', 'Escribe el motivo');
    const name = clean(by, 40);
    if (name.length < 2) throw new OrderError(400, 'NAME', 'Escribe quién hace el movimiento');
    if (kind === 'retiro') {
      const s = summarize(shift);
      if (amt > s.efectivo.esperado) throw new OrderError(409, 'NOT_ENOUGH', `No puede retirarse más que el efectivo esperado en caja (${s.efectivo.esperado})`);
    }
    db.prepare('INSERT INTO cash_movements (shift_id, kind, amount, reason, by_name, by_session, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(shift.id, kind, amt, why, name, session || '', Date.now());
    return view(getShift(shift.id));
  }

  function close({ countedCash, by, session, pendingReviewed, note }) {
    const shift = openShift();
    if (!shift) throw new OrderError(409, 'NO_SHIFT', 'No hay un turno abierto.');
    const name = clean(by, 40);
    if (name.length < 2) throw new OrderError(400, 'NAME', 'Escribe el nombre de quien cierra la caja');
    const counted = money(countedCash, 'Efectivo contado');
    const now = Date.now();
    const snap = summarize(shift, now);
    if (snap.pendientes.length && pendingReviewed !== true) {
      throw new OrderError(409, 'PENDING_NOT_REVIEWED', `Hay ${snap.pendientes.length} pedido(s) pendiente(s). Revísalos y confirma antes de cerrar.`, { pendientes: snap.pendientes });
    }
    const expected = snap.efectivo.esperado;
    const diff = counted - expected;
    snap.cierre = { contado: counted, esperado: expected, diferencia: diff, resultado: diff === 0 ? 'cuadra' : diff > 0 ? 'sobrante' : 'faltante' };
    db.prepare(`UPDATE cash_shifts SET status = 'cerrado', closed_at = ?, closed_by = ?, counted_cash = ?, expected_cash = ?, difference = ?,
                close_note = ?, snapshot_json = ? WHERE id = ? AND status = 'abierto'`)
      .run(now, name, counted, expected, diff, clean(note, 300), JSON.stringify(snap), shift.id);
    void session;
    return view(getShift(shift.id));
  }

  // Antes de cambiar el estado de un pedido: valida lo que necesita un turno (devolución en efectivo).
  function beforeStatusChange(order, body) {
    if (body?.status === 'rechazado' && order.paid_at && order.payment_method === 'efectivo' && body.cashRefunded === true && !openShift(!!order.is_demo)) {
      throw new OrderError(409, 'NO_SHIFT', 'Para registrar la devolución en efectivo debe haber un turno de caja abierto.');
    }
  }

  // Después de cambiar el estado: asigna el cobro al turno abierto, registra devoluciones y, si el
  // pedido pertenece a un turno ya cerrado, deja una corrección (el cierre guardado no se toca).
  function afterStatusChange(before, after, body, actor) {
    const now = Date.now();
    const demo = !!after.is_demo;
    if (after.status === 'pago_confirmado' && before.status === 'pendiente') {
      const s = openShift(demo);
      db.prepare('UPDATE orders SET paid_shift_id = ? WHERE id = ?').run(s ? s.id : null, after.id);
    }
    if (after.status === 'pendiente' && before.status === 'rechazado') {
      db.prepare('UPDATE orders SET paid_shift_id = NULL WHERE id = ?').run(after.id);
    }
    if (after.status === 'rechazado' && before.paid_at) {
      const s = openShift(demo);
      if (s && body?.cashRefunded === true && after.payment_method === 'efectivo') {
        db.prepare(`INSERT INTO cash_movements (shift_id, kind, amount, reason, order_id, order_code, by_name, by_session, at)
                    VALUES (?, 'devolucion', ?, ?, ?, ?, ?, ?, ?)`).run(s.id, after.total, `Devolución por rechazo: ${clean(body.reason, 80) || 'sin motivo'}`, after.id, after.code, actor.name, actor.session, now);
      }
      if (s && body?.transferRefunded === true && after.payment_method === 'transferencia') {
        db.prepare(`INSERT INTO cash_movements (shift_id, kind, amount, reason, order_id, order_code, by_name, by_session, at)
                    VALUES (?, 'devolucion_transferencia', ?, ?, ?, ?, ?, ?, ?)`).run(s.id, after.total, `Transferencia devuelta: ${clean(body.reason, 80) || 'sin motivo'}`, after.id, after.code, actor.name, actor.session, now);
      }
    }
    // Correcciones posteriores al cierre: solo rechazos y reaperturas (entregar o preparar después es el flujo normal)
    if (!['rechazado', 'pendiente'].includes(after.status)) return;
    const paidShift = before.paid_shift_id ? getShift(before.paid_shift_id) : null;
    const createdIn = db.prepare("SELECT * FROM cash_shifts WHERE status = 'cerrado' AND is_demo = ? AND opened_at <= ? AND closed_at >= ?").all(demo ? 1 : 0, before.created_at, before.created_at);
    const affected = new Map();
    if (paidShift && paidShift.status === 'cerrado') affected.set(paidShift.id, paidShift);
    for (const s of createdIn) affected.set(s.id, s);
    for (const s of affected.values()) {
      const moneyOut = paidShift && s.id === paidShift.id && ['rechazado', 'pendiente'].includes(after.status);
      const cashDelta = moneyOut && after.payment_method === 'efectivo' ? -after.total : 0;
      const transferDelta = moneyOut && after.payment_method === 'transferencia' ? -after.total : 0;
      const detail = `Pedido ${after.code}: ${LABEL[before.status]} → ${LABEL[after.status]}${after.status === 'rechazado' ? ` (motivo: ${clean(body?.reason, 80) || 'sin motivo'})` : ''}${moneyOut ? '. Este cobro estaba incluido en el cierre.' : ''}`;
      db.prepare(`INSERT INTO shift_corrections (shift_id, order_id, order_code, detail, cash_delta, transfer_delta, by_name, by_session, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, after.id, after.code, detail, cashDelta, transferDelta, actor.name, actor.session, now);
    }
  }

  function listByDate(dateStr, demo) {
    const r = chileDateRange(dateStr);
    if (!r) throw new OrderError(400, 'BAD_DATE', 'Fecha inválida');
    const rows = db.prepare('SELECT * FROM cash_shifts WHERE is_demo = ? AND opened_at >= ? AND opened_at < ? ORDER BY opened_at').all(demo ? 1 : 0, r.start, r.end);
    return rows.map((s, i) => {
      const nCorr = db.prepare('SELECT COUNT(*) AS n FROM shift_corrections WHERE shift_id = ?').get(s.id).n;
      return { id: s.id, turno: i + 1, status: s.status, openedAt: s.opened_at, openedBy: s.opened_by, closedAt: s.closed_at, closedBy: s.closed_by, expectedCash: s.expected_cash, countedCash: s.counted_cash, difference: s.difference, corrections: nCorr, isDemo: !!s.is_demo };
    });
  }

  function purgeDemo() {
    const ids = db.prepare('SELECT id FROM cash_shifts WHERE is_demo = 1').all().map((r) => r.id);
    for (const id of ids) {
      db.prepare('DELETE FROM cash_movements WHERE shift_id = ?').run(id);
      db.prepare('DELETE FROM shift_corrections WHERE shift_id = ?').run(id);
    }
    db.prepare('DELETE FROM cash_shifts WHERE is_demo = 1').run();
    return ids.length;
  }

  return { openShift, getShift, view, open, addMovement, close, beforeStatusChange, afterStatusChange, listByDate, purgeDemo };
}

module.exports = { createShifts };
