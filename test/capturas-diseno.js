'use strict';
// Capturas de la carta y del panel en celular (para comparar antes/después de un cambio de diseño).
// Uso: node test/capturas-diseno.js docs/capturas/despues
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = path.resolve(process.argv[2] || 'docs/capturas/diseno');
fs.mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-cap-'));
process.env.ADMIN_PASSWORD = 'clave-capturas-2026';
const { createApp } = require('../server/index.js');

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL', timezoneId: 'America/Santiago', colorScheme: 'light' };

(async () => {
  const server = createApp().app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(OUT, name) }); };
  try {
    const cli = await (await browser.newContext(PHONE)).newPage();
    await cli.goto(BASE);
    await cli.waitForSelector('.card img');
    await shot(cli, '1-carta-inicio.png');
    await cli.evaluate(() => document.querySelector('#cat-' + [...document.querySelectorAll('.cat')][1].id.split('-')[1]).scrollIntoView());
    await shot(cli, '2-carta-completos.png');

    // Pedido: dos ASS con indicaciones distintas + papas
    const add = async (name, quitar, nota) => {
      await cli.locator('.card', { hasText: name }).first().click();
      await cli.waitForSelector('.sheet');
      if (quitar) await cli.locator('.sheet label.check', { hasText: `Sin ${quitar}` }).click();
      if (nota) await cli.fill('#pdNote', nota);
      return async () => { await cli.click('#pdAdd'); await cli.waitForSelector('.sheet', { state: 'detached' }); };
    };
    let done = await add('ASS normal', 'Tomate', 'bien tostado');
    await shot(cli, '3-carta-producto.png');
    await done();
    done = await add('ASS normal', 'Mayonesa', 'agregar mostaza'); await done();
    done = await add('Papas fritas medianas'); await done();
    await shot(cli, '4-carta-con-carrito.png');
    await cli.click('#openCart');
    await cli.waitForSelector('#lines');
    await shot(cli, '5-carta-carrito.png');
    await cli.click('#toCheckout');
    await cli.fill('#coName', 'Camila');
    await cli.locator('.pay-opt', { hasText: 'Efectivo' }).click();
    await cli.click('#coSend');
    await cli.waitForSelector('.order-code');
    await shot(cli, '6-carta-estado.png');

    const caja = await (await browser.newContext(PHONE)).newPage();
    await caja.goto(`${BASE}/caja`);
    await caja.waitForSelector('#pw');
    await shot(caja, '7-caja-login.png');
    await caja.fill('#pw', 'clave-capturas-2026');
    await caja.click('#loginForm button');
    await caja.waitForSelector('.order');
    await shot(caja, '8-caja-pedidos.png');
    await caja.locator('.order [data-act=next]').first().click();
    await caja.waitForSelector('.sheet [data-ok]');
    await shot(caja, '9-caja-confirmar.png');
    await caja.click('.sheet [data-close]');
    await caja.click('[data-tab=productos]');
    await caja.waitForSelector('.prod');
    await shot(caja, '10-caja-productos.png');
    console.log('Capturas en', OUT);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('✘', e.message); process.exit(1); });
