'use strict';
// Empaqueta la carta y el panel en UN archivo HTML para la vista previa en claude.ai (Artifact).
// Reutiliza public/ tal cual, con pequeños ajustes de navegación (rutas con #) aplicados aquí.
// Uso: node scripts/build-preview.js  →  preview/rucka-monkey-preview.html + preview/seed-*.json
const fs = require('node:fs');
const path = require('node:path');
const { CATEGORIES, SETTINGS } = require('../server/seed.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const OUT = path.join(ROOT, 'preview');

function patch(src, pairs, name) {
  for (const [from, to] of pairs) {
    if (!src.includes(from)) throw new Error(`${name}: no se encontró el texto a reemplazar:\n${from}`);
    src = src.split(from).join(to);
  }
  return src;
}
const bodyOf = (html) => html.slice(html.indexOf('<body>') + 6, html.indexOf('<script')).trim();
const safeScript = (js) => js.replace(/<\/script/gi, '<\\/script');

const menuJs = patch(read('public/js/menu.js'), [
  ["location.pathname.match(/^\\/pedido\\/([A-Za-z0-9_-]+)$/)", "location.hash.match(/^#pedido\\/([A-Za-z0-9_-]+)$/)"],
  ["history.pushState({}, '', `/pedido/${r.token}`);", "history.pushState({}, '', `#pedido/${r.token}`);"],
  ['<a class="btn" href="/">Volver a la carta</a>', '<a class="btn" href="#" data-link>Volver a la carta</a>'],
  ['<a class="btn btn-block" href="/" id="backToMenu">', '<a class="btn btn-block" href="#" id="backToMenu">'],
  ['<a href="/pedido/${esc(last.token)}" data-link>', '<a href="#pedido/${esc(last.token)}" data-link>'],
], 'menu.js');

const adminJs = patch(read('public/js/admin.js'), [
  ["switchTab(location.hash.replace('#', '') || 'pedidos');", "switchTab('pedidos');"],
  ["    history.replaceState(null, '', `#${tab}`);\n", ''],
  ["state.orders.find((x) => x.id === Number(b.closest('[data-id]').dataset.id))", "state.orders.find((x) => String(x.id) === b.closest('[data-id]').dataset.id)"],
  ['<input class="input" id="qrBase" value="${esc(location.origin)}">', '<input class="input" id="qrBase" value="${esc(s.test_url || \'\')}" placeholder="https://claude.ai/...">'],
  // window.print() no funciona dentro de claude.ai
  ["foot: '<button class=\"btn btn-block\" data-print>Imprimir</button>',", "foot: '<p class=\"hint\" style=\"margin:0\">Para imprimirlo, toma una captura de pantalla.</p>',"],
  ["        $('[data-print]', sh.root).onclick = () => window.print();\n", ''],
  ['<form class="card-s" id="pwForm">', '<form class="card-s" id="pwForm" hidden>'],
  ['<button class="btn btn-block" id="logout">', '<button class="btn btn-block" id="logout" hidden>'],
  ['Para revisar la experiencia con tu teléfono. <b>No lo imprimas para clientes.</b>', 'Escanéalo con el otro teléfono para abrir esta vista previa como cliente. <b>No lo imprimas para clientes.</b>'],
], 'admin.js');

const adminBody = patch(bodyOf(read('public/admin.html')), [
  ['<h1>Caja Rucka Monkey</h1>', '<h1>Caja Rucka Monkey</h1><p class="notice notice-info">En la vista previa, la caja solo se abre para el dueño o los editores de esta página en claude.ai.</p>'],
], 'admin.html');
const menuBody = bodyOf(read('public/index.html'));

// Ilustraciones incrustadas como data: URI
const illusDir = path.join(ROOT, 'public/img/illus');
const illus = Object.fromEntries(fs.readdirSync(illusDir).filter((f) => f.endsWith('.svg')).sort()
  .map((f) => [f, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fs.readFileSync(path.join(illusDir, f), 'utf8'))]));

const qrLib = fs.readFileSync(require.resolve('qrcode-generator/qrcode.js'), 'utf8');

