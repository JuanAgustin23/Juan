'use strict';
// "Nuevo pedido" en caja + un pedido por QR en el mismo turno. Uso: node test/e2e-mostrador.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-e2e-mo-'));
process.env.ADMIN_PASSWORD = 'clave-cajero-2026';
const { createApp } = require('../server/index.js');
const OUT = path.join(__dirname, '..', 'docs', 'capturas', 'mostrador');
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => console.log('  ✔ ' + m);
const PHONE = { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', timezoneId: 'America/Santiago' };
const num = (t) => Number(String(t).replace(/\D/g, ''));

(async () => {
  const server = createApp().app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const menu = await (await fetch(BASE + '/api/menu')).json();
  const price = (n) => menu.categories.flatMap((c) => c.products).find((p) => p.name === n).price;
  const browser = await chromium.launch();
  const errors = [];
  const shot = async (p, n) => { await p.waitForTimeout(350); await p.screenshot({ path: path.join(OUT, n) }); };
  const noHScroll = async (p, w) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}: desplazamiento horizontal`);
  try {
    const caja = await (await browser.newContext(PHONE)).newPage();
    caja.on('pageerror', (e) => errors.push(e.message));
    await caja.goto(`${BASE}/caja`);
    await caja.fill('#pw', 'clave-cajero-2026');
    await caja.click('#loginForm button');
    await caja.waitForSelector('#shell:not([hidden])');
    await caja.click('[data-tab=caja]');
    await caja.fill('#tsOpenCash', '10000');
    await caja.fill('#tsBy', 'Ana');
    await caja.click('#tsOpen');
    await caja.waitForSelector('.shift-open');
    await caja.click('[data-tab=pedidos]');
    assert.ok(await caja.isVisible('#newOrder'), 'botón "Nuevo pedido" visible en el panel móvil');
    await shot(caja, '1-pedidos-boton.png');

    // ---- Pedido manual: 2 italianos con "+" y 1 ASS personalizado ----
    await caja.click('#newOrder');
    await caja.waitForSelector('.mo-list');
    await caja.locator('.mo-prod', { hasText: 'Completo italiano normal' }).locator('[data-quick]').click();
    await caja.locator('.mo-prod', { hasText: 'Completo italiano normal' }).locator('[data-quick]').click();
    await caja.fill('#moQ', 'ass');
    await caja.locator('.mo-prod', { hasText: 'ASS normal' }).locator('[data-custom]').click();
    await caja.locator('.sheet label.check', { hasText: 'Sin Tomate' }).last().click();
    await caja.locator('#cuNote').fill('bien tostado');
    await shot(caja, '3-personalizar.png');
    await caja.click('.sheet [data-ok]');
    await caja.fill('#moQ', '');
    await caja.dispatchEvent('#moQ', 'input');
    await caja.waitForTimeout(200);
    await shot(caja, '2-elegir-productos.png');
    await noHScroll(caja, 'elegir productos');
    const small = await caja.evaluate(() => [...document.querySelectorAll('.mo-sheet button, .mo-sheet input')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 40).map((e) => e.textContent.trim() || e.id));
    assert.deepEqual(small, [], 'botones del nuevo pedido con tamaño táctil suficiente');
    const esperado = price('Completo italiano normal') * 2 + price('ASS normal');
    const nextTxt = await caja.innerText('[data-next]');
    assert.ok(nextTxt.includes('(3)') && nextTxt.includes(`$${esperado.toLocaleString('es-CL')}`), `botón muestra cantidad y total (${nextTxt})`);

    await caja.click('[data-next]');
    await caja.waitForSelector('#moName');
    assert.equal(num(await caja.innerText('.mo-total span:last-child')), esperado);
    const lineas = await caja.innerText('.mo-lines');
    assert.ok(lineas.includes('SIN Tomate') && lineas.includes('bien tostado'));
    await caja.check('#moPayNow');
    await shot(caja, '4-confirmar-efectivo.png');
    await noHScroll(caja, 'confirmar');
    await caja.click('[data-create]');
    await caja.waitForSelector('.mo-sheet', { state: 'detached' });
    const manualCard = caja.locator('.order', { hasText: 'Ingresado por caja' }).first();
    await manualCard.waitFor({ timeout: 6000 });
    const manualCode = await manualCard.locator('.o-code').innerText();
    const mTxt = await manualCard.innerText();
    for (const s of ['Sin nombre', 'Pago confirmado', 'Efectivo', 'SIN Tomate', 'bien tostado']) assert.ok(mTxt.includes(s), `tarjeta del pedido manual: ${s}`);
    await shot(caja, '5-pedido-manual-en-lista.png');
    log(`pedido manual ${manualCode} sin nombre, cobrado en efectivo ($${esperado.toLocaleString('es-CL')}), marcado "Ingresado por caja"`);

    // ---- Transferencia manual: no se puede marcar pagada sin verificar el abono ----
    await caja.click('#newOrder');
    await caja.locator('.mo-prod', { hasText: 'Chorrillana chica' }).locator('[data-quick]').click();
    await caja.click('[data-next]');
    await caja.fill('#moName', 'Rosa');
    await caja.locator('.mo-pay label', { hasText: 'Transferencia' }).click();
    assert.ok((await caja.innerText('.mo-sheet')).includes('Un pantallazo no confirma el pago'));
    await shot(caja, '6-transferencia-sin-verificar.png');
    await caja.click('[data-create]'); // sin marcar la verificación → queda pendiente
    await caja.waitForSelector('.mo-sheet', { state: 'detached' });
    const rosa = caja.locator('.order', { hasText: 'Rosa' });
    await rosa.waitFor();
    assert.ok((await rosa.innerText()).includes('Pendiente'));
    log('transferencia ingresada por caja sin verificar el abono: queda Pendiente (no cuenta como pagada)');

    // ---- Pedido por QR en el mismo turno ----
    const cli = await (await browser.newContext(PHONE)).newPage();
    cli.on('pageerror', (e) => errors.push(e.message));
    await cli.goto(`${BASE}/?origen=qr-prueba`);
    await cli.locator('.card', { hasText: 'Papas fritas medianas' }).click();
    await cli.click('#pdAdd');
    await cli.waitForSelector('.sheet', { state: 'detached' });
    await cli.click('#openCart');
    await cli.click('#toCheckout');
    await cli.fill('#coName', 'Pedro');
    await cli.locator('.pay-opt', { hasText: 'Efectivo' }).click();
    await cli.click('#coSend');
    await cli.waitForSelector('.order-code');
    const qrCode = await cli.innerText('.order-code');
    const qrCard = caja.locator('.order', { hasText: qrCode });
    await qrCard.waitFor({ timeout: 10000 });
    assert.ok((await qrCard.innerText()).includes('QR'));
    await qrCard.locator('[data-act=next]').click();
    await caja.check('#cPay');
    await caja.click('.sheet [data-ok]');
    await caja.waitForSelector('.sheet', { state: 'detached' });
    log(`pedido por QR ${qrCode} (Pedro) llegó al panel y se cobró en efectivo`);

    // ---- El manual pasa por preparación ----
    for (const b of ['Enviar a preparación', 'Marcar como listo', 'Marcar entregado']) {
      await caja.locator('.order', { hasText: manualCode }).locator('button', { hasText: b }).click();
      await caja.waitForTimeout(300);
    }
    log('el pedido manual pasó por preparación, listo y entregado como cualquier otro');

    // ---- Resumen (KPI) separado por origen ----
    await caja.click('[data-tab=resumen]');
    await caja.waitForSelector('.origin-split');
    const res = await caja.innerText('#stats');
    assert.ok(res.includes('Por QR') && res.includes('Ingresados por caja'));
    await shot(caja, '7-resumen-por-origen.png');

    // ---- Cierre del turno ----
    await caja.click('[data-tab=caja]');
    const esperadoCaja = 10000 + esperado + price('Papas fritas medianas');
    await caja.waitForFunction((v) => document.querySelector('.expected b')?.textContent.replace(/\D/g, '') === String(v), esperadoCaja);
    const tabla = await caja.innerText('.shift-open .origin');
    assert.ok(tabla.includes(`$${esperado.toLocaleString('es-CL')}`), 'efectivo de caja separado');
    assert.ok(tabla.includes(`$${price('Papas fritas medianas').toLocaleString('es-CL')}`), 'efectivo de QR separado');
    await caja.evaluate(() => document.querySelector('.shift-open .origin').scrollIntoView({ block: 'center' }));
    await shot(caja, '8-turno-por-origen.png');
    await caja.click('#tsClose');
    await caja.fill('#clCounted', String(esperadoCaja));
    await caja.check('#clRev');
    await caja.click('.sheet [data-go]');
    await caja.waitForSelector('.shift-dl');
    const cierre = await caja.innerText('.sheet');
    assert.ok(cierre.includes('Cuadra'));
    assert.match(cierre, new RegExp(`${manualCode}\\s+Sin nombre\\s+Ingresado por caja`));
    assert.match(cierre, new RegExp(`${qrCode}\\s+Pedro\\s+QR`));
    await caja.evaluate(() => [...document.querySelectorAll('.sheet h3')].find((h) => h.textContent === 'Por origen')?.scrollIntoView());
    await shot(caja, '9-cierre-por-origen.png');
    log(`cierre: esperado $${esperadoCaja.toLocaleString('es-CL')} = 10.000 + ${esperado.toLocaleString('es-CL')} (caja) + ${price('Papas fritas medianas').toLocaleString('es-CL')} (QR) → cuadra; ambos cobros listados con su origen`);

    assert.deepEqual(errors, []);
    console.log('\nNUEVO PEDIDO EN CAJA OK — capturas en docs/capturas/mostrador/\n');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('\n✘ FALLÓ:', e.message); process.exit(1); });
