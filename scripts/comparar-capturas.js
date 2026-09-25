'use strict';
// Arma imágenes "antes / después" a partir de docs/capturas/antes y docs/capturas/despues.
// Uso: node scripts/comparar-capturas.js
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const DIR = path.join(__dirname, '..', 'docs', 'capturas');
const GROUPS = {
  'comparacion-carta.png': ['1-carta-inicio.png', '3-carta-producto.png', '4-carta-con-carrito.png', '5-carta-carrito.png'],
  'comparacion-caja.png': ['7-caja-login.png', '8-caja-pedidos.png', '9-caja-confirmar.png', '10-caja-productos.png'],
};
(async () => {
  const b = await chromium.launch();
  for (const [out, files] of Object.entries(GROUPS)) {
    const cell = (dir, f) => `<figure><img src="data:image/png;base64,${fs.readFileSync(path.join(DIR, dir, f)).toString('base64')}"></figure>`;
    const html = `<body style="margin:0;background:#2b1b10;font:600 22px system-ui;color:#fff">
      ${['antes', 'despues'].map((d) => `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px"><b style="width:120px;font-size:26px;color:${d === 'antes' ? '#bbb' : '#ffc43d'}">${d === 'antes' ? 'Antes' : 'Después'}</b>
      <div style="display:flex;gap:12px">${files.map((f) => cell(d, f)).join('')}</div></div>`).join('')}
      <style>figure{margin:0}img{width:300px;border-radius:14px;display:block}</style></body>`;
    const p = await b.newPage({ viewport: { width: 1400, height: 800 } });
    await p.setContent(html, { waitUntil: 'load' });
    await p.screenshot({ path: path.join(DIR, out), fullPage: true });
    await p.close();
    console.log(out);
  }
  await b.close();
})();
