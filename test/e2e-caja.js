'use strict';
// Turno de caja completo en navegador, con dos teléfonos (cliente y cajero).
// Uso: node test/e2e-caja.js   → capturas en docs/capturas/caja/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-e2e-caja-'));
process.env.ADMIN_PASSWORD = 'clave-cajero-2026';
const { createApp } = require('../server/index.js');
const OUT = path.join(__dirname, '..', 'docs', 'capturas', 'caja');
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => console.log('  ✔ ' + m);
const PHONE = { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', timezoneId: 'America/Santiago' };
const num = (t) => Number(String(t).replace(/\D/g, ''));

(async () => {
  const server = createApp().app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const shot = async (p, n) => { await p.waitForTimeout(350); await p.screenshot({ path: path.join(OUT, n) }); };
  const noHScroll = async (p, w) => { const r = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(r <= 0, `${w}: desplazamiento horizontal`); };
  const receipt = path.join(process.env.DATA_DIR, 'comp.png');
  const img = new PNG({ width: 60, height: 40 }); img.data.fill(210); fs.writeFileSync(receipt, PNG.sync.write(img));
  try {
    // ---- Cajero abre la caja ----
    const caja = await (await browser.newContext(PHONE)).newPage();
    caja.on('pageerror', (e) => errors.push(e.message));
    await caja.goto(`${BASE}/caja`);
    await caja.fill('#pw', 'clave-cajero-2026');
    await caja.click('#loginForm button');
    await caja.waitForSelector('#shell:not([hidden])');
    await caja.click('[data-tab=caja]');
    await caja.waitForSelector('#tsOpen');
    await caja.fill('#tsOpenCash', '20000');
    await caja.fill('#tsBy', 'Juan');
    await shot(caja, '1-abrir-caja.png');
    await noHScroll(caja, 'abrir caja');
    await caja.click('#tsOpen');
    await caja.waitForSelector('.shift-open');
    log('turno abierto con $20.000 por Juan');

    // ---- Cliente hace 3 pedidos ----
    const cli = await (await browser.newContext(PHONE)).newPage();
    cli.on('pageerror', (e) => errors.push(e.message));
    const pedir = async (items, pay, conComprobante) => {
      await cli.goto(BASE);
      for (const [name, qty] of items) {
        await cli.locator('.card', { hasText: name }).first().click();
        for (let i = 1; i < qty; i++) await cli.click('.sheet [data-q="1"]');
        await cli.click('#pdAdd');
        await cli.waitForSelector('.sheet', { state: 'detached' });
      }
      await cli.click('#openCart');
      await cli.click('#toCheckout');
      await cli.fill('#coName', pay === 'efectivo' ? 'Pedro' : 'Camila');
      await cli.locator('.pay-opt', { hasText: pay === 'efectivo' ? 'Efectivo' : 'Transferencia' }).click();
      if (conComprobante) await cli.setInputFiles('#coReceipt', receipt);
      await cli.click('#coSend');
      await cli.waitForSelector('.order-code');
      return cli.innerText('.order-code');
    };
    const cCash = await pedir([['Completo italiano normal', 1]], 'efectivo');
    const cTransfer = await pedir([['ASS normal', 2]], 'transferencia', true);
    const cPend = await pedir([['Aros de cebolla', 1]], 'transferencia', true);
    log(`cliente envió ${cCash} (efectivo), ${cTransfer} (transferencia con comprobante) y ${cPend} (transferencia pendiente)`);

    // ---- Cajero cobra en Pedidos ----
    await caja.click('[data-tab=pedidos]');
    const card = (c) => caja.locator('.order', { hasText: c });
    await card(cPend).waitFor({ timeout: 10000 });
    await card(cCash).locator('[data-act=next]').click();
    await caja.check('#cPay');
    await caja.waitForTimeout(400);
    assert.equal(await caja.locator('.sheet .notice', { hasText: 'No hay un turno de caja abierto' }).count(), 0, 'con turno abierto no aparece el aviso');
    await caja.click('.sheet [data-ok]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    await card(cTransfer).locator('[data-act=next]').click();
    await caja.check('#cPay');
    await caja.click('.sheet [data-ok]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    log(`cobrados: ${cCash} en efectivo y ${cTransfer} por transferencia verificada; ${cPend} queda pendiente (su comprobante no cuenta)`);

    // ---- Turno en vivo ----
    await caja.click('[data-tab=caja]');
    await caja.waitForFunction(() => document.querySelector('.expected b')?.textContent.replace(/\D/g, '') === '22500', null, { timeout: 5000 });
    assert.equal(num(await caja.innerText('.expected b')), 22500, '20.000 + 2.500');
    assert.equal(num(await caja.innerText('.shift-open .transfer-box b')), 9000);
    await shot(caja, '2-turno-abierto.png');
    await noHScroll(caja, 'turno abierto');
    const small = await caja.evaluate(() => [...document.querySelectorAll('#caja button, #caja input')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.id || e.textContent.trim()));
    assert.deepEqual(small, [], 'botones y campos de Caja con tamaño táctil suficiente');
    log('turno en vivo: efectivo esperado $22.500 y transferencias $9.000 por separado');

    // ---- Retiro ----
    await caja.click('#tsOut');
    await caja.fill('#mvAmount', '5000');
    await caja.fill('#mvReason', 'Compra de pan en el almacén');
    await shot(caja, '3-retiro.png');
    await caja.click('.sheet [data-save]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    await caja.waitForFunction(() => document.querySelector('.expected b')?.textContent.replace(/\D/g, '') === '17500');
    assert.ok((await caja.innerText('.moves')).includes('Compra de pan'));
    log('retiro de $5.000 registrado con motivo, hora y responsable');

    // ---- Cierre con conteo ----
    await caja.click('#tsClose');
    await caja.waitForSelector('#clCounted');
    assert.ok((await caja.innerText('.sheet .pend')).includes(cPend), 'el pedido pendiente aparece para revisarlo');
    await caja.fill('#clCounted', '17000');
    await caja.waitForSelector('.calc-diff.minus');
    assert.match(await caja.innerText('.sheet .calc-diff'), /Faltante \$500/);
    await caja.click('.sheet [data-go]');
    await caja.waitForTimeout(300);
    assert.equal(await caja.locator('.sheet #clCounted').count(), 1, 'sin marcar "Revisé los pendientes" no cierra');
    await caja.check('#clRev');
    await caja.fill('#clNote', 'Vuelto mal dado a un cliente');
    await caja.evaluate(() => document.querySelector('#clCounted').scrollIntoView({ block: 'center' }));
    await shot(caja, '4-cerrar-turno.png');
    await noHScroll(caja, 'cerrar turno');
    await caja.click('.sheet [data-go]');
    await caja.waitForSelector('.shift-dl');
    const detalle = await caja.innerText('.sheet');
    for (const s of ['Juan', 'Faltante $500', '$17.500', '$17.000', '$9.000', 'Compra de pan', cCash, cTransfer]) assert.ok(detalle.includes(s), `el cierre muestra ${s}`);
    await shot(caja, '5-cierre-guardado.png');
    await caja.click('.sheet [data-close]');
    await caja.waitForSelector('.hist-btn');
    await shot(caja, '6-historial.png');
    assert.match(await caja.innerText('.hist'), /Faltante \$500/);
    log('turno cerrado: esperado $17.500, contado $17.000 → FALTANTE $500; queda en el historial del día');

    // ---- Corrección posterior ----
    await caja.click('[data-tab=pedidos]');
    await caja.locator('[data-filter=todos]').click();
    await card(cTransfer).locator('[data-act=reject]').click().catch(() => {});
    if (!(await caja.locator('#rr').count())) {
      // Un pedido entregado/pagado sin botón rechazar: se avanza a preparación y se rechaza desde ahí
      await card(cTransfer).locator('[data-act=next]').click();
      await card(cTransfer).locator('[data-act=reject]').click();
    }
    await caja.selectOption('#rr', 'Otro');
    await caja.click('.sheet [data-go]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    await caja.click('[data-tab=caja]');
    await caja.waitForSelector('.hist-btn');
    await caja.locator('.hist-btn').first().click();
    await caja.waitForSelector('.shift-dl');
    const corr = await caja.innerText('.sheet');
    assert.ok(corr.includes('Correcciones después del cierre') && corr.includes('Juan'), 'la corrección queda registrada con responsable');
    assert.ok(corr.includes('Faltante $500'), 'el cierre original no cambia');
    await caja.evaluate(() => [...document.querySelectorAll('.sheet h3')].find((h) => h.textContent.includes('Correcciones'))?.scrollIntoView());
    await shot(caja, '7-correccion.png');
    log('rechazar después del cierre deja una corrección con responsable; el cierre guardado no cambia');

    assert.deepEqual(errors, []);
    console.log('\nCAJA OK — capturas en docs/capturas/caja/\n');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('\n✘ FALLÓ:', e.message); process.exit(1); });
