'use strict';
// Genera un QR como archivo PNG y SVG.
//   npm run qr -- https://mi-demo.ejemplo.cl            → QR de PRUEBA (docs/qr/QR-PRUEBA-NO-PUBLICAR.*)
//   npm run qr -- https://carta.ruckamonkey.cl --final  → QR DEFINITIVO (docs/qr/QR-DEFINITIVO.*)
// El QR definitivo solo debe imprimirse cuando el panel ya salió del modo demostración.
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const [url, flag] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) {
  console.error('Uso: npm run qr -- <https://direccion> [--final]');
  process.exit(1);
}
const final = flag === '--final';
if (final && !url.startsWith('https://')) {
  console.error('El QR definitivo debe apuntar a una dirección https://');
  process.exit(1);
}
const target = final ? url.replace(/\/+$/, '') + '/' : url.replace(/\/+$/, '') + '/?origen=qr-prueba';
const out = path.join(__dirname, '..', 'docs', 'qr');
fs.mkdirSync(out, { recursive: true });
const name = final ? 'QR-DEFINITIVO' : 'QR-PRUEBA-NO-PUBLICAR';
const opts = { margin: 2, errorCorrectionLevel: 'M', width: 800 };
(async () => {
  await QRCode.toFile(path.join(out, `${name}.png`), target, opts);
  fs.writeFileSync(path.join(out, `${name}.svg`), await QRCode.toString(target, { ...opts, type: 'svg' }));
  console.log(`${name} → ${target}\nArchivos en docs/qr/`);
})();
