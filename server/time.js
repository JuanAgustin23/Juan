'use strict';
// Utilidades de zona horaria de Chile (America/Santiago), con horario de verano incluido.
const TZ = 'America/Santiago';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(ms) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

// Diferencia (ms) entre la hora local de Santiago y UTC en un instante dado.
function offsetAt(ms) {
  const p = parts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// Instante UTC correspondiente a las 00:00 locales de Santiago de una fecha (y, m, d).
function localMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // segunda pasada por si cae en un cambio de horario
  return t;
}

// Rango [inicio, fin) del día de Chile que contiene `ms`.
function chileDayRange(ms = Date.now()) {
  const p = parts(ms);
  const start = localMidnight(p.year, p.month, p.day);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  const label = `${String(p.day).padStart(2, '0')}-${String(p.month).padStart(2, '0')}-${p.year}`;
  return { start, end, label };
}

// Día de Chile a partir de 'AAAA-MM-DD' (para consultar el historial por fecha).
function chileDateRange(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = localMidnight(y, mo, d);
  const n = new Date(Date.UTC(y, mo - 1, d + 1));
  return { start, end: localMidnight(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()), label: `${m[3]}-${m[2]}-${m[1]}` };
}
// 'AAAA-MM-DD' del día de Chile en que cae un instante.
function chileDateStr(ms = Date.now()) {
  const p = parts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

module.exports = { TZ, chileDayRange, chileDateRange, chileDateStr };
