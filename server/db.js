'use strict';
// Base de datos compartida (SQLite en disco). Todos los clientes y la caja
// leen y escriben a través del servidor, así que hay una sola fuente de verdad.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const seed = require('./seed');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RECEIPTS_DIR = path.join(DATA_DIR, 'comprobantes'); // privado: nunca se sirve como estático
const UPLOADS_DIR = path.join(DATA_DIR, 'fotos'); // fotos de productos (públicas)

function open() {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'rucka.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n === 0) seed.run(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      description_provisional INTEGER NOT NULL DEFAULT 1,
      price INTEGER NOT NULL CHECK (price >= 0),
      price_is_test INTEGER NOT NULL DEFAULT 1,
      illustration TEXT,            -- ilustración de demo (public/img/illus)
      photo TEXT,                   -- foto real subida desde el panel (data/fotos)
      is_placeholder INTEGER NOT NULL DEFAULT 0, -- producto provisional (p. ej. bebidas de ejemplo)
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      removable INTEGER NOT NULL DEFAULT 1,
      provisional INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS extras (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      public_token TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('efectivo','transferencia')),
      status TEXT NOT NULL DEFAULT 'pendiente'
        CHECK (status IN ('pendiente','pago_confirmado','en_preparacion','listo','entregado','rechazado')),
      total INTEGER NOT NULL,
      has_notes INTEGER NOT NULL DEFAULT 0,
      notes_reviewed INTEGER NOT NULL DEFAULT 0,
      receipt_file TEXT,
      receipt_mime TEXT,
      is_demo INTEGER NOT NULL,
      staff_note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,   -- epoch ms (UTC)
      paid_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      unit_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      removed_json TEXT NOT NULL DEFAULT '[]',
      extras_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      line_total INTEGER NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
  `);
  // Origen del pedido: 'qr' (el cliente desde la carta) o 'caja' (ingresado por el cajero). Misma tabla.
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('source')) db.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'qr'");
  if (!cols.includes('created_by')) db.exec('ALTER TABLE orders ADD COLUMN created_by TEXT');
}

module.exports = { open, DATA_DIR, RECEIPTS_DIR, UPLOADS_DIR };
