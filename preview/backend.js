'use strict';
// VISTA PREVIA en claude.ai: reemplaza el servidor Node por la base de datos compartida del Artifact.
// Implementa las mismas rutas /api/... que usa la carta y el panel, para reutilizar su código tal cual.
// IMPORTANTE: aquí la lógica corre en el navegador. Sirve para probar la experiencia; la protección
// real (contraseña, comprobantes privados, recálculo en servidor) está en la versión Node (carpeta server/).
const RMPreview = (() => {
  let db = null;
  let assets = null;
  let user = null;
  let catalog = null;   // { nextId, categories, products }
  let settings = null;  // { key: value }
  const orders = new Map();
  let ready;
  const listeners = new Set();

  const ILLUS = window.RM_ILLUSTRATIONS || {};
  const TZ = 'America/Santiago';

  class ApiError extends Error {
    constructor(status, message, data = {}) { super(message); this.status = status; this.data = { error: message, ...data }; }
  }
  const E = (status, code, message, extra = {}) => new ApiError(status, message, { code, ...extra });

  // ---------------- Zona horaria de Chile (misma lógica que server/time.js) ----------------
  const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function parts(ms) { const o = {}; for (const p of partsFmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value); return o; }
  function offsetAt(ms) { const p = parts(ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; }
  function localMidnight(y, m, d) { const g = Date.UTC(y, m - 1, d); let t = g - offsetAt(g); t = g - offsetAt(t); return t; }
  function chileDayRange(ms = Date.now()) {
    const p = parts(ms);
    const start = localMidnight(p.year, p.month, p.day);
    const n = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    return { start, end: localMidnight(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()), label: `${String(p.day).padStart(2, '0')}-${String(p.month).padStart(2, '0')}-${p.year}` };
  }

  // ---------------- Conexión con la base compartida ----------------
  async function init() {
    if (ready) return ready;
    ready = (async () => {
      const c = window.claude;
      if (!c?.use) throw new Error('Esta vista previa debe abrirse desde claude.ai');
      [db, assets, user] = await Promise.all([c.use('db'), c.use('assets'), c.use('user')]);
      if (!db) throw new Error('La base de datos compartida no está disponible en esta vista');
      // Primero una lectura normal (la página funciona aunque falle lo "en vivo");
      // después, suscripción en vivo, y si la plataforma la rechaza, consulta periódica.
      await Promise.all([
        watch(db.doc('menu/catalog'), (s) => { catalog = s.exists ? structuredClone(s.data()) : null; }, 15000),
        watch(db.doc('menu/settings'), (s) => { settings = s.exists ? { ...s.data() } : {}; }, 15000),
        watch(db.collection('orders'), (snap) => {
          orders.clear();
          for (const d of snap.docs) orders.set(d.id, d.data());
        }, 4000),
      ]);
    })();
    return ready;
  }
  let liveErrors = 0;
  async function watch(ref, apply, pollMs) {
    const run = (snap) => { apply(snap); notify(); };
    let first = null;
    for (let i = 0; i < 3 && !first; i++) {
      try { first = await ref.get(); } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
    }
    run(first);
    let timer = null;
    const poll = () => {
      if (timer) return;
      timer = setInterval(async () => {
        if (document.hidden) return;
        try { run(await ref.get()); } catch { /* reintenta en la próxima vuelta */ }
      }, pollMs);
    };
    try {
      ref.onSnapshot(run, (e) => { liveErrors++; console.warn('Actualización en vivo no disponible, se consulta cada', pollMs, 'ms', e?.code, e?.message); poll(); });
    } catch (e) {
      liveErrors++;
      poll();
    }
  }
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch { /* */ } });
  const onChange = (fn) => listeners.add(fn);

  async function canCashier() {
    if (!user) return true; // sin información del visor: se permite (solo vista previa)
    return (await user.isOwner()) || (await user.canEdit());
  }

  // ---------------- Ayudas de catálogo ----------------
  const needCatalog = () => { if (!catalog) throw E(503, 'NO_DATA', 'La carta aún no tiene datos cargados'); return catalog; };
  const isDemo = () => (settings?.demo_mode ?? '1') === '1';
  const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const intIds = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const sortBy = (a, b) => (a.sort - b.sort) || (a.id - b.id);

  function productImage(p) {
    if (p.photo) return { image: `/_blob/${p.photo}`, imageKind: 'foto' };
    if (p.illustration && ILLUS[p.illustration]) return { image: ILLUS[p.illustration], imageKind: 'ilustracion' };
    return { image: null, imageKind: null };
  }
  function catalogView(includeInactive) {
    const cat = needCatalog();
    return cat.categories.filter((c) => includeInactive || c.active).sort(sortBy).map((c) => ({
      id: c.id, name: c.name, active: c.active, sort: c.sort,
      products: cat.products.filter((p) => p.categoryId === c.id && (includeInactive || p.active)).sort(sortBy).map((p) => ({
        ...p, hasPhoto: !!p.photo, ...productImage(p),
        extras: p.extras.filter((e) => includeInactive || e.active),
      })),
    }));
  }
  async function saveCatalog(mutate) {
    const next = structuredClone(needCatalog());
    const out = mutate(next);
    await db.doc('menu/catalog').set(next);
    catalog = next;
    return out;
  }
  const findProduct = (cat, id) => { const p = cat.products.find((x) => x.id === Number(id)); if (!p) throw E(404, 'NOT_FOUND', 'Producto no encontrado'); return p; };
  const str = (v, max, field) => { const s = String(v ?? '').trim().slice(0, max); if (!s) throw E(400, 'BAD_REQUEST', `Falta ${field}`); return s; };
  const price = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw E(400, 'BAD_REQUEST', 'Precio inválido (entero en pesos, sin puntos)'); return n; };

  // ---------------- Pedidos (misma lógica que server/orders.js) ----------------
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw E(400, 'BAD_REQUEST', 'Pedido inválido');
    const key = String(raw.idempotencyKey || '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) throw E(400, 'BAD_REQUEST', 'Falta el identificador del pedido');
    const customerName = clean(raw.customerName, 40);
    if (customerName.length < 2) throw E(400, 'NAME_REQUIRED', 'Escribe tu nombre para el pedido');
    if (!['efectivo', 'transferencia'].includes(raw.paymentMethod)) throw E(400, 'BAD_PAYMENT', 'Elige efectivo o transferencia');
    if (!Array.isArray(raw.items) || !raw.items.length) throw E(400, 'EMPTY', 'El carrito está vacío');
    if (raw.items.length > 40) throw E(400, 'TOO_MANY', 'Demasiadas líneas en el pedido');
    const items = raw.items.map((it) => {
      const quantity = Number(it?.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw E(400, 'BAD_QTY', 'Cantidad inválida (máximo 20 por línea)');
      return { productId: Number(it.productId), quantity, removedIngredientIds: intIds(it.removedIngredientIds), extraIds: intIds(it.extraIds), note: clean(it.note, 140) };
    });
    return { key, customerName, paymentMethod: raw.paymentMethod, items, expectedTotal: raw.expectedTotal == null ? null : Number(raw.expectedTotal) };
  }
  function priceItems(items) {
    const cat = needCatalog();
    return items.map((it) => {
      const p = cat.products.find((x) => x.id === it.productId);
      const c = p && cat.categories.find((x) => x.id === p.categoryId);
      if (!p || !p.active || !c?.active) throw E(409, 'UNAVAILABLE', 'Un producto del carrito ya no está disponible');
      const removed = it.removedIngredientIds.map((id) => {
        const g = p.ingredients.find((x) => x.id === id);
        if (!g || !g.removable) throw E(409, 'MENU_CHANGED', `Los ingredientes de "${p.name}" cambiaron. Revisa el carrito.`);
        return g.name;
      });
      const extras = it.extraIds.map((id) => {
        const e = p.extras.find((x) => x.id === id);
        if (!e || !e.active) throw E(409, 'MENU_CHANGED', `Los extras de "${p.name}" cambiaron. Revisa el carrito.`);
        return { name: e.name, price: e.price };
      });
      const unit = p.price + extras.reduce((s, e) => s + e.price, 0);
      return { productName: p.name, unitPrice: unit, quantity: it.quantity, removed, extras, note: it.note, lineTotal: unit * it.quantity };
    });
  }
  const payloadHash = (o) => JSON.stringify([o.customerName, o.paymentMethod, o.items]);

  async function createOrder(fd) {
    let raw;
    try { raw = JSON.parse(fd.get('order') || 'null'); } catch { throw E(400, 'BAD_REQUEST', 'Pedido inválido'); }
    const o = normalize(raw);
    const hash = payloadHash(o);
    const ref = db.doc(`orders/${o.key}`);
    const existing = orders.get(o.key) || (await ref.get()).data?.();
    if (existing) {
      if (existing.payloadHash !== hash) throw E(409, 'KEY_REUSED', 'Este pedido ya fue enviado con otro contenido');
      return { status: 200, body: { code: existing.code, token: existing.token, total: existing.total, duplicate: true } };
    }
    const items = priceItems(o.items);
    const total = items.reduce((s, l) => s + l.lineTotal, 0);
    if (o.expectedTotal != null && o.expectedTotal !== total) throw E(409, 'PRICE_CHANGED', 'Los precios cambiaron desde que abriste la carta. Revisa el carrito antes de enviar.', { total });

    let receiptId = null;
    const file = fd.get('receipt');
    if (file && file.size) {
      if (o.paymentMethod !== 'transferencia') throw E(400, 'BAD_REQUEST', 'El comprobante solo aplica a transferencias');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw E(400, 'BAD_IMAGE', 'La imagen debe ser JPG, PNG o WEBP');
      if (file.size > 8 * 1024 * 1024) throw E(400, 'BAD_IMAGE', 'La imagen supera los 8 MB');
      if (!assets) throw E(403, 'NO_ASSETS', 'En esta vista no se pueden adjuntar imágenes. Envía el pedido sin comprobante.');
      try { receiptId = (await assets.upload(file, { type: file.type })).id; } catch (e) { throw E(400, 'UPLOAD', `No se pudo subir el comprobante (${e?.code || 'error'})`); }
    }
    const demo = isDemo();
    const used = new Set([...orders.values()].map((x) => x.code));
    let n = orders.size + 1;
    const prefix = demo ? 'DEMO-' : 'RM-';
    while (used.has(prefix + String(n).padStart(4, '0'))) n++;
    const now = Date.now();
    const doc = {
      id: o.key, token: o.key, code: prefix + String(n).padStart(4, '0'), payloadHash: hash,
      customerName: o.customerName, paymentMethod: o.paymentMethod, status: 'pendiente', total, items,
      hasNotes: items.some((l) => l.note || l.removed.length), notesReviewed: false, isDemo: demo,
      receiptId, staffNote: '', createdAt: now, paidAt: null, updatedAt: now,
      events: [{ status: 'pendiente', detail: 'Pedido recibido', at: now }],
    };
    await ref.set(doc);
    orders.set(o.key, doc);
    return { status: 201, body: { code: doc.code, token: doc.token, total, duplicate: false } };
  }

  const TRANSITIONS = {
    pendiente: ['pago_confirmado', 'rechazado'], pago_confirmado: ['en_preparacion', 'rechazado'],
    en_preparacion: ['listo', 'rechazado'], listo: ['entregado'], entregado: [], rechazado: ['pendiente'],
  };
  async function changeStatus(id, body) {
    const o = orders.get(id);
    if (!o) throw E(404, 'NOT_FOUND', 'Pedido no encontrado');
    const next = body?.status;
    if (!(TRANSITIONS[o.status] || []).includes(next)) throw E(409, 'BAD_TRANSITION', `No se puede pasar de "${o.status}" a "${next}"`);
    const now = Date.now();
    const u = { ...o, status: next, updatedAt: now, events: [...(o.events || [])] };
    let detail = '';
    if (next === 'pago_confirmado') {
      if (o.hasNotes && !o.notesReviewed && body.notesReviewed !== true) throw E(409, 'NOTES_NOT_REVIEWED', 'Revisa las indicaciones del pedido antes de confirmarlo');
      if (o.paymentMethod === 'transferencia' && body.bankVerified !== true) throw E(409, 'BANK_NOT_VERIFIED', 'Confirma que verificaste el abono en la cuenta bancaria. El comprobante por sí solo no confirma el pago.');
      if (o.paymentMethod === 'efectivo' && body.cashReceived !== true) throw E(409, 'CASH_NOT_RECEIVED', 'Confirma que recibiste el efectivo');
      u.notesReviewed = true;
      u.paidAt = now;
      detail = o.paymentMethod === 'transferencia' ? 'Abono verificado en la cuenta bancaria' : 'Efectivo recibido';
    }
    if (next === 'rechazado') detail = clean(body.reason, 200) || 'Rechazado por caja';
    if (next === 'pendiente') { detail = 'Reabierto por caja'; u.paidAt = null; }
    u.events.push({ status: next, detail, at: now });
    await db.doc(`orders/${id}`).set(u);
    orders.set(id, u);
    return u;
  }
  const adminOrder = (o) => ({ ...o, receipt: o.receiptId ? `/_blob/${o.receiptId}` : null });

  function readiness() {
    const cat = needCatalog();
    const act = cat.products.filter((p) => p.active);
    const names = (arr) => arr.map((p) => p.name).sort();
    const blockers = [];
    const add = (msg, items = []) => { if (items === true || items.length) blockers.push({ msg, items: items === true ? [] : items }); };
    add('Productos activos con precio de prueba', names(act.filter((p) => p.priceIsTest)));
    add('Productos provisionales activos (p. ej. bebidas de ejemplo)', names(act.filter((p) => p.isPlaceholder)));
    add('Descripciones provisionales sin revisar', names(act.filter((p) => p.descriptionProvisional)));
    add('Productos con ingredientes provisionales', names(act.filter((p) => p.ingredients.some((g) => g.provisional))));
    if (settings.bank_is_test !== '0') add('Los datos bancarios siguen marcados como de prueba', true);
    if (!settings.public_url) add('Falta la dirección pública definitiva (https://...)', true);
    const illus = names(act.filter((p) => !p.photo));
    return { ready: !blockers.length, blockers, warnings: illus.length ? [{ msg: 'Productos que siguen con imagen ilustrativa (se muestran rotuladas como ilustración)', items: illus }] : [] };
  }

  function qrSvg(url) {
    const q = window.qrcode(0, 'M');
    q.addData(url);
    q.make();
    return q.createSvgTag(8, 16);
  }

  // ---------------- Enrutador ----------------
  const routes = [];
  const route = (method, pattern, fn, admin = false) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, admin });

  route('GET', '/api/menu', () => ({
    settings: {
      businessName: settings.business_name || 'Rucka Monkey', demoMode: isDemo(), bankIsTest: settings.bank_is_test !== '0',
      bank: { holder: settings.bank_holder || '', rut: settings.bank_rut || '', name: settings.bank_name || '', account_type: settings.bank_account_type || '', account_number: settings.bank_account_number || '', email: settings.bank_email || '' },
    },
    categories: catalogView(false).filter((c) => c.products.length),
  }));
  route('POST', '/api/orders', (_p, o) => createOrder(o.body));
  route('GET', '/api/orders/:token', ({ token }) => {
    const o = orders.get(token);
    if (!o) throw E(404, 'NOT_FOUND', 'Pedido no encontrado');
    return { code: o.code, status: o.status, customerName: o.customerName, paymentMethod: o.paymentMethod, total: o.total, isDemo: o.isDemo, receiptAttached: !!o.receiptId, createdAt: o.createdAt, items: o.items };
  });

  route('GET', '/api/admin/session', async () => ({ loggedIn: await canCashier() }));
  route('POST', '/api/admin/login', async () => { if (await canCashier()) return { ok: true }; throw E(401, 'NO', 'En la vista previa, la caja solo se abre para el dueño o los editores de esta página.'); });
  route('POST', '/api/admin/logout', () => ({ ok: true }));
  route('POST', '/api/admin/password', () => { throw E(400, 'PREVIEW', 'En la vista previa el acceso lo controla claude.ai. La contraseña existe en la versión instalada.'); }, true);

  route('GET', '/api/admin/orders', () => {
    const { start, end } = chileDayRange();
    const ACTIVE = ['pendiente', 'pago_confirmado', 'en_preparacion', 'listo'];
    const list = [...orders.values()].filter((o) => (o.createdAt >= start && o.createdAt < end) || ACTIVE.includes(o.status)).sort((a, b) => b.createdAt - a.createdAt);
    return { orders: list.map(adminOrder), serverTime: Date.now() };
  }, true);
  route('POST', '/api/admin/orders/:id/status', async ({ id }, o) => ({ order: adminOrder(await changeStatus(decodeURIComponent(id), o.json)) }), true);
  route('POST', '/api/admin/orders/:id/staff-note', async ({ id }, o) => {
    const cur = orders.get(decodeURIComponent(id));
    if (!cur) throw E(404, 'NOT_FOUND', 'Pedido no encontrado');
    const u = { ...cur, staffNote: String(o.json?.note ?? '').slice(0, 300), updatedAt: Date.now() };
    await db.doc(`orders/${cur.id}`).set(u);
    orders.set(cur.id, u);
    return { ok: true };
  }, true);
  route('DELETE', '/api/admin/demo-orders', async () => {
    const demo = [...orders.values()].filter((o) => o.isDemo);
    for (const o of demo) {
      await db.doc(`orders/${o.id}`).delete();
      if (o.receiptId && assets) await assets.delete(o.receiptId).catch(() => {});
      orders.delete(o.id);
    }
    return { deleted: demo.length };
  }, true);
  route('GET', '/api/admin/stats', () => {
    const { start, end, label } = chileDayRange();
    const PAID = ['pago_confirmado', 'en_preparacion', 'listo', 'entregado'];
    const calc = (demo) => {
      const all = [...orders.values()].filter((o) => o.isDemo === demo);
      const today = all.filter((o) => o.createdAt >= start && o.createdAt < end);
      const paid = today.filter((o) => PAID.includes(o.status));
      const ventas = paid.reduce((s, o) => s + o.total, 0);
      return { pedidosDelDia: today.length, rechazados: today.filter((o) => o.status === 'rechazado').length, pendientes: all.filter((o) => o.status === 'pendiente').length, ventasConfirmadas: ventas, pedidosPagados: paid.length, ticketPromedio: paid.length ? Math.round(ventas / paid.length) : 0 };
    };
    return { dia: label, zonaHoraria: TZ, real: calc(false), demo: calc(true) };
  }, true);

  route('GET', '/api/admin/catalog', () => ({ categories: catalogView(true) }), true);
  route('POST', '/api/admin/categories', (_p, o) => saveCatalog((c) => {
    const id = c.nextId++;
    c.categories.push({ id, name: str(o.json?.name, 40, 'el nombre'), sort: Math.max(0, ...c.categories.map((x) => x.sort)) + 1, active: true });
    return { id };
  }), true);
  route('PATCH', '/api/admin/categories/:id', ({ id }, o) => saveCatalog((c) => {
    const cat = c.categories.find((x) => x.id === Number(id));
    if (!cat) throw E(404, 'NOT_FOUND', 'Categoría no encontrada');
    if (o.json?.name !== undefined) cat.name = str(o.json.name, 40, 'el nombre');
    if (o.json?.active !== undefined) cat.active = !!o.json.active;
    return { ok: true };
  }), true);
  route('POST', '/api/admin/categories/reorder', (_p, o) => saveCatalog((c) => { (o.json?.ids || []).forEach((id, i) => { const x = c.categories.find((k) => k.id === Number(id)); if (x) x.sort = i + 1; }); return { ok: true }; }), true);

  function writeProduct(c, id, b) {
    const cur = id ? findProduct(c, id) : null;
    const v = cur || { id: c.nextId++, ingredients: [], extras: [], photo: null, description: '', descriptionProvisional: true, priceIsTest: true, isPlaceholder: false, active: true, illustration: null };
    if (b.categoryId !== undefined) { if (!c.categories.some((x) => x.id === Number(b.categoryId))) throw E(400, 'BAD_REQUEST', 'Categoría inválida'); v.categoryId = Number(b.categoryId); }
    if (b.name !== undefined) v.name = str(b.name, 60, 'el nombre');
    if (b.description !== undefined) v.description = String(b.description ?? '').trim().slice(0, 300);
    if (b.price !== undefined) v.price = price(b.price);
    for (const k of ['descriptionProvisional', 'priceIsTest', 'isPlaceholder', 'active']) if (b[k] !== undefined) v[k] = !!b[k];
    if (b.illustration !== undefined) v.illustration = b.illustration || null;
    if (v.categoryId == null || !v.name || v.price == null) throw E(400, 'BAD_REQUEST', 'Faltan categoría, nombre o precio');
    if (!cur) { v.sort = Math.max(0, ...c.products.filter((p) => p.categoryId === v.categoryId).map((p) => p.sort)) + 1; c.products.push(v); }
    return { id: v.id };
  }
  route('POST', '/api/admin/products', (_p, o) => saveCatalog((c) => writeProduct(c, null, o.json || {})), true);
  route('PATCH', '/api/admin/products/:id', ({ id }, o) => saveCatalog((c) => writeProduct(c, id, o.json || {})), true);
  route('DELETE', '/api/admin/products/:id', async ({ id }) => {
    const photo = findProduct(needCatalog(), id).photo;
    await saveCatalog((c) => { c.products = c.products.filter((p) => p.id !== Number(id)); });
    if (photo && assets) await assets.delete(photo).catch(() => {});
    return { ok: true };
  }, true);
  route('POST', '/api/admin/products/reorder', (_p, o) => saveCatalog((c) => { (o.json?.ids || []).forEach((id, i) => { const x = c.products.find((k) => k.id === Number(id)); if (x) x.sort = i + 1; }); return { ok: true }; }), true);
  function replaceList(c, id, list, map) {
    const p = findProduct(c, id);
    if (!Array.isArray(list) || list.length > 40) throw E(400, 'BAD_REQUEST', 'Lista inválida');
    return { p, rows: list.map((r) => ({ ...map(r), id: Number(r.id) || c.nextId++ })) };
  }
  route('PUT', '/api/admin/products/:id/ingredients', ({ id }, o) => saveCatalog((c) => {
    const { p, rows } = replaceList(c, id, o.json?.ingredients, (g) => ({ name: str(g.name, 40, 'el nombre del ingrediente'), removable: !!g.removable, provisional: !!g.provisional }));
    p.ingredients = rows;
    return { ok: true };
  }), true);
  route('PUT', '/api/admin/products/:id/extras', ({ id }, o) => saveCatalog((c) => {
    const { p, rows } = replaceList(c, id, o.json?.extras, (e) => ({ name: str(e.name, 40, 'el nombre del extra'), price: price(e.price), active: e.active !== false }));
    p.extras = rows;
    return { ok: true };
  }), true);
  route('POST', '/api/admin/products/:id/photo', async ({ id }, o) => {
    const file = o.body.get('photo');
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw E(400, 'BAD_IMAGE', 'La imagen debe ser JPG, PNG o WEBP');
    if (!assets) throw E(403, 'NO_ASSETS', 'Esta vista no puede subir imágenes');
    const old = findProduct(needCatalog(), id).photo;
    const up = await assets.upload(file, { type: file.type });
    await saveCatalog((c) => { findProduct(c, id).photo = up.id; });
    if (old) await assets.delete(old).catch(() => {});
    return { image: `/_blob/${up.id}` };
  }, true);
  route('DELETE', '/api/admin/products/:id/photo', async ({ id }) => {
    const old = findProduct(needCatalog(), id).photo;
    await saveCatalog((c) => { findProduct(c, id).photo = null; });
    if (old && assets) await assets.delete(old).catch(() => {});
    return { ok: true };
  }, true);
  route('GET', '/api/admin/illustrations', () => ({ files: Object.keys(ILLUS).sort() }), true);

  const EDITABLE = ['business_name', 'bank_holder', 'bank_rut', 'bank_name', 'bank_account_type', 'bank_account_number', 'bank_email', 'public_url', 'bank_is_test'];
  route('GET', '/api/admin/settings', () => Object.fromEntries(EDITABLE.concat('demo_mode', 'test_url').map((k) => [k, settings[k] ?? (k === 'demo_mode' ? '1' : '')])), true);
  route('PATCH', '/api/admin/settings', async (_p, o) => {
    const next = { ...settings };
    for (const k of EDITABLE) {
      const b = o.json || {};
      if (b[k] === undefined) continue;
      let v = String(b[k]).trim().slice(0, 120);
      if (k === 'bank_is_test') v = b[k] === true || b[k] === '1' ? '1' : '0';
      if (k === 'public_url' && v) {
        let u; try { u = new URL(v); } catch { throw E(400, 'BAD_REQUEST', 'La dirección pública no es una URL válida'); }
        if (u.protocol !== 'https:') throw E(400, 'BAD_REQUEST', 'La dirección pública debe comenzar con https://');
        v = u.origin + u.pathname.replace(/\/+$/, '');
      }
      next[k] = v;
    }
    await db.doc('menu/settings').set(next);
    settings = next;
    return { ok: true };
  }, true);
  route('GET', '/api/admin/readiness', () => readiness(), true);
  route('POST', '/api/admin/demo-mode', async (_p, o) => {
    const enable = o.json?.enabled === true;
    if (!enable) { const r = readiness(); if (!r.ready) throw E(409, 'NOT_READY', 'Aún hay datos provisionales. Revisa la lista antes de salir del modo demostración.', r); }
    const next = { ...settings, demo_mode: enable ? '1' : '0' };
    await db.doc('menu/settings').set(next);
    settings = next;
    return { demoMode: enable };
  }, true);
  route('GET', '/api/admin/qr', ({ }, o) => {
    const q = new URLSearchParams(o.query);
    if (q.get('type') === 'final') {
      if (isDemo()) throw E(409, 'DEMO', 'El QR definitivo solo se genera cuando se sale del modo demostración');
      if (!settings.public_url) throw E(409, 'NO_URL', 'Falta la dirección pública definitiva');
      const url = settings.public_url + '/';
      return { type: 'final', url, svg: qrSvg(url) };
    }
    const base = q.get('base') || settings.test_url;
    let u; try { u = new URL(base); } catch { throw E(400, 'BAD_REQUEST', 'Escribe la dirección de esta vista previa (el enlace de claude.ai)'); }
    return { type: 'prueba', url: u.href, svg: qrSvg(u.href) };
  }, true);

  async function api(url, opts = {}) {
    await init();
    const [path, query = ''] = url.split('?');
    const method = (opts.method || 'GET').toUpperCase();
    const json = opts.json !== undefined ? structuredClone(opts.json) : undefined;
    for (const r of routes) {
      const m = r.method === method && path.match(r.re);
      if (!m) continue;
      if (r.admin && !(await canCashier())) throw new ApiError(401, 'No autorizado');
      try {
        const out = await r.fn(m.groups || {}, { json, body: opts.body, query });
        return out && out.status && out.body ? out.body : out;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (e?.code === 'invalid_argument') throw new ApiError(403, 'No tienes permiso para guardar en esta vista previa');
        console.error(e);
        throw new ApiError(500, e?.message || 'Error interno');
      }
    }
    throw new ApiError(404, 'No encontrado');
  }

  return { init, api, onChange, canCashier };
})();
