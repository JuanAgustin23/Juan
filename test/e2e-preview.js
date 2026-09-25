'use strict';
// Prueba la VISTA PREVIA (un solo HTML para claude.ai) con dos teléfonos distintos que comparten
// la base de datos simulada. Uso: node scripts/build-preview.js && node test/e2e-preview.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { createMockServer } = require('./preview-mock');

const log = (m) => console.log('  ✔ ' + m);
const PHONE = { viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', timezoneId: 'America/Santiago' };
const noHScroll = async (page, where) => {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  assert.ok(r.sw <= r.w, `${where}: desplazamiento horizontal ${r.sw} > ${r.w}`);
};

(async () => {
  const { app, docs } = createMockServer();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const cajaCtx = await browser.newContext(PHONE);
    // Los dos teléfonos simulan el fallo de la suscripción en vivo que se vio en claude.ai
    await cajaCtx.addCookies([{ name: 'snapfail', value: '1', url: BASE }]);
    const caja = await cajaCtx.newPage();
    caja.on('pageerror', (e) => errors.push('caja: ' + e.message));
    await caja.goto(BASE + '#caja');
    await caja.waitForSelector('#shell:not([hidden])');
    await caja.waitForSelector('#orders .empty');
    await noHScroll(caja, 'caja');
    log('teléfono del cajero: vista Caja abierta sin contraseña (dueño de la página)');

    const cliCtx = await browser.newContext(PHONE);
    await cliCtx.addCookies([{ name: 'rol', value: 'cliente', url: BASE }, { name: 'snapfail', value: '1', url: BASE }]);
    const cli = await cliCtx.newPage();
    cli.on('pageerror', (e) => errors.push('cliente: ' + e.message));
    await cli.goto(BASE);
    await cli.waitForSelector('.card');
    assert.ok(await cli.isVisible('#demoBanner'));
    const cardImg = await cli.locator('.card img').first().evaluate((i) => i.complete && i.naturalWidth > 0);
    assert.ok(cardImg, 'ilustraciones cargan');
    await noHScroll(cli, 'carta');
    log('teléfono del cliente: carta con ilustraciones y modo demostración');

    const add = async (name, quitar, nota) => {
      await cli.locator('.card', { hasText: name }).first().click();
      await cli.waitForSelector('.sheet');
      if (quitar) await cli.locator('.sheet label.check', { hasText: `Sin ${quitar}` }).click();
      if (nota) await cli.fill('#pdNote', nota);
      await cli.click('#pdAdd');
      await cli.waitForSelector('.sheet', { state: 'detached' });
    };
    await add('ASS normal', 'Tomate', 'bien tostado');
    await add('ASS normal', 'Mayonesa', 'agregar mostaza');
    await cli.click('#openCart');
    assert.equal(await cli.locator('.line', { hasText: 'ASS normal' }).count(), 2);
    await cli.click('#toCheckout');
    await cli.fill('#coName', 'Camila');
    await cli.locator('.pay-opt', { hasText: 'Transferencia' }).click();
    const png = new PNG({ width: 80, height: 60 });
    png.data.fill(200);
    const rp = path.join(os.tmpdir(), 'rm-prev-comprobante.png');
    fs.writeFileSync(rp, PNG.sync.write(png));
    await cli.setInputFiles('#coReceipt', rp);
    await cli.click('#coSend');
    await cli.waitForSelector('.order-code');
    const code = await cli.innerText('.order-code');
    log(`pedido ${code} enviado con comprobante`);

    const card = caja.locator('.order', { hasText: code });
    await card.waitFor({ timeout: 10000 });
    const t = await card.innerText();
    for (const s of ['SIN Tomate', 'bien tostado', 'SIN Mayonesa', 'agregar mostaza', 'Comprobante']) assert.ok(t.includes(s), s);
    await card.locator('[data-act=receipt]').click();
    assert.ok(await caja.locator('.receipt-view img').evaluate((i) => new Promise((ok) => (i.complete ? ok(i.naturalWidth > 0) : (i.onload = () => ok(true))))));
    await caja.click('.sheet [data-close]');
    log('el cajero recibió el pedido solo, con indicaciones y comprobante');

    await card.locator('[data-act=next]').click();
    await caja.check('#cNotes');
    await caja.check('#cPay');
    await caja.click('.sheet [data-ok]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    await caja.locator('.order', { hasText: code }).locator('button', { hasText: 'Enviar a preparación' }).click();
    await caja.locator('.order', { hasText: code }).locator('button', { hasText: 'Marcar como listo' }).click();
    await cli.waitForSelector('.steps li.now:has-text("Listo para retirar")', { timeout: 10000 });
    log('pago confirmado y estados avanzados; el cliente vio “Listo para retirar”');

    await caja.click('[data-tab=productos]');
    await caja.locator('.prod', { hasText: 'Fajitas' }).locator('.prod-main').click();
    await caja.fill('#pf [name=price]', '5990');
    await caja.click('.sheet [data-save]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    await cli.click('#backToMenu');
    await cli.reload();
    await cli.locator('.card', { hasText: 'Fajitas' }).locator('text=$5.990').waitFor();
    log('precio editado desde el celular del cajero y visible en la carta');

    await caja.click('[data-tab=ajustes]');
    await caja.fill('#qrBase', 'https://claude.ai/artifact/prueba');
    await caja.click('#qrTest');
    await caja.waitForSelector('.sheet .qr-svg svg, .sheet .qr-svg img');
    await caja.click('.sheet [data-close]');
    await caja.click('#delDemo');
    await caja.click('.sheet [data-yes]');
    await caja.waitForFunction(() => document.querySelector('.toast')?.innerText.includes('borrados'));
    assert.equal([...docs.keys()].filter((k) => k.startsWith('orders/')).length, 0);
    log('QR de prueba generado y pedidos de demostración borrados');

    // Un cliente sin permisos de edición no puede abrir la caja
    assert.equal(await cli.evaluate(() => document.querySelectorAll('.pv-bar, [data-mode], a[href*="caja"]').length), 0, 'la carta no enlaza a la caja');
    await cli.goto(BASE + '#caja');
    await cli.reload();
    await cli.waitForSelector('#login:not([hidden])');
    log('un visitante que no es dueño ni editor ve la caja bloqueada');

    assert.deepEqual(errors, [], 'sin errores de JavaScript');
    console.log('\nVISTA PREVIA OK\n');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('\n✘ FALLÓ:', e.message); process.exit(1); });