// La plataforma de claude.ai agrega <!doctype>, <html>, <head> y <body>: aquí va solo el contenido.
const html = `<title>Rucka Monkey Demo</title>
<meta name="description" content="Vista previa de la carta con pedidos y del panel de caja de Rucka Monkey (modo demostración)">
<style>${read('public/css/base.css')}
.pv-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--ink); color: var(--bg); font-size: 13px; font-weight: 700; }
.pv-bar span { flex: 1; }
.pv-bar button { min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1.5px solid rgba(255,255,255,.35); background: transparent; color: inherit; font-weight: 800; cursor: pointer; }
.pv-bar button.on { background: var(--bg); color: var(--ink); border-color: var(--bg); }
.pv-fatal { max-width: 520px; margin: 40px auto; padding: 16px; }
</style>
<template id="css-cliente">${read('public/css/menu.css')}</template>
<template id="css-caja">${read('public/css/admin.css')}
@media (min-width: 900px) { .pv-bar { margin-left: 200px; } }</template>
<div class="pv-bar" role="navigation" aria-label="Vista"><span>Vista previa</span>
  <button data-mode="cliente">Cliente</button><button data-mode="caja">Caja</button></div>
<div id="pvRoot"></div>
<template id="tpl-cliente">${menuBody}</template>
<template id="tpl-caja">${adminBody}</template>
<script>${safeScript(qrLib)}</script>
<script>window.RM_ILLUSTRATIONS = ${JSON.stringify(illus)};</script>
<script>${safeScript(read('public/js/common.js'))}</script>
<script>${safeScript(read('preview/backend.js'))}</script>
<script>
(function () {
  'use strict';
  var KEY = 'rm_preview_mode';
  var mode = 'cliente';
  try { mode = localStorage.getItem(KEY) || 'cliente'; } catch (e) { /* sin almacenamiento */ }
  if (/^#pedido\\//.test(location.hash)) mode = 'cliente';
  if (mode !== 'caja') mode = 'cliente';
  document.querySelectorAll('.pv-bar [data-mode]').forEach(function (b) {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.addEventListener('click', function () {
      if (b.dataset.mode === mode) return;
      try { localStorage.setItem(KEY, b.dataset.mode); } catch (e) { /* */ }
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      location.reload();
    });
  });
  var style = document.createElement('style');
  style.textContent = document.getElementById('css-' + mode).content.textContent;
  document.head.appendChild(style);
  document.getElementById('pvRoot').innerHTML = document.getElementById('tpl-' + mode).innerHTML;
  RM.api = RMPreview.api;
  RMPreview.init().then(function () {
    if (mode === 'caja') runAdmin(); else runMenu();
  }).catch(function (err) {
    document.getElementById('pvRoot').innerHTML = '<div class="pv-fatal"><p class="notice notice-bad" style="border-radius:12px;padding:12px;background:var(--bad-bg);color:var(--bad)"></p></div>';
    document.querySelector('.pv-fatal p').textContent = 'No se pudo cargar la carta desde la base de datos compartida (' + (err && (err.code || err.message) || err) + '). Recarga la página; si sigue, avísale a Claude con este mensaje.';
  });
  function runMenu() {
${safeScript(menuJs)}
  }
  function runAdmin() {
${safeScript(adminJs)}
  }
})();
</script>
`;

// Datos iniciales (mismo contenido que la base del servidor)
let nextId = 1;
const catalog = { categories: [], products: [] };
CATEGORIES.forEach((c, ci) => {
  const cid = nextId++;
  catalog.categories.push({ id: cid, name: c.name, sort: ci + 1, active: true });
  c.products.forEach((p, pi) => {
    catalog.products.push({
      id: nextId++, categoryId: cid, name: p.name, description: p.desc, descriptionProvisional: true, price: p.price, priceIsTest: true,
      illustration: p.illus, photo: null, isPlaceholder: !!p.placeholder, active: true, sort: pi + 1,
      ingredients: p.ing.map((g) => ({ id: nextId++, name: g.name, removable: g.removable, provisional: g.provisional })),
      extras: [],
    });
  });
});
catalog.nextId = nextId;
const settings = { ...SETTINGS };
delete settings.order_counter;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'rucka-monkey-preview.html'), html);
fs.writeFileSync(path.join(OUT, 'seed-catalog.json'), JSON.stringify(catalog, null, 1));
fs.writeFileSync(path.join(OUT, 'seed-settings.json'), JSON.stringify(settings, null, 1));
console.log(`preview/rucka-monkey-preview.html (${(html.length / 1024).toFixed(0)} KB) + seed-catalog.json + seed-settings.json`);
