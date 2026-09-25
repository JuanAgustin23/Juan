'use strict';
// Prueba de navegador con DOS TELÉFONOS: un cliente que escanea el QR y un cajero que recibe el pedido.
// Luego revisa que ambas vistas se adapten a computador. Guarda capturas en docs/capturas/.
// Uso: node test/e2e-dos-telefonos.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-e2e-'));
process.env.ADMIN_PASSWORD = 'clave-cajero-2026';
const { createApp } = require('../server/index.js');

const SHOTS = path.join(__dirname, '..', 'docs', 'capturas');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log('  ✔ ' + m);

// Teléfono del cliente (tamaño iPhone 13/14) y del cajero (Android de gama media).
const CLIENTE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', timezoneId: 'America/Santiago',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const CAJERO = { viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'es-CL', timezoneId: 'America/Santiago',
  userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A145M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' };

async function noHorizontalScroll(page, where) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(r.sw <= r.w, `${where}: hay desplazamiento horizontal (${r.sw} > ${r.w})`);
}
// Botones visibles demasiado pequeños para tocar con el dedo
async function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a.btn, label.btn, input[type=checkbox], select, .chips button')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => { const r = el.getBoundingClientRect(); return { t: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30), w: r.width, h: r.height }; })
    .filter((b) => b.w > 0 && (b.h < 24 || b.w < 24) || (b.h < 36 && b.t !== 'INPUT')));
}
const shot = async (page, name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(SHOTS, name), fullPage: false }); };

