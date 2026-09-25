'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const dbm = require('./db');
const { createAuth } = require('./auth');
const { createOrder, itemsOf, changeStatus, OrderError } = require('./orders');
const { chileDayRange, TZ } = require('./time');
const { clientIp, ipSource, RateLimiter, turnstile, originGuard } = require('./security');
const { createShifts } = require('./shifts');
const { chileDateStr } = require('./time');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const db = dbm.open();
  const settings = {
    get: (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null,
    set: (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),
  };
  const auth = createAuth(settings, db);
  const shifts = createShifts(db, { isDemo: () => settings.get('demo_mode') === '1' });
  const app = express();
  // Detrás del HTTPS del hosting: "1" = confiar en un proxy (número, no texto, para que Express lo entienda).
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp);
  app.disable('x-powered-by');

  // Con dominio propio en Cloudflare + ORIGIN_SECRET: nadie puede saltarse Cloudflare entrando directo al hosting.
  app.use(originGuard);

  // Cabeceras de seguridad. Turnstile (si está activo) necesita cargar su script y su recuadro desde Cloudflare.
  const CF = turnstile.enabled() ? ' https://challenges.cloudflare.com' : '';
  const CSP = `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'${CF}; frame-src${CF || " 'none'"}; connect-src 'self'${CF}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  app.use((req, res, next) => {
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': CSP,
    });
    next();
  });

  // Límite general de la API por cliente (la carta consulta el estado cada 5 s y la caja cada 4 s: muy por debajo).
  const apiLimiter = new RateLimiter(60 * 1000);
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    const ip = clientIp(req);
    if (apiLimiter.count(ip) >= 300) {
      res.set('Retry-After', String(apiLimiter.retryAfter(ip)));
      return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento.' });
    }
    apiLimiter.add(ip);
    next();
  });
  app.use(express.json({ limit: '200kb' }));

  // ---------- Subida de imágenes (validadas por contenido, no por extensión) ----------
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 4, fieldSize: 100 * 1024, parts: 6 } });
  function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
    return null;
  }
  function saveImage(file, dir) {
    const kind = sniffImage(file?.buffer);
    if (!kind) throw new OrderError(400, 'BAD_IMAGE', 'La imagen debe ser JPG, PNG o WEBP');
    const name = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
    fs.writeFileSync(path.join(dir, name), file.buffer, { flag: 'wx' });
    return { file: name, mime: kind.mime };
  }
  const withUpload = (field) => (req, res, next) => upload.single(field)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'La imagen supera los 8 MB' : 'No se pudo leer el archivo' });
    next();
  });

  const bool = (v) => v === 1 || v === true || v === '1';
  const isDemo = () => settings.get('demo_mode') === '1';

  function publicSettings() {
    const bankKeys = ['bank_holder', 'bank_rut', 'bank_name', 'bank_account_type', 'bank_account_number', 'bank_email'];
    return {
      businessName: settings.get('business_name'),
      demoMode: isDemo(),
      bankIsTest: settings.get('bank_is_test') === '1',
      bank: Object.fromEntries(bankKeys.map((k) => [k.replace('bank_', ''), settings.get(k) || ''])),
    };
  }

  function productImage(p) {
    if (p.photo) return { image: `/fotos/${p.photo}`, imageKind: 'foto' };
    if (p.illustration) return { image: `/img/illus/${p.illustration}`, imageKind: 'ilustracion' };
    return { image: null, imageKind: null };
  }

  function catalog({ includeInactive }) {
    const cats = db.prepare(`SELECT * FROM categories ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
    const prods = db.prepare(`SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
    const ings = db.prepare('SELECT * FROM ingredients ORDER BY sort, id').all();
    const exs = db.prepare(`SELECT * FROM extras ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
    return cats.map((c) => ({
      id: c.id, name: c.name, active: bool(c.active), sort: c.sort,
      products: prods.filter((p) => p.category_id === c.id).map((p) => ({
        id: p.id, categoryId: p.category_id, name: p.name, description: p.description,
        descriptionProvisional: bool(p.description_provisional), price: p.price, priceIsTest: bool(p.price_is_test),
        isPlaceholder: bool(p.is_placeholder), active: bool(p.active), sort: p.sort,
        illustration: p.illustration, hasPhoto: !!p.photo, ...productImage(p),
        ingredients: ings.filter((g) => g.product_id === p.id).map((g) => ({ id: g.id, name: g.name, removable: bool(g.removable), provisional: bool(g.provisional) })),
        extras: exs.filter((e) => e.product_id === p.id).map((e) => ({ id: e.id, name: e.name, price: e.price, active: bool(e.active) })),
      })),
    }));
  }

  function handle(fn) {
    return (req, res) => {
      try {
        const out = fn(req, res);
        if (out && typeof out.then === 'function') out.catch((e) => fail(res, e));
      } catch (e) { fail(res, e); }
    };
  }
  function fail(res, e) {
    if (e instanceof OrderError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    console.error(e);
    res.status(500).json({ error: 'Error interno' });
  }

  // ---------- API pública (clientes) ----------
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/menu', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ settings: publicSettings(), categories: catalog({ includeInactive: false }).filter((c) => c.products.length) });
  });

  // Pedidos por cliente cada 10 minutos. Los primeros pasan sin ningún desafío; desde el 5.º se pide
  // Turnstile (si está configurado, casi siempre sin clics). Sobre el máximo, se rechaza.
  const orderLimiter = new RateLimiter(10 * 60 * 1000);
  const ORDER_SOFT = 4;
  const ORDER_HARD = () => (turnstile.enabled() ? 30 : 20);
  const orderPreCheck = (req, res, next) => {
    const ip = clientIp(req);
    if (orderLimiter.count(ip) >= ORDER_HARD()) {
      res.set('Retry-After', String(orderLimiter.retryAfter(ip)));
      return res.status(429).json({ error: 'Demasiados pedidos seguidos desde esta conexión. Espera unos minutos o pide en caja.', code: 'RATE' });
    }
    next();
  };

  app.post('/api/orders', orderPreCheck, withUpload('receipt'), handle(async (req, res) => {
    const ip = clientIp(req);
    let raw;
    try { raw = JSON.parse(req.body?.order || 'null'); } catch { throw new OrderError(400, 'BAD_REQUEST', 'Pedido inválido'); }
    // Si es un reenvío del mismo pedido, no se guarda el archivo de nuevo ni cuenta para el límite.
    const already = raw?.idempotencyKey && db.prepare('SELECT 1 FROM orders WHERE idempotency_key = ?').get(String(raw.idempotencyKey));
    if (!already && turnstile.enabled() && orderLimiter.count(ip) >= ORDER_SOFT) {
      const t = await turnstile.verify(req.body?.turnstile, ip, 'pedido');
      if (!t.ok) throw new OrderError(428, 'TURNSTILE_REQUIRED', 'Confirma que eres una persona para enviar otro pedido.', { siteKey: turnstile.siteKey() });
    }
    let receipt = null;
    if (req.file && !already) {
      if (raw?.paymentMethod !== 'transferencia') throw new OrderError(400, 'BAD_REQUEST', 'El comprobante solo aplica a transferencias');
      receipt = saveImage(req.file, dbm.RECEIPTS_DIR);
    }
    try {
      const { order, duplicate } = createOrder(db, settings, raw, receipt);
      if (!duplicate) orderLimiter.add(ip);
      res.status(duplicate ? 200 : 201).json({ code: order.code, token: order.public_token, total: order.total, duplicate });
    } catch (e) {
      if (receipt) fs.rmSync(path.join(dbm.RECEIPTS_DIR, receipt.file), { force: true });
      throw e;
    }
  }));

  app.get('/api/orders/:token', handle((req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE public_token = ?').get(String(req.params.token));
    if (!o) throw new OrderError(404, 'NOT_FOUND', 'Pedido no encontrado');
    res.set('Cache-Control', 'no-store');
    res.json({
      code: o.code, status: o.status, customerName: o.customer_name, paymentMethod: o.payment_method,
      total: o.total, isDemo: bool(o.is_demo), receiptAttached: !!o.receipt_file, createdAt: o.created_at,
      items: itemsOf(db, o.id),
    });
  }));

  // ---------- Panel de caja / administración (protegido en el servidor) ----------
  const admin = express.Router();
  admin.post('/login', auth.login);
  admin.post('/logout', auth.logout);
  admin.get('/session', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ loggedIn: auth.isValid(req), turnstileSiteKey: turnstile.enabled() ? turnstile.siteKey() : null }); });
  admin.use(auth.requireAdmin);
  admin.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  admin.post('/password', auth.changePassword);

  // Diagnóstico de seguridad (solo caja): permite comprobar en el hosting real que la IP del cliente se lee bien.
  admin.get('/security', (req, res) => {
    const xff = String(req.headers['x-forwarded-for'] || '');
    res.json({
      ipDetectada: clientIp(req), fuenteIp: ipSource(req), https: req.secure,
      cabeceras: { 'cf-connecting-ip': !!req.headers['cf-connecting-ip'], 'cf-ray': !!req.headers['cf-ray'], 'x-forwarded-for': xff ? xff.split(',').length : 0 },
      turnstile: turnstile.enabled(), candadoOrigen: !!process.env.ORIGIN_SECRET,
      limites: { loginFallosPorIp: '8 cada 15 min', pedidosSinDesafio: `${ORDER_SOFT} cada 10 min`, pedidosMaximo: `${ORDER_HARD()} cada 10 min`, api: '300 por minuto' },
    });
  });

  function adminOrder(o) {
    const events = db.prepare('SELECT status, detail, at FROM order_events WHERE order_id = ? ORDER BY at, id').all(o.id);
    return {
      id: o.id, code: o.code, status: o.status, customerName: o.customer_name, paymentMethod: o.payment_method,
      total: o.total, hasNotes: bool(o.has_notes), notesReviewed: bool(o.notes_reviewed), isDemo: bool(o.is_demo),
      receipt: o.receipt_file ? `/api/admin/orders/${o.id}/receipt` : null, staffNote: o.staff_note,
      createdAt: o.created_at, paidAt: o.paid_at, updatedAt: o.updated_at, items: itemsOf(db, o.id), events,
    };
  }

  admin.get('/orders', handle((req, res) => {
    const { status, scope } = req.query;
    const where = [];
    const args = [];
    if (status && status !== 'todos') {
      if (status === 'activos') where.push("status IN ('pendiente','pago_confirmado','en_preparacion','listo')");
      else { where.push('status = ?'); args.push(String(status)); }
    }
    if (scope !== 'all') {
      const { start, end } = chileDayRange();
      where.push('((created_at >= ? AND created_at < ?) OR status IN (\'pendiente\',\'pago_confirmado\',\'en_preparacion\',\'listo\'))');
      args.push(start, end);
    }
    const rows = db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 300`).all(...args);
    res.json({ orders: rows.map(adminOrder), serverTime: Date.now() });
  }));

  admin.get('/orders/:id/receipt', handle((req, res) => {
    const o = db.prepare('SELECT receipt_file, receipt_mime FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!o?.receipt_file) throw new OrderError(404, 'NOT_FOUND', 'Sin comprobante');
    res.set({ 'Content-Type': o.receipt_mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.sendFile(path.join(dbm.RECEIPTS_DIR, path.basename(o.receipt_file)));
  }));

  // Responsable de cada acción: el nombre que el cajero escribió en su celular + huella de la sesión.
  const actorOf = (req) => {
    let name = '';
    try { name = decodeURIComponent(String(req.get('X-Staff-Name') || '')); } catch { /* */ }
    name = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
    return { name: name || 'Sin nombre', session: auth.sessionTag(req) };
  };

  admin.post('/orders/:id/status', handle((req, res) => {
    const id = Number(req.params.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const before = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (before) shifts.beforeStatusChange(before, req.body);
      const after = changeStatus(db, id, req.body);
      shifts.afterStatusChange(before, after, req.body, actorOf(req));
      db.exec('COMMIT');
      res.json({ order: adminOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)) });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }));

  // ---------- Apertura y cierre de caja ----------
  admin.get('/shifts/current', (_req, res) => {
    const s = shifts.openShift();
    const unassigned = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE is_demo = ? AND paid_at IS NOT NULL AND paid_shift_id IS NULL AND status != 'rechazado' AND paid_at >= ?")
      .get(isDemo() ? 1 : 0, chileDayRange().start).n;
    res.json({ shift: shifts.view(s), demo: isDemo(), today: chileDateStr(), cobrosSinTurnoHoy: unassigned, almacenamiento: storageInfo() });
  });
  admin.post('/shifts/open', handle((req, res) => {
    res.status(201).json({ shift: shifts.open({ openingCash: req.body?.openingCash, by: req.body?.by, session: auth.sessionTag(req) }) });
  }));
  admin.post('/shifts/movements', handle((req, res) => {
    res.status(201).json({ shift: shifts.addMovement({ ...req.body, session: auth.sessionTag(req) }) });
  }));
  admin.post('/shifts/close', handle((req, res) => {
    res.json({ shift: shifts.close({ ...req.body, session: auth.sessionTag(req) }) });
  }));
  admin.get('/shifts', handle((req, res) => {
    const date = String(req.query.date || chileDateStr());
    res.json({ date, shifts: shifts.listByDate(date, isDemo()), demo: isDemo() });
  }));
  admin.get('/shifts/:id', handle((req, res) => {
    const s = shifts.getShift(Number(req.params.id));
    if (!s) throw new OrderError(404, 'NOT_FOUND', 'Turno no encontrado');
    res.json({ shift: shifts.view(s, { live: true }) });
  }));

  admin.post('/orders/:id/staff-note', handle((req, res) => {
    const note = String(req.body?.note ?? '').slice(0, 300);
    const r = db.prepare('UPDATE orders SET staff_note = ?, updated_at = ? WHERE id = ?').run(note, Date.now(), Number(req.params.id));
    if (!r.changes) throw new OrderError(404, 'NOT_FOUND', 'Pedido no encontrado');
    res.json({ ok: true });
  }));

  admin.delete('/demo-orders', handle((_req, res) => {
    const files = db.prepare('SELECT receipt_file FROM orders WHERE is_demo = 1 AND receipt_file IS NOT NULL').all();
    if (shifts.openShift(true)) throw new OrderError(409, 'SHIFT_OPEN', 'Cierra el turno de demostración antes de borrar los pedidos de demostración.');
    const r = db.prepare('DELETE FROM orders WHERE is_demo = 1').run();
    shifts.purgeDemo();
    for (const f of files) fs.rmSync(path.join(dbm.RECEIPTS_DIR, path.basename(f.receipt_file)), { force: true });
    res.json({ deleted: Number(r.changes) });
  }));

  // Indicadores del día en hora de Chile. Los pedidos reales y los de demostración se calculan por separado.
  admin.get('/stats', handle((_req, res) => {
    const { start, end, label } = chileDayRange();
    const PAID = "('pago_confirmado','en_preparacion','listo','entregado')";
    const calc = (demo) => {
      const r = db.prepare(`SELECT
          COUNT(*) AS pedidos,
          SUM(CASE WHEN status = 'rechazado' THEN 1 ELSE 0 END) AS rechazados,
          SUM(CASE WHEN status IN ${PAID} THEN 1 ELSE 0 END) AS pagados,
          COALESCE(SUM(CASE WHEN status IN ${PAID} THEN total ELSE 0 END), 0) AS ventas
        FROM orders WHERE is_demo = ? AND created_at >= ? AND created_at < ?`).get(demo, start, end);
      const pend = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE is_demo = ? AND status = 'pendiente'").get(demo).n;
      return {
        pedidosDelDia: r.pedidos, rechazados: r.rechazados || 0, pendientes: pend,
        ventasConfirmadas: r.ventas, pedidosPagados: r.pagados || 0,
        ticketPromedio: r.pagados ? Math.round(r.ventas / r.pagados) : 0,
      };
    };
    res.json({ dia: label, zonaHoraria: TZ, real: calc(0), demo: calc(1) });
  }));

  // ---------- Catálogo ----------
  admin.get('/catalog', (_req, res) => res.json({ categories: catalog({ includeInactive: true }) }));

  const str = (v, max, field) => {
    const s = String(v ?? '').trim().slice(0, max);
    if (!s) throw new OrderError(400, 'BAD_REQUEST', `Falta ${field}`);
    return s;
  };
  const price = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new OrderError(400, 'BAD_REQUEST', 'Precio inválido (entero en pesos, sin puntos)');
    return n;
  };

  admin.post('/categories', handle((req, res) => {
    const max = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM categories').get().m;
    const r = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)').run(str(req.body?.name, 40, 'el nombre'), max + 1);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  }));
  admin.patch('/categories/:id', handle((req, res) => {
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
    if (!c) throw new OrderError(404, 'NOT_FOUND', 'Categoría no encontrada');
    const b = req.body || {};
    db.prepare('UPDATE categories SET name = ?, active = ? WHERE id = ?').run(
      b.name !== undefined ? str(b.name, 40, 'el nombre') : c.name, b.active !== undefined ? (b.active ? 1 : 0) : c.active, c.id);
    res.json({ ok: true });
  }));
  admin.post('/categories/reorder', handle((req, res) => {
    const ids = (req.body?.ids || []).map(Number);
    const up = db.prepare('UPDATE categories SET sort = ? WHERE id = ?');
    ids.forEach((id, i) => up.run(i + 1, id));
    res.json({ ok: true });
  }));

  function writeProduct(id, b) {
    const cur = id ? db.prepare('SELECT * FROM products WHERE id = ?').get(id) : null;
    if (id && !cur) throw new OrderError(404, 'NOT_FOUND', 'Producto no encontrado');
    const pick = (k, conv, fallback) => (b[k] !== undefined ? conv(b[k]) : fallback);
    const v = {
      category_id: pick('categoryId', (x) => {
        const c = db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(x));
        if (!c) throw new OrderError(400, 'BAD_REQUEST', 'Categoría inválida');
        return c.id;
      }, cur?.category_id),
      name: pick('name', (x) => str(x, 60, 'el nombre'), cur?.name),
      description: pick('description', (x) => String(x ?? '').trim().slice(0, 300), cur?.description ?? ''),
      description_provisional: pick('descriptionProvisional', (x) => (x ? 1 : 0), cur?.description_provisional ?? 1),
      price: pick('price', price, cur?.price),
      price_is_test: pick('priceIsTest', (x) => (x ? 1 : 0), cur?.price_is_test ?? 1),
      is_placeholder: pick('isPlaceholder', (x) => (x ? 1 : 0), cur?.is_placeholder ?? 0),
      active: pick('active', (x) => (x ? 1 : 0), cur?.active ?? 1),
      illustration: pick('illustration', (x) => (x ? path.basename(String(x)) : null), cur?.illustration ?? null),
    };
    if (v.category_id == null || v.name == null || v.price == null) throw new OrderError(400, 'BAD_REQUEST', 'Faltan categoría, nombre o precio');
    if (cur) {
      db.prepare(`UPDATE products SET category_id=?, name=?, description=?, description_provisional=?, price=?, price_is_test=?, is_placeholder=?, active=?, illustration=? WHERE id=?`)
        .run(v.category_id, v.name, v.description, v.description_provisional, v.price, v.price_is_test, v.is_placeholder, v.active, v.illustration, id);
      return id;
    }
    const max = db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM products WHERE category_id = ?').get(v.category_id).m;
    return Number(db.prepare(`INSERT INTO products (category_id, name, description, description_provisional, price, price_is_test, is_placeholder, active, illustration, sort)
                              VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(v.category_id, v.name, v.description, v.description_provisional, v.price, v.price_is_test, v.is_placeholder, v.active, v.illustration, max + 1).lastInsertRowid);
  }

  admin.post('/products', handle((req, res) => res.status(201).json({ id: writeProduct(null, req.body || {}) })));
  admin.patch('/products/:id', handle((req, res) => res.json({ id: writeProduct(Number(req.params.id), req.body || {}) })));
  admin.delete('/products/:id', handle((req, res) => {
    const p = db.prepare('SELECT photo FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) throw new OrderError(404, 'NOT_FOUND', 'Producto no encontrado');
    db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id)); // los pedidos guardan copia del nombre y precio
    if (p.photo) fs.rmSync(path.join(dbm.UPLOADS_DIR, path.basename(p.photo)), { force: true });
    res.json({ ok: true });
  }));
  admin.post('/products/reorder', handle((req, res) => {
    const ids = (req.body?.ids || []).map(Number);
    const up = db.prepare('UPDATE products SET sort = ? WHERE id = ?');
    ids.forEach((id, i) => up.run(i + 1, id));
    res.json({ ok: true });
  }));

  function replaceList(table, productId, list, mapRow) {
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) throw new OrderError(404, 'NOT_FOUND', 'Producto no encontrado');
    if (!Array.isArray(list) || list.length > 40) throw new OrderError(400, 'BAD_REQUEST', 'Lista inválida');
    const rows = list.map(mapRow);
    db.exec('BEGIN');
    try {
      const keep = rows.filter((r) => r.id).map((r) => r.id);
      db.prepare(`DELETE FROM ${table} WHERE product_id = ? AND id NOT IN (${keep.map(() => '?').join(',') || 'NULL'})`).run(productId, ...keep);
      rows.forEach((r, i) => {
        const cols = Object.keys(r.data);
        if (r.id && db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND product_id = ?`).get(r.id, productId)) {
          db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, sort = ? WHERE id = ?`).run(...cols.map((c) => r.data[c]), i + 1, r.id);
        } else {
          db.prepare(`INSERT INTO ${table} (product_id, ${cols.join(', ')}, sort) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`).run(productId, ...cols.map((c) => r.data[c]), i + 1);
        }
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  admin.put('/products/:id/ingredients', handle((req, res) => {
    replaceList('ingredients', Number(req.params.id), req.body?.ingredients, (g) => ({
      id: Number(g.id) || null,
      data: { name: str(g.name, 40, 'el nombre del ingrediente'), removable: g.removable ? 1 : 0, provisional: g.provisional ? 1 : 0 },
    }));
    res.json({ ok: true });
  }));
  admin.put('/products/:id/extras', handle((req, res) => {
    replaceList('extras', Number(req.params.id), req.body?.extras, (e) => ({
      id: Number(e.id) || null,
      data: { name: str(e.name, 40, 'el nombre del extra'), price: price(e.price), active: e.active === false ? 0 : 1 },
    }));
    res.json({ ok: true });
  }));

  admin.post('/products/:id/photo', withUpload('photo'), handle((req, res) => {
    const p = db.prepare('SELECT photo FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) throw new OrderError(404, 'NOT_FOUND', 'Producto no encontrado');
    const saved = saveImage(req.file, dbm.UPLOADS_DIR);
    db.prepare('UPDATE products SET photo = ? WHERE id = ?').run(saved.file, Number(req.params.id));
    if (p.photo) fs.rmSync(path.join(dbm.UPLOADS_DIR, path.basename(p.photo)), { force: true });
    res.json({ image: `/fotos/${saved.file}` });
  }));
  admin.delete('/products/:id/photo', handle((req, res) => {
    const p = db.prepare('SELECT photo FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) throw new OrderError(404, 'NOT_FOUND', 'Producto no encontrado');
    db.prepare('UPDATE products SET photo = NULL WHERE id = ?').run(Number(req.params.id));
    if (p.photo) fs.rmSync(path.join(dbm.UPLOADS_DIR, path.basename(p.photo)), { force: true });
    res.json({ ok: true });
  }));

  admin.get('/illustrations', (_req, res) => {
    res.json({ files: fs.readdirSync(path.join(PUBLIC_DIR, 'img', 'illus')).filter((f) => f.endsWith('.svg')).sort() });
  });

  // ---------- Ajustes, datos bancarios y paso a operación real ----------
  const EDITABLE = ['business_name', 'bank_holder', 'bank_rut', 'bank_name', 'bank_account_type', 'bank_account_number', 'bank_email', 'public_url', 'bank_is_test'];
  admin.get('/settings', (_req, res) => res.json(Object.fromEntries(EDITABLE.concat('demo_mode').map((k) => [k, settings.get(k) ?? '']))));
  admin.patch('/settings', handle((req, res) => {
    const b = req.body || {};
    for (const k of EDITABLE) {
      if (b[k] === undefined) continue;
      let v = String(b[k]).trim().slice(0, 120);
      if (k === 'bank_is_test') v = b[k] === true || b[k] === '1' ? '1' : '0';
      if (k === 'public_url' && v) {
        let u;
        try { u = new URL(v); } catch { throw new OrderError(400, 'BAD_REQUEST', 'La dirección pública no es una URL válida'); }
        if (u.protocol !== 'https:') throw new OrderError(400, 'BAD_REQUEST', 'La dirección pública debe comenzar con https://');
        v = u.origin + u.pathname.replace(/\/+$/, '');
      }
      settings.set(k, v);
    }
    res.json({ ok: true });
  }));

  // ¿Los datos sobreviven a reinicios? En Render sin disco (DATA_DIR sin definir) el disco es temporal.
  function storageInfo() {
    const onRender = !!process.env.RENDER;
    let separateDisk = false;
    try { separateDisk = fs.statSync(dbm.DATA_DIR).dev !== fs.statSync(__dirname).dev; } catch { /* */ }
    const persistent = onRender ? separateDisk : true;
    return {
      persistente: persistent,
      detalle: persistent
        ? (separateDisk ? 'Datos en un disco aparte del código' : 'Datos en la carpeta de datos del servidor')
        : 'Render sin disco persistente: los cierres y pedidos se borran al reiniciar, dormirse o desplegar',
    };
  }

  function readiness() {
    const q = (sql) => db.prepare(sql).all().map((r) => r.name);
    const blockers = [];
    const add = (msg, list = []) => blockers.push({ msg, items: list });
    const testPrices = q('SELECT name FROM products WHERE active = 1 AND price_is_test = 1 ORDER BY name');
    if (testPrices.length) add('Productos activos con precio de prueba', testPrices);
    const placeholders = q('SELECT name FROM products WHERE active = 1 AND is_placeholder = 1 ORDER BY name');
    if (placeholders.length) add('Productos provisionales activos (p. ej. bebidas de ejemplo)', placeholders);
    const provDesc = q('SELECT name FROM products WHERE active = 1 AND description_provisional = 1 ORDER BY name');
    if (provDesc.length) add('Descripciones provisionales sin revisar', provDesc);
    const provIng = q(`SELECT DISTINCT p.name FROM ingredients g JOIN products p ON p.id = g.product_id WHERE p.active = 1 AND g.provisional = 1 ORDER BY p.name`);
    if (provIng.length) add('Productos con ingredientes provisionales', provIng);
    if (settings.get('bank_is_test') === '1') add('Los datos bancarios siguen marcados como de prueba');
    if (!settings.get('public_url')) add('Falta la dirección pública definitiva (https://...)');
    const warnings = [];
    const illus = q('SELECT name FROM products WHERE active = 1 AND photo IS NULL ORDER BY name');
    if (illus.length) warnings.push({ msg: 'Productos que siguen con imagen ilustrativa (se muestran rotuladas como ilustración)', items: illus });
    return { ready: blockers.length === 0, blockers, warnings };
  }
  admin.get('/readiness', (_req, res) => res.json(readiness()));

  admin.post('/demo-mode', handle((req, res) => {
    const enable = req.body?.enabled === true;
    if (shifts.openShift(!enable)) throw new OrderError(409, 'SHIFT_OPEN', 'Hay un turno de caja abierto. Ciérralo antes de cambiar de modo.');
    if (!enable) {
      const r = readiness();
      if (!r.ready) throw new OrderError(409, 'NOT_READY', 'Aún hay datos provisionales. Revisa la lista antes de salir del modo demostración.', r);
    }
    settings.set('demo_mode', enable ? '1' : '0');
    res.json({ demoMode: enable });
  }));

  function qrTarget(req) {
    const type = req.query.type === 'final' ? 'final' : 'prueba';
    let url;
    if (type === 'final') {
      if (isDemo()) throw new OrderError(409, 'DEMO', 'El QR definitivo solo se genera cuando se sale del modo demostración');
      url = settings.get('public_url');
      if (!url) throw new OrderError(409, 'NO_URL', 'Falta la dirección pública definitiva');
      url += '/';
    } else {
      const base = String(req.query.base || `${req.protocol}://${req.get('host')}`);
      let u;
      try { u = new URL(base); } catch { throw new OrderError(400, 'BAD_REQUEST', 'Dirección inválida'); }
      url = `${u.origin}/?origen=qr-prueba`;
    }
    return { type, url };
  }
  admin.get('/qr', handle(async (req, res) => {
    const { type, url } = qrTarget(req);
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#1b1208', light: '#ffffff' } });
    res.json({ type, url, svg, png: `/api/admin/qr.png?${new URLSearchParams(req.query)}` });
  }));
  // QR descargable como imagen PNG
  admin.get('/qr.png', handle(async (req, res) => {
    const { type, url } = qrTarget(req);
    const png = await QRCode.toBuffer(url, { type: 'png', margin: 3, width: 1024, errorCorrectionLevel: 'M' });
    const name = type === 'final' ? 'QR-carta-Rucka-Monkey.png' : 'QR-PRUEBA-NO-PUBLICAR-Rucka-Monkey.png';
    res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${name}"` });
    res.send(png);
  }));

  app.use('/api/admin', admin);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));

  // ---------- Archivos estáticos ----------
  app.use('/fotos', express.static(dbm.UPLOADS_DIR, { maxAge: '7d', index: false }));
  // Panel de caja: interfaz aparte de la carta. La página no contiene datos; todo lo interno exige sesión en /api/admin.
  app.get(['/caja', '/caja/', '/admin', '/admin/'], (_req, res) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });
  app.get('/admin.html', (_req, res) => res.redirect(301, '/caja'));
  app.get('/pedido/:token', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  return { app, db, settings, adminRouter: admin };
}

if (require.main === module) {
  const { app } = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Rucka Monkey escuchando en http://localhost:${port}  (panel: /admin)`));
}

module.exports = { createApp };
