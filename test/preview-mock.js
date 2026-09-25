'use strict';
// Simula localmente la base compartida (db), los archivos (assets) y el usuario (user) de claude.ai,
// para probar preview/rucka-monkey-preview.html con dos navegadores distintos antes de publicarla.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

function createMockServer() {
  const ROOT = path.join(__dirname, '..', 'preview');
  const docs = new Map([
    ['menu/catalog', JSON.parse(fs.readFileSync(path.join(ROOT, 'seed-catalog.json'), 'utf8'))],
    ['menu/settings', JSON.parse(fs.readFileSync(path.join(ROOT, 'seed-settings.json'), 'utf8'))],
  ]);
  const blobs = new Map();
  let version = 0;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/', (_req, res) => {
    const html = fs.readFileSync(path.join(ROOT, 'rucka-monkey-preview.html'), 'utf8');
    res.type('html').send('<!doctype html><html lang="es-CL"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script src="/_mock/claude.js"></script></head><body>' + html + '</body></html>');
  });
  app.get('/_mock/claude.js', (_req, res) => res.type('js').send(`(${clientMock.toString()})();`));
  app.get('/_mock/db', (_req, res) => res.json({ version, docs: Object.fromEntries(docs) }));
  app.post('/_mock/db', (req, res) => {
    const { op, path: p, data } = req.body;
    if (op === 'set') docs.set(p, data);
    if (op === 'update') { if (!docs.has(p)) return res.status(400).json({ code: 'invalid_argument' }); docs.set(p, { ...docs.get(p), ...data }); }
    if (op === 'delete') docs.delete(p);
    version++;
    res.json({ ok: true });
  });
  app.post('/_mock/upload', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
    const id = crypto.randomBytes(16).toString('hex');
    blobs.set(id, { type: req.get('content-type'), body: req.body });
    res.json({ id, url: `/_blob/${id}`, sizeBytes: req.body.length, contentType: req.get('content-type') });
  });
  app.get('/_blob/:id', (req, res) => {
    const b = blobs.get(req.params.id);
    if (!b) return res.sendStatus(404);
    res.type(b.type).send(b.body);
  });
  return { app, docs, blobs };
}

// Se ejecuta en el navegador: imita window.claude.use("db" | "assets" | "user").
function clientMock() {
  let cache = { version: -1, docs: {} };
  // Con la cookie snapfail=1 la suscripción en vivo falla como en claude.ai ("Invalid subscription id").
  const snapFail = /snapfail=1/.test(document.cookie);
  const subs = new Set();
  async function refresh() {
    const r = await (await fetch('/_mock/db')).json();
    if (r.version !== cache.version) { cache = r; subs.forEach((fn) => fn()); }
  }
  setInterval(refresh, 400);
  const snapDoc = (p) => ({ id: p.split('/').pop(), exists: p in cache.docs, data: () => cache.docs[p], metadata: { fromCache: false, hasPendingWrites: false } });
  const write = async (op, p, data) => {
    const r = await fetch('/_mock/db', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, path: p, data }) });
    if (!r.ok) throw { code: 'invalid_argument', message: 'mock' };
    await refresh();
  };
  const docRef = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => { await refresh(); return snapDoc(p); },
    set: (d) => write('set', p, d), update: (d) => write('update', p, d), delete: () => write('delete', p),
    onSnapshot(next, error) { if (snapFail) { setTimeout(() => error({ code: 'unavailable', message: 'Invalid subscription id.' }), 50); return () => {}; } const fn = () => next(snapDoc(p)); subs.add(fn); refresh().then(fn); return () => subs.delete(fn); },
  });
  const colRef = (c) => {
    const list = () => Object.keys(cache.docs).filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1).sort().map(snapDoc);
    return {
      path: c, doc: (id) => docRef(`${c}/${id || Math.random().toString(36).slice(2)}`),
      get: async () => { await refresh(); const d = list(); return { docs: d, size: d.length, empty: !d.length }; },
      onSnapshot(next, error) { if (snapFail) { setTimeout(() => error({ code: 'unavailable', message: 'Invalid subscription id.' }), 50); return () => {}; } const fn = () => { const d = list(); next({ docs: d, size: d.length, empty: !d.length, docChanges: () => [], metadata: {} }); }; subs.add(fn); refresh().then(fn); return () => subs.delete(fn); },
    };
  };
  const db = { doc: docRef, collection: colRef };
  const assets = {
    async upload(blob, opts = {}) { const r = await fetch('/_mock/upload', { method: 'POST', headers: { 'Content-Type': opts.type || blob.type }, body: blob }); return r.json(); },
    async delete() { return { deleted: true }; },
  };
  const owner = !/rol=cliente/.test(document.cookie);
  const user = { isOwner: async () => owner, canEdit: async () => owner, can: async () => true, id: async () => 'u_mock' };
  window.claude = { use: async (n) => ({ db, assets, user }[n] || null) };
}

module.exports = { createMockServer };
