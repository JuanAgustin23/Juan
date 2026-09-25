'use strict';
(() => {
  const { money, esc, api, toast, sheet, store, STATUS, modsHtml, timeFmt, dateTimeFmt } = RM;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const FILTERS = [
    ['activos', 'Activos'], ['pendiente', 'Pendientes'], ['pago_confirmado', 'Pagados'], ['en_preparacion', 'Preparando'],
    ['listo', 'Listos'], ['entregado', 'Entregados'], ['rechazado', 'Rechazados'], ['todos', 'Todos'],
  ];
  const ACTIVE = ['pendiente', 'pago_confirmado', 'en_preparacion', 'listo'];
  const state = {
    tab: 'pedidos', filter: store.get('rm_admin_filter', 'activos'), orders: [], seen: null, fresh: new Set(),
    sound: store.get('rm_admin_sound', false), catalog: [], settings: {}, demoMode: true, unseen: 0,
  };

  // ---------------- Sesión ----------------
  let loginSiteKey = null;
  let loginTs = null;
  async function boot() {
    const { loggedIn, turnstileSiteKey } = await api('/api/admin/session');
    loginSiteKey = turnstileSiteKey || null;
    if (!loggedIn) return showLogin();
    $('#login').hidden = true;
    $('#shell').hidden = false;
    await loadSettings();
    renderFilters();
    switchTab(location.hash.replace('#', '') || 'pedidos');
    poll();
  }
  function showLogin() {
    $('#shell').hidden = true;
    $('#demoBanner').hidden = true;
    $('#login').hidden = false;
    // Verificación de Cloudflare Turnstile (solo si el servidor la tiene activada)
    if (loginSiteKey && !loginTs && RM.turnstile) {
      const box = document.createElement('div');
      box.id = 'loginTs';
      box.style.minHeight = '65px';
      $('#loginErr').before(box);
      loginTs = RM.turnstile(box, loginSiteKey, 'login');
      loginTs.ready.catch((e) => { $('#loginErr').textContent = e.message; $('#loginErr').hidden = false; });
    }
    $('#pw').focus();
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').hidden = true;
    const btn = $('#loginForm button');
    btn.disabled = true;
    try {
      const turnstileToken = loginTs ? await loginTs.token() : undefined;
      await api('/api/admin/login', { method: 'POST', json: { password: $('#pw').value, turnstileToken } });
      $('#pw').value = '';
      boot();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      $('#loginErr').hidden = false;
      loginTs?.reset();
    } finally {
      btn.disabled = false;
    }
  });
  // Cualquier 401 devuelve al inicio de sesión.
  // Nombre de quien atiende en este celular: se envía con cada acción para dejar registro (auditoría).
  const staffName = () => store.get('rm_staff', '') || '';
  async function call(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (staffName()) headers['X-Staff-Name'] = encodeURIComponent(staffName());
    try { return await api(url, { ...opts, headers }); } catch (e) {
      if (e.status === 401) showLogin();
      throw e;
    }
  }

  async function loadSettings() {
    state.settings = await call('/api/admin/settings');
    state.demoMode = state.settings.demo_mode === '1';
    $('#demoBanner').hidden = !state.demoMode;
  }

  // ---------------- Pestañas ----------------
  function switchTab(tab) {
    if (!['pedidos', 'caja', 'productos', 'resumen', 'ajustes'].includes(tab)) tab = 'pedidos';
    state.tab = tab;
    $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== tab; });
    history.replaceState(null, '', `#${tab}`);
    if (tab === 'pedidos') { state.unseen = 0; updateBadge(); renderOrders(); }
    if (tab === 'productos') loadCatalog();
    if (tab === 'resumen') loadStats();
    if (tab === 'ajustes') renderSettings();
    if (tab === 'caja') {
      if (window.RMTurnos) window.RMTurnos.render($('#caja'));
      else $('#caja').innerHTML = '<p class="notice notice-info">La apertura y cierre de caja no está disponible en esta vista.</p>';
    }
    window.scrollTo(0, 0);
  }
  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  // ---------------- Pedidos (actualización automática) ----------------
  let pollTimer;
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const { orders } = await call('/api/admin/orders');
      const ids = new Set(orders.map((o) => o.id));
      if (state.seen) {
        const nuevos = orders.filter((o) => !state.seen.has(o.id));
        if (nuevos.length) {
          nuevos.forEach((o) => state.fresh.add(o.id));
          if (state.tab !== 'pedidos' || document.hidden) state.unseen += nuevos.length;
          notifyNew(nuevos);
        }
      }
      state.seen = ids;
      state.orders = orders;
      $('#live').classList.remove('off');
      $('#live').textContent = '● En vivo';
      updateBadge();
      if (state.tab === 'pedidos' && !document.querySelector('.sheet-backdrop')) renderOrders();
      else if (state.tab === 'pedidos') renderFilters();
    } catch (e) {
      if (e.status === 401) return;
      $('#live').classList.add('off');
      $('#live').textContent = '● Sin conexión';
    }
    pollTimer = setTimeout(poll, document.hidden ? 15000 : 4000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#shell').hidden) poll(); });

  function updateBadge() {
    const pend = state.orders.filter((o) => o.status === 'pendiente').length;
    const n = state.unseen || pend;
    $('#newBadge').hidden = !n;
    $('#newBadge').textContent = n;
    document.title = `${pend ? `(${pend}) ` : ''}Caja · Rucka Monkey`;
  }

  let audioCtx;
  function beep() {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      [0, 0.18].forEach((d) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.15);
        o.connect(g).connect(audioCtx.destination);
        o.start(t + d);
        o.stop(t + d + 0.16);
      });
    } catch { /* sin audio */ }
  }
  function notifyNew(list) {
    toast(list.length === 1 ? `Nuevo pedido ${list[0].code} · ${list[0].customerName}` : `${list.length} pedidos nuevos`, 4000);
    if (state.sound) beep();
    navigator.vibrate?.([200, 100, 200]);
  }
  function renderSoundBtn() {
    $('#soundBtn').textContent = state.sound ? '🔔' : '🔕';
    $('#soundBtn').setAttribute('aria-label', state.sound ? 'Silenciar aviso de pedidos nuevos' : 'Activar sonido de aviso');
  }
  $('#soundBtn').addEventListener('click', () => {
    state.sound = !state.sound;
    store.set('rm_admin_sound', state.sound);
    renderSoundBtn();
    if (state.sound) beep();
    toast(state.sound ? 'Sonido activado para pedidos nuevos' : 'Sonido desactivado');
  });
  renderSoundBtn();

  function filtered() {
    const f = state.filter;
    if (f === 'todos') return state.orders;
    if (f === 'activos') return state.orders.filter((o) => ACTIVE.includes(o.status));
    return state.orders.filter((o) => o.status === f);
  }
  function renderFilters() {
    const count = (k) => (k === 'todos' ? state.orders.length : k === 'activos' ? state.orders.filter((o) => ACTIVE.includes(o.status)).length : state.orders.filter((o) => o.status === k).length);
    $('#orderFilters').innerHTML = FILTERS.map(([k, label]) => `<button role="tab" aria-selected="${state.filter === k}" class="${state.filter === k ? 'on' : ''}" data-filter="${k}">${label}<b>${count(k)}</b></button>`).join('');
  }
  $('#orderFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    store.set('rm_admin_filter', state.filter);
    renderOrders();
  });

  const NEXT = {
    pendiente: { label: 'Revisar y confirmar pago', cls: 'btn-ok' },
    pago_confirmado: { to: 'en_preparacion', label: 'Enviar a preparación', cls: 'btn-primary' },
    en_preparacion: { to: 'listo', label: 'Marcar como listo', cls: 'btn-ok' },
    listo: { to: 'entregado', label: 'Marcar entregado', cls: 'btn-primary' },
    rechazado: { to: 'pendiente', label: 'Reabrir pedido', cls: '' },
  };
  const statusTag = (s) => `<span class="tag ${{ pendiente: 'tag-warn', pago_confirmado: 'tag-info', en_preparacion: 'tag-info', listo: 'tag-ok', entregado: 'tag-ok', rechazado: 'tag-bad' }[s]}">${STATUS[s]}</span>`;

  function itemsHtml(o) {
    return `<ul class="o-items">${o.items.map((it) => `<li><div class="it"><span><span class="qty">${it.quantity}</span>${esc(it.productName)}</span><span>${money(it.lineTotal)}</span></div>${modsHtml(it)}</li>`).join('')}</ul>`;
  }

  function orderCard(o) {
    const n = NEXT[o.status];
    const payTag = o.paymentMethod === 'transferencia'
      ? `<span class="tag tag-info">Transferencia</span>${o.receipt ? '<span class="tag">📎 Comprobante</span>' : '<span class="tag tag-warn">Sin comprobante</span>'}`
      : '<span class="tag">Efectivo</span>';
    return `<article class="order st-${o.status} ${state.fresh.has(o.id) ? 'fresh' : ''}" data-id="${o.id}">
      <div class="o-head"><span class="o-code">${esc(o.code)}</span><span class="o-name">${esc(o.customerName)}</span><span class="muted">${timeFmt.format(o.createdAt)}</span></div>
      <div class="o-meta">${statusTag(o.status)}${payTag}${o.isDemo ? '<span class="tag tag-demo">DEMO</span>' : ''}</div>
      ${o.hasNotes && o.status === 'pendiente' ? `<div class="alert-notes">⚠ Tiene indicaciones: revísalas antes de confirmar${o.notesReviewed ? ' (ya revisadas)' : ''}</div>` : ''}
      ${itemsHtml(o)}
      <div class="o-total"><span>Total</span><span>${money(o.total)}</span></div>
      ${o.staffNote ? `<div class="staff-note"><b>Nota interna:</b> ${esc(o.staffNote)}</div>` : ''}
      <div class="o-actions">
        ${n ? `<button class="btn main ${n.cls}" data-act="next">${n.label}</button>` : ''}
        ${o.receipt ? '<button class="btn" data-act="receipt">Ver comprobante</button>' : ''}
        <button class="btn" data-act="note">Nota interna</button>
        ${['pendiente', 'pago_confirmado', 'en_preparacion'].includes(o.status) ? '<button class="btn btn-bad" data-act="reject">Rechazar</button>' : ''}
      </div>
    </article>`;
  }

  function renderOrders() {
    renderFilters();
    const list = filtered();
    $('#orders').innerHTML = list.length ? list.map(orderCard).join('') : `<div class="empty">No hay pedidos en “${FILTERS.find((f) => f[0] === state.filter)[1]}”.<br><span class="hint">Se muestran los pedidos de hoy (hora de Chile) y los que siguen activos.</span></div>`;
    state.fresh.clear();
  }

  $('#orders').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const o = state.orders.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
    if (!o) return;
    ({ next: () => (o.status === 'pendiente' ? confirmPayment(o) : setStatus(o, NEXT[o.status].to)), receipt: () => showReceipt(o), note: () => staffNote(o), reject: () => reject(o) })[b.dataset.act]();
  });

  async function setStatus(o, status, extra = {}) {
    try {
      const { order } = await call(`/api/admin/orders/${o.id}/status`, { method: 'POST', json: { status, ...extra } });
      Object.assign(o, order);
      renderOrders();
      toast(`${o.code}: ${STATUS[status]}`);
      return true;
    } catch (e) { toast(e.message, 4000); return false; }
  }

  // Confirmación de pago: muestra TODO el pedido, las indicaciones y el comprobante.
  function confirmPayment(o) {
    const transfer = o.paymentMethod === 'transferencia';
    const needsNotes = o.hasNotes && !o.notesReviewed;
    const body = `
      ${o.isDemo ? '<p class="notice notice-demo">Pedido de <b>demostración</b>: no es una venta real.</p>' : ''}
      <p style="margin:0 0 6px"><b>${esc(o.customerName)}</b> · ${esc(o.code)} · ${transfer ? 'Transferencia' : 'Efectivo'}</p>
      ${itemsHtml(o)}
      <div class="o-total" style="margin:10px 0"><span>Total a cobrar</span><span>${money(o.total)}</span></div>
      ${transfer ? (o.receipt
        ? `<div class="receipt-view"><p class="hint">Comprobante enviado por el cliente (solo referencia):</p><a href="${o.receipt}" target="_blank" rel="noopener"><img src="${o.receipt}" alt="Comprobante de ${esc(o.customerName)}"></a></div>`
        : '<p class="notice notice-warn">El cliente no adjuntó comprobante.</p>') : ''}
      ${transfer ? `<p class="notice notice-warn"><b>El comprobante no confirma el pago.</b> Abre la app o web del banco y verifica que llegó un abono de ${money(o.total)}.</p>` : ''}
      <div class="box" style="margin-top:10px">
        ${needsNotes ? '<label class="check"><input type="checkbox" id="cNotes"><span>Leí todas las indicaciones y el local puede cumplirlas (si no, rechaza o habla con el cliente)</span></label>' : ''}
        ${transfer
          ? `<label class="check"><input type="checkbox" id="cPay"><span>Verifiqué en la cuenta bancaria que llegó el abono de <b>${money(o.total)}</b></span></label>`
          : `<label class="check"><input type="checkbox" id="cPay"><span>Recibí <b>${money(o.total)}</b> en efectivo</span></label>`}
      </div>`;
    const sh = sheet({ title: `Confirmar pago ${o.code}`, body, foot: '<div class="o-actions"><button class="btn btn-bad" data-rej>Rechazar</button><button class="btn btn-ok" data-ok disabled>Confirmar pago</button></div>' });
    // Aviso (no bloquea): si no hay turno abierto, este cobro no quedará en ningún cierre de caja
    call('/api/admin/shifts/current').then((d) => {
      if (d && !d.shift && sh.root.isConnected) {
        const n = document.createElement('p');
        n.className = 'notice notice-warn';
        n.innerHTML = '<b>No hay un turno de caja abierto.</b> El cobro se registrará igual, pero no quedará en ningún cierre. Abre la caja en la pestaña Caja.';
        sh.body.prepend(n);
      }
    }).catch(() => {});
    const ok = $('[data-ok]', sh.root);
    const upd = () => { ok.disabled = !(($('#cNotes', sh.root)?.checked ?? true) && $('#cPay', sh.root).checked); };
    sh.root.addEventListener('change', upd);
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      const done = await setStatus(o, 'pago_confirmado', { notesReviewed: !!$('#cNotes', sh.root)?.checked || !needsNotes, bankVerified: transfer, cashReceived: !transfer });
      if (done) sh.close(); else upd();
    });
    $('[data-rej]', sh.root).addEventListener('click', () => { sh.close(); reject(o); });
  }

  function showReceipt(o) {
    sheet({
      title: `Comprobante ${o.code}`,
      body: `<div class="receipt-view"><p class="notice notice-warn">Referencia del cliente. Confirma el abono en la cuenta bancaria antes de preparar.</p>
        <img src="${o.receipt}" alt="Comprobante de ${esc(o.customerName)}"><p><a class="btn btn-block" href="${o.receipt}" target="_blank" rel="noopener">Abrir en tamaño completo</a></p></div>`,
    });
  }

  function staffNote(o) {
    const sh = sheet({
      title: `Nota interna ${o.code}`,
      body: `<label class="field"><span>Solo visible para caja</span><textarea class="input" id="sn" maxlength="300" placeholder="Ej.: no hay mostaza, se le ofreció ketchup">${esc(o.staffNote)}</textarea></label>`,
      foot: '<button class="btn btn-primary btn-block" data-save>Guardar</button>',
    });
    $('[data-save]', sh.root).addEventListener('click', async () => {
      try {
        const note = $('#sn', sh.root).value;
        await call(`/api/admin/orders/${o.id}/staff-note`, { method: 'POST', json: { note } });
        o.staffNote = note;
        sh.close();
        renderOrders();
      } catch (e) { toast(e.message); }
    });
  }

  function reject(o) {
    // Si el pedido ya estaba cobrado, se pregunta si se devolvió el dinero (queda en el turno de caja).
    const paidCash = o.paidAt && o.paymentMethod === 'efectivo';
    const paidTransfer = o.paidAt && o.paymentMethod === 'transferencia';
    const sh = sheet({
      title: `Rechazar ${o.code}`,
      body: `<label class="field"><span>Motivo</span><select class="input" id="rr">
        <option>No llegó la transferencia</option><option>Monto transferido incorrecto</option><option>El local no puede cumplir una indicación</option>
        <option>Producto agotado</option><option>Pedido duplicado o de prueba</option><option>Otro</option></select></label>
        ${paidCash ? `<p class="notice notice-warn">Este pedido ya estaba <b>cobrado en efectivo</b> (${money(o.total)}).</p>
          <label class="check"><input type="checkbox" id="rrCash"><span>Devolví <b>${money(o.total)}</b> en efectivo al cliente (se descuenta de la caja)</span></label>` : ''}
        ${paidTransfer ? `<p class="notice notice-warn">Este pedido ya tenía la <b>transferencia confirmada</b> (${money(o.total)}).</p>
          <label class="check"><input type="checkbox" id="rrTransfer"><span>Devolví la transferencia al cliente</span></label>` : ''}`,
      foot: '<button class="btn btn-bad btn-block" data-go>Rechazar pedido</button>',
    });
    $('[data-go]', sh.root).addEventListener('click', async () => {
      const extra = { reason: $('#rr', sh.root).value };
      if (paidCash) extra.cashRefunded = $('#rrCash', sh.root).checked;
      if (paidTransfer) extra.transferRefunded = $('#rrTransfer', sh.root).checked;
      if (await setStatus(o, 'rechazado', extra)) sh.close();
    });
  }

  // ---------------- Productos ----------------
  async function loadCatalog() {
    try {
      state.catalog = (await call('/api/admin/catalog')).categories;
      renderCatalog();
    } catch (e) { $('#catalog').innerHTML = `<p class="notice notice-bad">${esc(e.message)}</p>`; }
  }
  function prodTags(p) {
    return [
      !p.active && '<span class="tag tag-bad">Desactivado</span>',
      p.priceIsTest && '<span class="tag tag-demo">Precio de prueba</span>',
      p.isPlaceholder && '<span class="tag tag-warn">Provisional</span>',
      p.descriptionProvisional && '<span class="tag tag-warn">Desc. provisional</span>',
      p.ingredients.some((g) => g.provisional) && '<span class="tag tag-warn">Ingred. provisionales</span>',
      p.imageKind === 'ilustracion' && '<span class="tag">Ilustración</span>',
      p.extras.length && `<span class="tag tag-info">${p.extras.length} extra(s)</span>`,
    ].filter(Boolean).join('');
  }
  function renderCatalog() {
    const cats = state.catalog;
    $('#catalog').innerHTML = cats.map((c, ci) => `
      <div class="cat-block" data-cat="${c.id}">
        <div class="cat-title"><h2>${esc(c.name)} ${c.active ? '' : '<span class="tag tag-bad">Oculta</span>'}</h2>
          <button class="icon-btn" data-cat-act="up" aria-label="Subir categoría" ${ci === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-cat-act="down" aria-label="Bajar categoría" ${ci === cats.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-cat-act="edit" aria-label="Editar categoría">✎</button></div>
        <div class="prod-list">${c.products.map((p, pi) => `
          <div class="prod ${p.active ? '' : 'off'}" data-pid="${p.id}">
            ${p.image ? `<img src="${esc(p.image)}" alt="">` : '<div class="noimg"></div>'}
            <button class="prod-main" data-p-act="edit"><b>${esc(p.name)}</b><span>${money(p.price)}</span><span class="tags">${prodTags(p)}</span></button>
            <div class="prod-side">
              <button class="icon-btn" data-p-act="up" aria-label="Subir" ${pi === 0 ? 'disabled' : ''}>↑</button>
              <button class="icon-btn" data-p-act="down" aria-label="Bajar" ${pi === c.products.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
          </div>`).join('') || '<p class="hint">Sin productos.</p>'}</div>
      </div>`).join('') + '<button class="btn btn-block" id="newCat">+ Nueva categoría</button>';
  }
  $('#catalog').addEventListener('click', async (e) => {
    if (e.target.closest('#newCat')) return editCategory(null);
    const cb = e.target.closest('[data-cat-act]');
    if (cb) {
      const idx = state.catalog.findIndex((c) => c.id === Number(cb.closest('[data-cat]').dataset.cat));
      const act = cb.dataset.catAct;
      if (act === 'edit') return editCategory(state.catalog[idx]);
      const ids = state.catalog.map((c) => c.id);
      const j = act === 'up' ? idx - 1 : idx + 1;
      [ids[idx], ids[j]] = [ids[j], ids[idx]];
      await call('/api/admin/categories/reorder', { method: 'POST', json: { ids } }).catch((er) => toast(er.message));
      return loadCatalog();
    }
    const pb = e.target.closest('[data-p-act]');
    if (!pb) return;
    const pid = Number(pb.closest('[data-pid]').dataset.pid);
    const cat = state.catalog.find((c) => c.products.some((p) => p.id === pid));
    const idx = cat.products.findIndex((p) => p.id === pid);
    if (pb.dataset.pAct === 'edit') return editProduct(cat.products[idx]);
    const ids = cat.products.map((p) => p.id);
    const j = pb.dataset.pAct === 'up' ? idx - 1 : idx + 1;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await call('/api/admin/products/reorder', { method: 'POST', json: { ids } }).catch((er) => toast(er.message));
    loadCatalog();
  });
  $('#newProduct').addEventListener('click', () => editProduct(null));

  function editCategory(c) {
    const sh = sheet({
      title: c ? 'Editar categoría' : 'Nueva categoría',
      body: `<label class="field"><span>Nombre</span><input class="input" id="cn" maxlength="40" value="${esc(c?.name || '')}"></label>
        ${c ? `<label class="check"><input type="checkbox" id="ca" ${c.active ? 'checked' : ''}><span>Visible en la carta</span></label>` : ''}`,
      foot: '<button class="btn btn-primary btn-block" data-save>Guardar</button>',
    });
    $('[data-save]', sh.root).addEventListener('click', async () => {
      try {
        if (c) await call(`/api/admin/categories/${c.id}`, { method: 'PATCH', json: { name: $('#cn', sh.root).value, active: $('#ca', sh.root).checked } });
        else await call('/api/admin/categories', { method: 'POST', json: { name: $('#cn', sh.root).value } });
        sh.close();
        loadCatalog();
      } catch (e) { toast(e.message); }
    });
  }

  let illusCache = null;
  async function editProduct(p) {
    illusCache ||= (await call('/api/admin/illustrations')).files;
    const cats = state.catalog;
    const ing = p ? p.ingredients.map((g) => ({ ...g })) : [];
    const ext = p ? p.extras.map((x) => ({ ...x })) : [];
    const body = `
      <form id="pf" autocomplete="off">
        <label class="field"><span>Nombre</span><input class="input" name="name" maxlength="60" required value="${esc(p?.name || '')}"></label>
        <div class="two">
          <label class="field"><span>Precio (CLP)</span><input class="input" name="price" inputmode="numeric" pattern="[0-9]*" required value="${p?.price ?? ''}" placeholder="3500"></label>
          <label class="field"><span>Categoría</span><select class="input" name="categoryId">${cats.map((c) => `<option value="${c.id}" ${c.id === (p?.categoryId ?? cats[0]?.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="priceIsTest" ${p ? (p.priceIsTest ? 'checked' : '') : 'checked'}><span>Es un <b>precio de prueba</b> (desmárcalo cuando sea el precio real)</span></label>
        <label class="field"><span>Descripción</span><textarea class="input" name="description" maxlength="300">${esc(p?.description || '')}</textarea></label>
        <label class="check"><input type="checkbox" name="descriptionProvisional" ${p ? (p.descriptionProvisional ? 'checked' : '') : 'checked'}><span>Descripción <b>provisional</b> (por confirmar)</span></label>
        <label class="check"><input type="checkbox" name="isPlaceholder" ${p?.isPlaceholder ? 'checked' : ''}><span>Producto de <b>ejemplo</b> (no existe todavía en el local)</span></label>
        <label class="check"><input type="checkbox" name="active" ${p ? (p.active ? 'checked' : '') : 'checked'}><span>Visible y disponible en la carta</span></label>

        <h3 class="section-title" style="margin-top:14px">Imagen</h3>
        <div class="editor-img">
          <img id="pimg" src="${esc(p?.image || '')}" alt="" ${p?.image ? '' : 'hidden'}>
          <div class="btns">
            ${p ? `<label class="btn btn-sm"><input type="file" id="photo" accept="image/jpeg,image/png,image/webp" hidden>📷 Subir foto real</label>
            ${p.hasPhoto ? '<button type="button" class="btn btn-sm btn-bad" id="rmPhoto">Quitar foto</button>' : ''}` : '<p class="hint">Guarda el producto para poder subir una foto.</p>'}
            <select class="input" name="illustration" aria-label="Ilustración de respaldo"><option value="">Sin ilustración</option>${illusCache.map((f) => `<option ${p?.illustration === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
          </div>
        </div>
        <p class="hint">Si hay foto real, se muestra la foto. Si no, la ilustración (rotulada como “Ilustración”).</p>

        <h3 class="section-title">Ingredientes (el cliente puede quitar los marcados como “se puede quitar”)</h3>
        <div class="list-edit" id="ingList"></div>
        <button type="button" class="btn btn-sm" id="addIng" style="margin-top:8px">+ Ingrediente</button>

        <h3 class="section-title">Extras con costo</h3>
        <p class="hint" style="margin:0 0 6px">Solo se cobran los extras configurados aquí. Lo que el cliente escriba en una nota nunca se cobra automáticamente.</p>
        <div class="list-edit" id="extList"></div>
        <button type="button" class="btn btn-sm" id="addExt" style="margin-top:8px">+ Extra</button>
        ${p ? '<hr style="border:0;border-top:1px solid var(--line);margin:20px 0"><button type="button" class="btn btn-bad btn-block" id="delProd">Eliminar producto</button><p class="hint">Para ocultarlo temporalmente, mejor desmarca “Visible”. Los pedidos antiguos conservan su detalle.</p>' : ''}
      </form>`;
    const sh = sheet({ title: p ? 'Editar producto' : 'Nuevo producto', body, foot: '<button class="btn btn-primary btn-block" data-save>Guardar</button>', wide: true });
    const q = (s) => $(s, sh.root);

    function renderLists() {
      q('#ingList').innerHTML = ing.map((g, i) => `<div class="list-row" data-i="${i}">
        <div class="r1"><input class="input" data-f="name" value="${esc(g.name)}" maxlength="40" placeholder="Ingrediente" aria-label="Nombre del ingrediente"><button type="button" class="icon-btn" data-del-ing aria-label="Eliminar ingrediente">🗑</button></div>
        <div class="r2"><label class="check"><input type="checkbox" data-f="removable" ${g.removable ? 'checked' : ''}><span>Se puede quitar</span></label>
        <label class="check"><input type="checkbox" data-f="provisional" ${g.provisional ? 'checked' : ''}><span>Provisional</span></label></div></div>`).join('') || '<p class="hint">Sin ingredientes.</p>';
      q('#extList').innerHTML = ext.map((x, i) => `<div class="list-row" data-x="${i}">
        <div class="r1"><input class="input" data-f="name" value="${esc(x.name)}" maxlength="40" placeholder="Ej.: Extra queso" aria-label="Nombre del extra">
        <input class="input" data-f="price" value="${x.price ?? ''}" inputmode="numeric" pattern="[0-9]*" style="max-width:110px" placeholder="$" aria-label="Precio del extra">
        <button type="button" class="icon-btn" data-del-ext aria-label="Eliminar extra">🗑</button></div>
        <div class="r2"><label class="check"><input type="checkbox" data-f="active" ${x.active !== false ? 'checked' : ''}><span>Disponible</span></label></div></div>`).join('') || '<p class="hint">Sin extras con costo.</p>';
    }
    renderLists();
    sh.root.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      const row = e.target.closest('[data-i],[data-x]');
      const obj = row.dataset.i != null ? ing[row.dataset.i] : ext[row.dataset.x];
      obj[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    });
    sh.root.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (f && e.target.type === 'checkbox') {
        const row = e.target.closest('[data-i],[data-x]');
        (row.dataset.i != null ? ing[row.dataset.i] : ext[row.dataset.x])[f] = e.target.checked;
      }
    });
    sh.root.addEventListener('click', async (e) => {
      if (e.target.closest('#addIng')) { ing.push({ name: '', removable: true, provisional: false }); renderLists(); $$('#ingList input[data-f=name]', sh.root).pop().focus(); }
      if (e.target.closest('#addExt')) { ext.push({ name: '', price: '', active: true }); renderLists(); $$('#extList input[data-f=name]', sh.root).pop().focus(); }
      if (e.target.closest('[data-del-ing]')) { ing.splice(Number(e.target.closest('[data-i]').dataset.i), 1); renderLists(); }
      if (e.target.closest('[data-del-ext]')) { ext.splice(Number(e.target.closest('[data-x]').dataset.x), 1); renderLists(); }
      if (e.target.closest('#rmPhoto')) {
        await call(`/api/admin/products/${p.id}/photo`, { method: 'DELETE' }).catch((er) => toast(er.message));
        toast('Foto eliminada: vuelve a mostrarse la ilustración');
        sh.close();
        loadCatalog();
      }
      if (e.target.closest('#delProd') && await RM.confirm(`¿Eliminar “${p.name}” definitivamente?`, { ok: 'Eliminar', danger: true })) {
        await call(`/api/admin/products/${p.id}`, { method: 'DELETE' }).catch((er) => toast(er.message));
        sh.close();
        loadCatalog();
      }
    });
    q('#photo')?.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('photo', f);
      try {
        const r = await call(`/api/admin/products/${p.id}/photo`, { method: 'POST', body: fd });
        q('#pimg').src = r.image;
        q('#pimg').hidden = false;
        toast('Foto actualizada');
      } catch (er) { toast(er.message); }
    });
    q('[data-save]').addEventListener('click', async () => {
      const fm = q('#pf');
      const fd = new FormData(fm);
      const priceStr = String(fd.get('price')).replace(/[.$\s]/g, '');
      const data = {
        name: fd.get('name'), price: Number(priceStr), categoryId: Number(fd.get('categoryId')), description: fd.get('description'),
        illustration: fd.get('illustration') || null,
        priceIsTest: fm.priceIsTest.checked, descriptionProvisional: fm.descriptionProvisional.checked, isPlaceholder: fm.isPlaceholder.checked, active: fm.active.checked,
      };
      if (!data.name.trim()) return toast('Falta el nombre');
      if (!/^\d+$/.test(priceStr)) return toast('El precio debe ser un número en pesos, sin puntos. Ej.: 3500');
      const btn = q('[data-save]');
      btn.disabled = true;
      try {
        const { id } = p ? await call(`/api/admin/products/${p.id}`, { method: 'PATCH', json: data }) : await call('/api/admin/products', { method: 'POST', json: data });
        await call(`/api/admin/products/${id}/ingredients`, { method: 'PUT', json: { ingredients: ing.filter((g) => String(g.name).trim()) } });
        await call(`/api/admin/products/${id}/extras`, { method: 'PUT', json: { extras: ext.filter((x) => String(x.name).trim()).map((x) => ({ ...x, price: Number(String(x.price).replace(/[.$\s]/g, '')) })) } });
        toast('Producto guardado');
        sh.close();
        loadCatalog();
      } catch (er) {
        toast(er.message, 4000);
        btn.disabled = false;
      }
    });
  }

  // ---------------- Resumen ----------------
  async function loadStats() {
    try {
      const s = await call('/api/admin/stats');
      const kpis = (d, cls = '') => `<div class="kpis ${cls}">
        <div class="kpi"><div class="k">Pedidos del día</div><div class="v">${d.pedidosDelDia}</div><div class="s">${d.rechazados} rechazado(s)</div></div>
        <div class="kpi"><div class="k">Pendientes</div><div class="v">${d.pendientes}</div><div class="s">esperando pago</div></div>
        <div class="kpi"><div class="k">Ventas confirmadas</div><div class="v">${money(d.ventasConfirmadas)}</div><div class="s">${d.pedidosPagados} pedido(s) pagados</div></div>
        <div class="kpi"><div class="k">Ticket promedio</div><div class="v">${money(d.ticketPromedio)}</div><div class="s">de pedidos pagados</div></div></div>`;
      $('#stats').innerHTML = `
        <p class="hint">Día ${esc(s.dia)} · hora de Chile (${esc(s.zonaHoraria)}). Solo cuentan como ventas los pedidos con pago confirmado por caja.</p>
        <h2 style="font-size:17px;margin:12px 0 8px">Operación real</h2>${kpis(s.real)}
        ${state.demoMode || s.demo.pedidosDelDia ? `<h2 style="font-size:17px;margin:12px 0 8px">Pedidos de demostración <span class="tag tag-demo">NO son ventas</span></h2>${kpis(s.demo, 'demo')}` : ''}
        <button class="btn btn-block" id="refreshStats">Actualizar</button>`;
      $('#refreshStats').onclick = loadStats;
    } catch (e) { $('#stats').innerHTML = `<p class="notice notice-bad">${esc(e.message)}</p>`; }
  }

  // ---------------- Ajustes ----------------
  async function renderSettings() {
    await loadSettings();
    const s = state.settings;
    const r = await call('/api/admin/readiness');
    const f = (k, label, extra = '') => `<label class="field"><span>${label}</span><input class="input" name="${k}" value="${esc(s[k])}" ${extra}></label>`;
    $('#settings').innerHTML = `
      <div class="settings-grid">
      <div>
      <div class="card-s">
        <h2>Modo de operación</h2>
        ${state.demoMode
          ? '<p class="notice notice-demo"><b>Modo demostración activo.</b> Clientes y caja ven el aviso. Los pedidos quedan marcados como DEMO y no cuentan como ventas.</p>'
          : '<p class="notice notice-ok"><b>Operación real.</b> Los pedidos cuentan como ventas.</p>'}
        ${r.blockers.length ? `<p><b>Antes de salir del modo demostración falta:</b></p><ul class="readiness">${r.blockers.map((b) => `<li>${esc(b.msg)}${b.items.length ? `<details><summary>${b.items.length} producto(s)</summary>${b.items.map(esc).join(', ')}</details>` : ''}</li>`).join('')}</ul>` : '<p class="notice notice-ok">No quedan datos provisionales bloqueantes.</p>'}
        ${r.warnings.map((w) => `<p class="hint">ℹ ${esc(w.msg)}: ${w.items.length}</p>`).join('')}
        ${state.demoMode
          ? `<button class="btn btn-primary btn-block" id="goLive" ${r.ready ? '' : 'disabled'}>Pasar a operación real</button>`
          : '<button class="btn btn-block" id="goDemo">Volver a modo demostración</button>'}
      </div>
      <form class="card-s" id="bankForm">
        <h2>Datos bancarios para transferencias</h2>
        ${f('bank_holder', 'Titular')}${f('bank_rut', 'RUT')}${f('bank_name', 'Banco')}${f('bank_account_type', 'Tipo de cuenta')}
        ${f('bank_account_number', 'Número de cuenta', 'inputmode="numeric"')}${f('bank_email', 'Correo para aviso', 'type="email"')}
        <label class="check"><input type="checkbox" name="bank_is_test" ${s.bank_is_test === '1' ? 'checked' : ''}><span>Son <b>datos de prueba</b> (desmarca solo cuando hayas revisado los datos reales)</span></label>
        ${f('business_name', 'Nombre del local')}
        ${f('public_url', 'Dirección pública definitiva', 'type="url" placeholder="https://carta.ruckamonkey.cl"')}
        <button class="btn btn-primary btn-block">Guardar datos</button>
      </form>
      </div>
      <div>
      <div class="card-s" id="secCard"><h2>Seguridad</h2><p class="hint">Cargando…</p></div>
      <div class="card-s">
        <h2>QR de prueba</h2>
        <p class="hint">Para revisar la experiencia con tu teléfono. <b>No lo imprimas para clientes.</b></p>
        <label class="field"><span>Dirección de la carta</span><input class="input" id="qrBase" value="${esc(location.origin)}"></label>
        <button class="btn btn-block" id="qrTest">Mostrar QR de prueba</button>
      </div>
      <div class="card-s">
        <h2>QR definitivo</h2>
        ${state.demoMode ? '<p class="notice notice-warn">Se habilita al salir del modo demostración, con la dirección pública definitiva.</p>' : '<button class="btn btn-primary btn-block" id="qrFinal">Mostrar QR definitivo</button>'}
      </div>
      <div class="card-s">
        <h2>Pedidos de demostración</h2>
        <p class="hint">Bórralos antes de empezar a vender para que no se confundan con ventas reales.</p>
        <button class="btn btn-bad btn-block" id="delDemo">Borrar pedidos de demostración</button>
      </div>
      <form class="card-s" id="pwForm">
        <h2>Contraseña del panel</h2>
        <label class="field"><span>Actual</span><input class="input" type="password" name="current" autocomplete="current-password"></label>
        <label class="field"><span>Nueva (mínimo 10 caracteres)</span><input class="input" type="password" name="next" autocomplete="new-password"></label>
        <button class="btn btn-block">Cambiar contraseña</button>
      </form>
      <button class="btn btn-block" id="logout">Cerrar sesión</button>
      </div></div>`;

    call('/api/admin/security').then((d) => {
      const yes = (b) => (b ? '<span class="tag tag-ok">Activo</span>' : '<span class="tag">No configurado</span>');
      $('#secCard').innerHTML = `<h2>Seguridad</h2>
        <p style="margin:0 0 6px">Conexión cifrada (HTTPS): ${yes(d.https)}</p>
        <p style="margin:0 0 6px">Verificación Cloudflare Turnstile: ${yes(d.turnstile)}</p>
        <p style="margin:0 0 6px">Candado de origen (dominio propio en Cloudflare): ${yes(d.candadoOrigen)}</p>
        <p class="hint" style="margin:8px 0 4px">Tu IP según el servidor: <b>${esc(d.ipDetectada)}</b> (fuente: ${esc(d.fuenteIp)}). Debe ser la IP de tu conexión, no la de un servidor intermedio.</p>
        <p class="hint" style="margin:0">Límites: ${esc(d.limites.loginFallosPorIp)} intentos fallidos de acceso; pedidos sin verificación ${esc(d.limites.pedidosSinDesafio)}; máximo ${esc(d.limites.pedidosMaximo)}.</p>`;
    }).catch(() => { $('#secCard').innerHTML = '<h2>Seguridad</h2><p class="hint">No se pudo cargar el diagnóstico.</p>'; });

    $('#bankForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries([...fd.entries()]);
      data.bank_is_test = e.target.bank_is_test.checked;
      try { await call('/api/admin/settings', { method: 'PATCH', json: data }); toast('Datos guardados'); renderSettings(); } catch (er) { toast(er.message, 4000); }
    });
    $('#pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try { await call('/api/admin/password', { method: 'POST', json: { current: fd.get('current'), next: fd.get('next') } }); toast('Contraseña cambiada'); e.target.reset(); } catch (er) { toast(er.message, 4000); }
    });
    const qr = async (type) => {
      try {
        const d = await call(`/api/admin/qr?type=${type}&base=${encodeURIComponent($('#qrBase')?.value || '')}`);
        const sh = sheet({
          title: type === 'prueba' ? 'QR de prueba' : 'QR definitivo',
          body: `<div class="qr-box print-area">${type === 'prueba' ? '<div class="qr-label" style="color:var(--demo)">QR DE PRUEBA — NO PUBLICAR</div>' : '<div class="qr-label">Escanea y pide · Rucka Monkey</div>'}
            <div class="qr-svg">${d.svg}</div><div class="qr-url">${esc(d.url)}</div></div>`,
          foot: `<div class="o-actions">${d.png ? `<a class="btn btn-primary" href="${esc(d.png)}" download data-download>Descargar PNG</a>` : ''}<button class="btn" data-print>Imprimir</button></div>`,
        });
        $('[data-print]', sh.root).onclick = () => window.print();
      } catch (er) { toast(er.message, 4000); }
    };
    $('#qrTest').onclick = () => qr('prueba');
    $('#qrFinal')?.addEventListener('click', () => qr('final'));
    $('#goLive')?.addEventListener('click', async () => {
      if (!await RM.confirm('¿Confirmas que precios, productos, descripciones y datos bancarios son los reales y fueron revisados?', { ok: 'Sí, pasar a operación real' })) return;
      try { await call('/api/admin/demo-mode', { method: 'POST', json: { enabled: false } }); toast('Operación real activada'); renderSettings(); } catch (er) { toast(er.message, 4000); }
    });
    $('#goDemo')?.addEventListener('click', async () => {
      await call('/api/admin/demo-mode', { method: 'POST', json: { enabled: true } });
      renderSettings();
    });
    $('#delDemo').onclick = async () => {
      if (!await RM.confirm('¿Borrar todos los pedidos de demostración y sus comprobantes?', { ok: 'Borrar', danger: true })) return;
      const r2 = await call('/api/admin/demo-orders', { method: 'DELETE' });
      toast(`${r2.deleted} pedido(s) de demostración borrados`);
      poll();
    };
    $('#logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); clearTimeout(pollTimer); showLogin(); };
  }

  // Mantiene la pantalla del celular encendida mientras el panel está abierto (si el navegador lo permite).
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !document.hidden) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* no disponible */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !wakeLock) keepAwake(); });
  document.addEventListener('click', () => { if (!wakeLock) keepAwake(); }, { once: true });

  window.RMAdmin = { call, staffName, switchTab: (t) => switchTab(t) };
  boot().catch(() => showLogin());
})();
