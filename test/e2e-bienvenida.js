'use strict';
// Prueba de la pantalla de bienvenida de la carta.
// Uso: WELCOME_IMAGE=/ruta/imagen.png node test/e2e-bienvenida.js [carpeta-capturas]
// Sin WELCOME_IMAGE usa public/img/bienvenida.* (la imagen real del local).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = path.resolve(process.argv[2] || 'docs/capturas/bienvenida');
fs.mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-bv-'));
process.env.ADMIN_PASSWORD = 'clave-bienvenida-2026';
const { createApp } = require('../server/index.js');
const log = (m) => console.log('  ✔ ' + m);

// Zonas importantes de la imagen (en píxeles de la imagen original 941×1672): cara, sándwich y frase.
const ZONES = { cara: [300, 300, 720, 720], 'sándwich': [350, 660, 730, 1000], frase: [60, 1270, 881, 1500] };
const phone = (w, h) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CL' });

(async () => {
  const server = createApp().app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const QR = `${BASE}/?origen=qr-prueba`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    // 1) Abrir el QR: la bienvenida cubre la pantalla desde el primer momento y luego pasa sola a la carta
    const ctx = await browser.newContext(phone(390, 844));
    const cli = await ctx.newPage();
    cli.on('pageerror', (e) => errors.push(e.message));
    const t0 = Date.now();
    await cli.goto(QR, { waitUntil: 'commit' });
    await cli.waitForSelector('#welcome');
    const frames = [];
    for (const ms of [150, 600, 1100, 2000, 3100, 3700]) {
      const wait = ms - (Date.now() - t0);
      if (wait > 0) await cli.waitForTimeout(wait);
      const file = path.join(OUT, `transicion-${String(ms).padStart(4, '0')}ms.png`);
      await cli.screenshot({ path: file });
      frames.push({ ms, file });
    }
    const sharp = await cli.evaluate(() => true);
    assert.ok(sharp);
    assert.equal(await cli.locator('#welcome').count(), 0, 'la bienvenida desaparece sola');
    await cli.locator('.card').first().click();
    await cli.waitForSelector('.sheet');
    log('al abrir el QR se ve la bienvenida y a los ~3 s pasa sola a la carta');

    // Nitidez final: la imagen principal termina sin desenfoque
    const ctxN = await browser.newContext(phone(390, 844));
    const pn = await ctxN.newPage();
    await pn.goto(QR);
    await pn.waitForSelector('#welcome.in');
    await pn.waitForTimeout(1300);
    const filt = await pn.$eval('.welcome-img', (i) => getComputedStyle(i).filter);
    assert.ok(filt === 'none' || /blur\(0px\)/.test(filt), `la imagen queda nítida (filter: ${filt})`);
    log(`la imagen termina nítida (filter: ${filt}); solo el relleno de fondo va desenfocado`);

    // 2) Tocar para saltar
    const ctx2 = await browser.newContext(phone(390, 844));
    const skip = await ctx2.newPage();
    await skip.goto(QR);
    await skip.waitForSelector('#welcome');
    await skip.waitForTimeout(400);
    const tTap = Date.now();
    await skip.tap('#welcome');
    await skip.waitForSelector('#welcome', { state: 'detached', timeout: 1500 });
    const elapsed = Date.now() - tTap;
    await skip.locator('.card', { hasText: 'ASS normal' }).click();
    await skip.waitForSelector('.sheet');
    log(`tocar la pantalla entra a la carta de inmediato (${elapsed} ms, incluida la transición)`);

    // 3) No se repite: carrito, cambiar de categoría, estado del pedido, volver y recargar
    await skip.click('#pdAdd');
    await skip.waitForSelector('.sheet', { state: 'detached' });
    await skip.click('#openCart');
    await skip.click('.sheet [data-close]');
    await skip.locator('#cats a', { hasText: 'Bebidas' }).click();
    await skip.waitForTimeout(300);
    await skip.click('#openCart');
    await skip.click('#toCheckout');
    await skip.fill('#coName', 'Camila');
    await skip.locator('.pay-opt', { hasText: 'Efectivo' }).click();
    await skip.click('#coSend');
    await skip.waitForSelector('.order-code');
    const code = await skip.innerText('.order-code');
    await skip.click('#backToMenu');
    await skip.waitForSelector('.card');
    assert.equal(await skip.locator('#welcome').count(), 0);
    await skip.reload();
    await skip.waitForSelector('.card');
    await skip.waitForTimeout(300);
    assert.equal(await skip.locator('#welcome').count(), 0);
    log(`no se repite al usar el carrito, cambiar de categoría, enviar el pedido ${code}, volver ni recargar`);

    // El pedido llegó a la caja con el mismo número
    const caja = await (await browser.newContext(phone(390, 844))).newPage();
    await caja.goto(`${BASE}/caja`);
    await caja.fill('#pw', 'clave-bienvenida-2026');
    await caja.click('#loginForm button');
    await caja.locator('.order', { hasText: code }).waitFor({ timeout: 10000 });
    assert.equal(await caja.locator('#welcome').count(), 0, 'el panel no tiene bienvenida');
    log(`el pedido ${code} llegó a la caja; el panel no muestra la bienvenida`);

    // Abrir directamente el estado de un pedido no muestra la bienvenida
    const token = new URL(skip.url()).pathname;
    const direct = await (await browser.newContext(phone(390, 844))).newPage();
    await direct.goto(BASE + (token.startsWith('/pedido/') ? token : '/'));

    // 4) Distintos tamaños: la imagen completa se ve (sin cortes) y las zonas clave quedan en pantalla
    const sizes = [[320, 568], [360, 740], [375, 667], [390, 844], [412, 915], [430, 932], [844, 390]];
    const sizeShots = [];
    for (const [w, h] of sizes) {
      const p = await (await browser.newContext(phone(w, h))).newPage();
      await p.goto(QR);
      await p.waitForSelector('#welcome.in');
      await p.waitForTimeout(1300);
      const r = await p.$eval('.welcome-img', (img, zones) => {
        const b = img.getBoundingClientRect();
        const s = Math.min(b.width / img.naturalWidth, b.height / img.naturalHeight);
        const dw = img.naturalWidth * s; const dh = img.naturalHeight * s;
        const ox = b.left + (b.width - dw) / 2; const oy = b.top + (b.height - dh) / 2;
        const out = {};
        for (const [k, [x1, y1, x2, y2]] of Object.entries(zones)) {
          out[k] = x1 * s + ox >= -0.5 && y1 * s + oy >= -0.5 && x2 * s + ox <= innerWidth + 0.5 && y2 * s + oy <= innerHeight + 0.5;
        }
        return { zonas: out, escala: +s.toFixed(3), imagen: [Math.round(dw), Math.round(dh)] };
      }, ZONES);
      for (const [k, ok] of Object.entries(r.zonas)) assert.ok(ok, `${w}×${h}: ${k} queda completa`);
      const f = path.join(OUT, `tamano-${w}x${h}.png`);
      await p.screenshot({ path: f });
      sizeShots.push({ label: `${w}×${h}`, file: f });
      console.log(`     ${w}×${h}: cara, sándwich y frase completas (imagen ${r.imagen.join('×')} px)`);
    }
    log('en los 7 tamaños la imagen se ve entera, sin cortar la cara, el sándwich ni la frase');

    // Tira de la transición y de los tamaños
    const strip = async (items, name, width) => {
      const html = `<body style="margin:0;background:#2b1b10;color:#fff;font:600 20px system-ui;display:flex;gap:12px;padding:12px;align-items:flex-start">${items.map((it) => `<div><div style="padding:4px 0 8px">${it.label}</div><img style="width:${width}px;border-radius:12px" src="data:image/png;base64,${fs.readFileSync(it.file).toString('base64')}"></div>`).join('')}</body>`;
      const pg = await browser.newPage({ viewport: { width: 1400, height: 800 } });
      await pg.setContent(html, { waitUntil: 'load' });
      await pg.screenshot({ path: path.join(OUT, name), fullPage: true });
      await pg.close();
    };
    await strip(frames.map((f) => ({ label: `${(f.ms / 1000).toFixed(1)} s`, file: f.file })), 'transicion.png', 200);
    await strip(sizeShots, 'tamanos.png', 170);
    assert.deepEqual(errors, []);
    console.log(`\nBIENVENIDA OK — capturas en ${OUT}\n`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('\n✘ FALLÓ:', e.message); process.exit(1); });
