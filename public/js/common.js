'use strict';
// Utilidades compartidas por la carta y el panel.
const RM = (() => {
  const fmt = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
  const money = (n) => fmt.format(n || 0);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const timeFmt = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' });
  const dateTimeFmt = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  async function api(url, opts = {}) {
    const o = { credentials: 'same-origin', ...opts, headers: { 'X-Requested-With': 'rucka', ...(opts.headers || {}) } };
    if (o.json !== undefined) {
      o.body = JSON.stringify(o.json);
      o.headers['Content-Type'] = 'application/json';
      delete o.json;
    }
    const res = await fetch(url, o);
    let data = null;
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Error ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.append(el);
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // Hoja inferior accesible. Devuelve { root, body, foot, close }.
  function sheet({ title, body = '', foot = '', onClose, wide = false }) {
    const back = document.createElement('div');
    back.className = 'sheet-backdrop';
    back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="max-width:760px"' : ''}>
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Cerrar">✕</button></div>
      <div class="sheet-body">${body}</div>${foot ? `<div class="sheet-foot">${foot}</div>` : ''}</div>`;
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.append(back);
    const close = () => {
      back.remove();
      document.body.style.overflow = document.querySelector('.sheet-backdrop') ? 'hidden' : prevOverflow;
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape' && back === [...document.querySelectorAll('.sheet-backdrop')].pop()) close(); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
    back.querySelector('[data-close]').focus();
    return { root: back, body: back.querySelector('.sheet-body'), foot: back.querySelector('.sheet-foot'), close };
  }

  // Confirmación con botones grandes (reemplaza a window.confirm, que algunos navegadores bloquean en páginas incrustadas).
  function confirmDialog(message, { ok = 'Confirmar', danger = false } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const sh = sheet({
        title: 'Confirmar',
        body: `<p style="margin:0">${esc(message)}</p>`,
        foot: `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" data-no>Cancelar</button><button class="btn ${danger ? 'btn-bad' : 'btn-primary'}" data-yes>${esc(ok)}</button></div>`,
        onClose: () => { if (!answered) resolve(false); },
      });
      sh.root.querySelector('[data-yes]').addEventListener('click', () => { answered = true; sh.close(); resolve(true); });
      sh.root.querySelector('[data-no]').addEventListener('click', () => sh.close());
    });
  }

  // Cloudflare Turnstile: carga el script solo cuando hace falta y dibuja el recuadro en `el`.
  // Devuelve { token(): Promise<string>, reset() }. La verificación real se hace en el servidor.
  let tsScript = null;
  function turnstile(el, siteKey, action) {
    tsScript ||= new Promise((ok, fail) => {
      const sc = document.createElement('script');
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      sc.async = true;
      sc.onload = ok;
      sc.onerror = () => { tsScript = null; fail(new Error('No se pudo cargar la verificación de Cloudflare. Revisa tu conexión.')); };
      document.head.append(sc);
    });
    let resolveToken;
    let current = new Promise((r) => { resolveToken = r; });
    let id = null;
    const ready = tsScript.then(() => {
      id = window.turnstile.render(el, {
        sitekey: siteKey, action, language: 'es', theme: 'auto',
        callback: (t) => resolveToken(t),
        'expired-callback': () => { current = new Promise((r) => { resolveToken = r; }); },
      });
    });
    return {
      ready,
      token: () => ready.then(() => current),
      reset() { if (id != null) { window.turnstile.reset(id); current = new Promise((r) => { resolveToken = r; }); } },
    };
  }

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* almacenamiento no disponible */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  };

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

  const STATUS = {
    pendiente: 'Pendiente',
    pago_confirmado: 'Pago confirmado',
    en_preparacion: 'En preparación',
    listo: 'Listo para retirar',
    entregado: 'Entregado',
    rechazado: 'Rechazado',
  };

  function modsHtml(item) {
    const out = [];
    for (const r of item.removed || []) out.push(`<li class="mod-removed">SIN ${esc(r)}</li>`);
    for (const e of item.extras || []) out.push(`<li class="mod-extra">+ ${esc(e.name)} (${money(e.price)})</li>`);
    if (item.note) out.push(`<li class="mod-note">Nota: “${esc(item.note)}”</li>`);
    return out.length ? `<ul class="mods">${out.join('')}</ul>` : '';
  }

  return { money, esc, api, toast, sheet, confirm: confirmDialog, turnstile, store, uuid, STATUS, modsHtml, timeFmt, dateTimeFmt };
})();
