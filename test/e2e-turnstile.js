'use strict';
// Prueba en navegador del flujo con Cloudflare Turnstile activado (script y verificador simulados,
// porque este entorno no llega a Cloudflare). Uso: node test/e2e-turnstile.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const log = (m) => console.log('  ✔ ' + m);
const FAKE_WIDGET = `window.turnstile = {
  render(el, o) { el.innerHTML = '<div class="fake-ts">Verificación Cloudflare (simulada) ✓</div>'; setTimeout(() => o.callback('ok-' + o.action), 150); return 1; },
  reset() {}
};`;

(async () => {
  const verifier = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const t = new URLSearchParams(b).get('response') || '';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(t.startsWith('ok-') ? { success: true, action: t.slice(3) } : { success: false }));
    });
  }).listen(0);
  await new Promise((r) => verifier.once('listening', r));
  Object.assign(process.env, {
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rm-ts-')), ADMIN_PASSWORD: 'clave-cajero-2026',
    TURNSTILE_SITE_KEY: 'sitio-prueba', TURNSTILE_SECRET_KEY: 'secreto', TURNSTILE_VERIFY_URL: `http://127.0.0.1:${verifier.address().port}/`,
  });
  const { createApp } = require('../server/index.js');
  const server = createApp().app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const PHONE = { viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true, locale: 'es-CL' };
  const errors = [];
  try {
    const caja = await (await browser.newContext(PHONE)).newPage();
    caja.on('pageerror', (e) => errors.push(e.message));
    await caja.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_WIDGET }));
    await caja.goto(`${BASE}/caja`);
    await caja.waitForSelector('#loginTs .fake-ts');
    await caja.fill('#pw', 'clave-cajero-2026');
    await caja.click('#loginForm button');
    await caja.waitForSelector('#shell:not([hidden])');
    log('caja inicia sesión con la verificación Turnstile validada en el servidor');

    const cliCtx = await browser.newContext(PHONE);
    const cli = await cliCtx.newPage();
    cli.on('pageerror', (e) => errors.push(e.message));
    let widgetLoads = 0;
    await cli.route('https://challenges.cloudflare.com/**', (r) => { widgetLoads++; r.fulfill({ contentType: 'text/javascript', body: FAKE_WIDGET }); });
    const pedir = async (n) => {
      await cli.goto(BASE);
      await cli.locator('.card', { hasText: 'Papas fritas chicas' }).click();
      await cli.click('#pdAdd');
      await cli.waitForSelector('.sheet', { state: 'detached' });
      await cli.click('#openCart');
      await cli.click('#toCheckout');
      await cli.fill('#coName', `Cliente ${n}`);
      await cli.locator('.pay-opt', { hasText: 'Efectivo' }).click();
      await cli.click('#coSend');
    };
    for (let n = 1; n <= 4; n++) {
      await pedir(n);
      await cli.waitForSelector('.order-code');
    }
    assert.equal(widgetLoads, 0, 'los primeros 4 pedidos no cargan ningún desafío');
    log('4 pedidos seguidos sin ver ningún desafío');
    await pedir(5);
    await cli.waitForSelector('.sheet .fake-ts');
    assert.match(await cli.innerText('#coError'), /verificación/);
    await cli.click('#coSend');
    await cli.waitForSelector('.order-code');
    log('al 5.º pedido seguido aparece la verificación; tras completarla, el pedido se envía');

    await caja.locator('.order', { hasText: 'Cliente 5' }).waitFor({ timeout: 10000 });
    assert.equal(await caja.locator('.order').count(), 5);
    log('los 5 pedidos llegaron a la caja');
    assert.deepEqual(errors, []);
    console.log('\nTURNSTILE OK\n');
  } finally {
    await browser.close();
    server.close();
    verifier.close();
  }
})().catch((e) => { console.error('\n✘ FALLÓ:', e.message); process.exit(1); });