(async () => {
  const { app } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const receiptPath = path.join(process.env.DATA_DIR, 'comprobante.png');

  try {
    console.log('\n[Teléfono del CAJERO] inicia sesión');
    const cajeroCtx = await browser.newContext(CAJERO);
    const caja = await cajeroCtx.newPage();
    await caja.goto(`${BASE}/caja`);
    await caja.fill('#pw', 'clave-cajero-2026');
    await caja.click('#loginForm button');
    await caja.waitForSelector('#shell:not([hidden])');
    assert.ok(await caja.isVisible('#demoBanner'), 'banner de demostración visible en caja');
    log('sesión iniciada y aviso “Modo demostración” visible');

    // QR de prueba generado desde el panel en el mismo celular
    await caja.click('[data-tab=ajustes]');
    await caja.waitForSelector('#qrTest');
    await caja.fill('#qrBase', BASE);
    await caja.click('#qrTest');
    const qrEl = await caja.waitForSelector('.sheet .qr-svg svg');
    const qrBuf = await qrEl.screenshot();
    const qrPng = PNG.sync.read(qrBuf);
    const decoded = jsQR(new Uint8ClampedArray(qrPng.data), qrPng.width, qrPng.height);
    assert.ok(decoded, 'el QR se puede leer');
    assert.equal(decoded.data, `${BASE}/?origen=qr-prueba`);
    await shot(caja, 'cajero-qr-prueba.png');
    const [descarga] = await Promise.all([caja.waitForEvent('download'), caja.click('.sheet [data-download]')]);
    assert.match(descarga.suggestedFilename(), /^QR-PRUEBA-NO-PUBLICAR.*\.png$/);
    const qrFile = path.join(SHOTS, '..', 'qr-prueba-descargado.png');
    await descarga.saveAs(qrFile);
    const dq = PNG.sync.read(fs.readFileSync(qrFile));
    assert.equal(jsQR(new Uint8ClampedArray(dq.data), dq.width, dq.height).data, `${BASE}/?origen=qr-prueba`);
    fs.rmSync(qrFile);
    log('QR descargado como PNG y leído: abre solo la carta');
    await noHorizontalScroll(caja, 'ajustes (celular)');
    log(`QR de prueba leído correctamente → ${decoded.data}`);
    await caja.click('.sheet [data-close]');
    await caja.click('[data-tab=pedidos]');
    await caja.waitForSelector('#orders .empty');

    console.log('\n[Teléfono del CLIENTE] escanea el QR y arma su pedido');
    const clienteCtx = await browser.newContext(CLIENTE);
    const cli = await clienteCtx.newPage();
    await cli.goto(decoded.data);
    await cli.waitForSelector('.card');
    assert.ok(await cli.isVisible('#demoBanner'));
    assert.ok(await cli.isVisible('text=Precio de prueba'));
    assert.ok(await cli.isVisible('.thumb .tag >> text=Ilustración'));
    await noHorizontalScroll(cli, 'carta (celular)');
    assert.equal(await cli.evaluate(() => document.querySelectorAll('a[href*="caja"], a[href*="admin"], [data-mode]').length), 0, 'la carta no tiene enlaces al panel');
    // El cliente escribe a mano la dirección del panel: ve el inicio de sesión y nada más
    const intruso = await clienteCtx.newPage();
    await intruso.goto(`${BASE}/caja`);
    await intruso.waitForSelector('#login:not([hidden])');
    assert.equal(await intruso.locator('.order, .kpi, .prod').count(), 0);
    const internas = await intruso.evaluate(async () => Promise.all(['/api/admin/orders', '/api/admin/stats', '/api/admin/catalog', '/api/admin/settings'].map(async (u) => (await fetch(u)).status)));
    assert.deepEqual(internas, [401, 401, 401, 401]);
    const edit = await intruso.evaluate(async () => (await fetch('/api/admin/products/1', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rucka' }, body: '{"price":1}' })).status);
    assert.equal(edit, 401);
    await shot(intruso, 'cliente-intenta-abrir-caja.png');
    await intruso.close();
    log('la carta no enlaza al panel; escribir /caja sin sesión no muestra pedidos ni permite editar');
    await shot(cli, 'cliente-carta.png');
    log('carta abierta: categorías, imágenes rotuladas como ilustración, precios de prueba');

    const addProduct = async (name, { quitar = [], nota = '', mas = 0 } = {}) => {
      await cli.locator('.card', { hasText: name }).first().click();
      await cli.waitForSelector('.sheet');
      for (const q of quitar) await cli.locator('.sheet label.check', { hasText: `Sin ${q}` }).click();
      if (nota) await cli.fill('#pdNote', nota);
      for (let k = 0; k < mas; k++) await cli.click('.sheet [data-q="1"]');
      return cli.click('#pdAdd');
    };
    // Sándwich 1: sin tomate, "bien tostado"
    await cli.locator('.card', { hasText: 'ASS normal' }).click();
    await cli.waitForSelector('.sheet');
    await cli.locator('.sheet label.check', { hasText: 'Sin Tomate' }).click();
    await cli.fill('#pdNote', 'bien tostado');
    await noHorizontalScroll(cli, 'personalización (celular)');
    await shot(cli, 'cliente-personalizar.png');
    await cli.click('#pdAdd');
    await cli.waitForSelector('.sheet', { state: 'detached' });
    // Sándwich 2: MISMO producto, otra indicación → línea separada
    await addProduct('ASS normal', { quitar: ['Mayonesa'], nota: 'agregar mostaza' });
    await cli.waitForSelector('.sheet', { state: 'detached' });
    await addProduct('Papas fritas medianas', { mas: 1 });
    await cli.waitForSelector('.sheet', { state: 'detached' });
    await addProduct('Agua mineral (ejemplo)');
    await cli.waitForSelector('.sheet', { state: 'detached' });

    await cli.click('#openCart');
    await cli.waitForSelector('#lines');
    assert.equal(await cli.locator('.line', { hasText: 'ASS normal' }).count(), 2, 'dos líneas separadas del mismo sándwich');
    const lineas = await cli.locator('.line').allInnerTexts();
    assert.ok(lineas[0].includes('SIN Tomate') && lineas[0].includes('bien tostado'));
    assert.ok(lineas[1].includes('SIN Mayonesa') && lineas[1].includes('agregar mostaza'));
    // Sumas y restas en el carrito: agua 1 → 3 → 2
    const agua = cli.locator('.line', { hasText: 'Agua mineral' });
    await agua.locator('[data-step="1"]').click();
    await cli.locator('.line', { hasText: 'Agua mineral' }).locator('[data-step="1"]').click();
    await cli.locator('.line', { hasText: 'Agua mineral' }).locator('[data-step="-1"]').click();
    const menu = await (await fetch(`${BASE}/api/menu`)).json();
    const price = (n) => menu.categories.flatMap((c) => c.products).find((p) => p.name === n).price;
    const esperado = price('ASS normal') * 2 + price('Papas fritas medianas') * 2 + price('Agua mineral (ejemplo)') * 2;
    const totalTxt = await cli.locator('.sheet .total-row span').last().innerText();
    assert.equal(Number(totalTxt.replace(/\D/g, '')), esperado);
    await noHorizontalScroll(cli, 'carrito (celular)');
    await shot(cli, 'cliente-carrito.png');
    log(`carrito: 2 líneas de “ASS normal” con indicaciones distintas; sumas/restas OK; total ${totalTxt}`);

    await cli.click('#toCheckout');
    await cli.waitForSelector('#coName');
    await cli.fill('#coName', 'Camila');
    await cli.locator('.pay-opt', { hasText: 'Transferencia' }).click();
    assert.ok(await cli.isVisible('text=DATOS DE PRUEBA — NO TRANSFERIR'));
    // Imagen de comprobante de ejemplo generada en la prueba
    const img = new PNG({ width: 200, height: 120 });
    img.data.fill(245);
    // Barras oscuras que simulan texto del comprobante
    for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) {
      if ((y % 20 < 8 && x > 20 && x < 20 + ((y * 37) % 150)) || y < 14) { const i = (y * 200 + x) * 4; img.data[i] = 40; img.data[i + 1] = 60; img.data[i + 2] = 120; }
    }
    fs.writeFileSync(receiptPath, PNG.sync.write(img));
    await cli.setInputFiles('#coReceipt', receiptPath);
    await cli.waitForSelector('#coPreview:not([hidden])');
    await noHorizontalScroll(cli, 'checkout (celular)');
    await shot(cli, 'cliente-pago.png');
    await cli.click('#coSend');
    await cli.waitForURL(/\/pedido\//);
    await cli.waitForSelector('.order-code');
    const code = await cli.innerText('.order-code');
    assert.match(code, /^DEMO-\d{4}$/);
    await shot(cli, 'cliente-estado-pendiente.png');
    log(`pedido enviado: ${code} (queda “Pendiente” hasta que caja verifique el abono)`);

    console.log('\n[Teléfono del CAJERO] recibe el pedido sin recargar');
    const card = caja.locator('.order', { hasText: code });
    await card.waitFor({ timeout: 10000 });
    const txt = await card.innerText();
    for (const s of ['Camila', 'SIN Tomate', 'bien tostado', 'SIN Mayonesa', 'agregar mostaza', 'Transferencia', 'Comprobante', 'DEMO']) assert.ok(txt.includes(s), `la tarjeta muestra “${s}”`);
    assert.equal(await card.locator('.o-items > li', { hasText: 'ASS normal' }).count(), 2);
    await noHorizontalScroll(caja, 'pedidos (celular)');
    await shot(caja, 'cajero-pedido-nuevo.png');
    const chicos = await smallTargets(caja);
    assert.deepEqual(chicos, [], 'botones del panel con tamaño táctil suficiente');
    log('pedido nuevo apareció solo (actualización automática), con todas las indicaciones y botones grandes');

    await card.locator('[data-act=receipt]').click();
    await caja.waitForSelector('.receipt-view img');
    assert.ok(await caja.locator('.receipt-view img').evaluate((i) => i.complete && i.naturalWidth > 0), 'comprobante visible para caja');
    await shot(caja, 'cajero-comprobante.png');
    await caja.click('.sheet [data-close]');
    log('comprobante abierto de forma privada');

    await card.locator('[data-act=next]').click();
    await caja.waitForSelector('.sheet [data-ok]');
    assert.ok(await caja.locator('.sheet [data-ok]').isDisabled(), 'no se puede confirmar sin marcar las verificaciones');
    await caja.check('#cNotes');
    assert.ok(await caja.locator('.sheet [data-ok]').isDisabled(), 'falta verificar el abono');
    await noHorizontalScroll(caja, 'confirmar pago (celular)');
    await shot(caja, 'cajero-confirmar-pago.png');
    await caja.check('#cPay');
    await caja.click('.sheet [data-ok]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    log('pago confirmado tras revisar indicaciones y verificar el abono');

    for (const [boton, estado] of [['Enviar a preparación', 'En preparación'], ['Marcar como listo', 'Listo para retirar']]) {
      await caja.locator('.order', { hasText: code }).locator('button', { hasText: boton }).click();
      await caja.locator('.order', { hasText: code }).locator('.tag', { hasText: estado }).waitFor();
    }
    await cli.waitForSelector('.steps li.now:has-text("Listo para retirar")', { timeout: 10000 });
    await shot(cli, 'cliente-estado-listo.png');
    log('el celular del cliente se actualizó solo a “Listo para retirar”');
    await caja.locator('.order', { hasText: code }).locator('button', { hasText: 'Marcar entregado' }).click();
    await caja.waitForFunction((c) => ![...document.querySelectorAll('.order')].some((o) => o.innerText.includes(c)), code);
    log('entregado (sale de la lista de activos)');

    console.log('\n[Teléfono del CAJERO] edita un producto y su precio');
    await caja.click('[data-tab=productos]');
    await caja.locator('.prod', { hasText: 'Completo italiano normal' }).locator('.prod-main').click();
    await caja.waitForSelector('#pf');
    await caja.fill('#pf [name=price]', '2700');
    await caja.locator('.sheet label.check', { hasText: 'precio de prueba' }).click();
    await caja.click('#addExt');
    await caja.locator('#extList [data-f=name]').last().fill('Extra palta');
    await caja.locator('#extList [data-f=price]').last().fill('700');
    await noHorizontalScroll(caja, 'editor de producto (celular)');
    await shot(caja, 'cajero-editar-producto.png');
    await caja.click('.sheet [data-save]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    await caja.locator('.prod', { hasText: 'Completo italiano normal' }).locator('text=$2.700').waitFor();
    await noHorizontalScroll(caja, 'productos (celular)');
    await shot(caja, 'cajero-productos.png');
    await cli.goto(BASE);
    const it = cli.locator('.card', { hasText: 'Completo italiano normal' });
    await it.locator('text=$2.700').waitFor();
    assert.equal(await it.locator('text=Precio de prueba').count(), 0);
    log('precio cambiado desde el celular y visible de inmediato en la carta del cliente');

    await caja.click('[data-tab=resumen]');
    await caja.waitForSelector('.kpi');
    await shot(caja, 'cajero-resumen.png');
    await noHorizontalScroll(caja, 'resumen (celular)');
    log('resumen del día en hora de Chile');

    console.log('\n[COMPUTADOR] ambas vistas se adaptan');
    const pc = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'es-CL', timezoneId: 'America/Santiago' });
    const pcCli = await pc.newPage();
    await pcCli.goto(BASE);
    await pcCli.waitForSelector('.card');
    const cols = await pcCli.evaluate(() => getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length);
    assert.ok(cols >= 3, 'carta en 3 columnas en computador');
    await noHorizontalScroll(pcCli, 'carta (computador)');
    await pcCli.screenshot({ path: path.join(SHOTS, 'pc-carta.png') });
    const pcCaja = await pc.newPage();
    // Otro pedido en espera para ver el panel con contenido
    await pcCli.locator('.card', { hasText: 'Chorrillana grande' }).click();
    await pcCli.fill('#pdNote', '¿pueden poner queso cheddar?');
    await pcCli.click('#pdAdd');
    await pcCli.click('#openCart');
    await pcCli.click('#toCheckout');
    await pcCli.fill('#coName', 'Diego');
    await pcCli.locator('.pay-opt', { hasText: 'Efectivo' }).click();
    await pcCli.click('#coSend');
    await pcCli.waitForSelector('.order-code');
    await pcCaja.goto(`${BASE}/caja`);
    await pcCaja.fill('#pw', 'clave-cajero-2026');
    await pcCaja.click('#loginForm button');
    await pcCaja.locator('.order', { hasText: 'Diego' }).waitFor({ timeout: 10000 });
    assert.ok((await pcCaja.locator('.order', { hasText: 'Diego' }).innerText()).includes('queso cheddar'));
    const sidebar = await pcCaja.evaluate(() => getComputedStyle(document.querySelector('.tabs')).width);
    await noHorizontalScroll(pcCaja, 'panel (computador)');
    await pcCaja.screenshot({ path: path.join(SHOTS, 'pc-caja.png') });
    log(`carta en ${cols} columnas; panel con navegación lateral (${sidebar})`);
    await pcCaja.click('[data-tab=productos]');
    await pcCaja.waitForSelector('.prod');
    await noHorizontalScroll(pcCaja, 'productos (computador)');
    await pcCaja.screenshot({ path: path.join(SHOTS, 'pc-productos.png') });

    console.log('\nTODO OK — capturas en docs/capturas/\n');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('\n✘ FALLÓ:', e.message); process.exit(1); });
