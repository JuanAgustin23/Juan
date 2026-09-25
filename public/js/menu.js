'use strict';
(() => {
  const { money, esc, api, toast, sheet, store, uuid, STATUS, modsHtml } = RM;
  const CART_KEY = 'rm_cart_v1';
  const CHECKOUT_KEY = 'rm_checkout_key';
  const LAST_KEY = 'rm_last_order';

  let menu = null;          // respuesta de /api/menu
  let products = new Map(); // id -> producto
  let cart = store.get(CART_KEY, []);

  const $ = (s) => document.querySelector(s);

  // ---------------- Carga ----------------
  async function loadMenu() {
    menu = await api('/api/menu');
    products = new Map(menu.categories.flatMap((c) => c.products).map((p) => [p.id, p]));
    const s = menu.settings;
    $('#bizName').textContent = s.businessName || 'Rucka Monkey';
    $('#demoBanner').hidden = !s.demoMode;
    document.documentElement.style.setProperty('--banner-h', s.demoMode ? `${$('#demoBanner').offsetHeight}px` : '0px');
    // Quita del carrito lo que ya no existe (producto desactivado, ingrediente o extra eliminado)
    cart = cart.filter((l) => products.has(l.productId)).map((l) => {
      const p = products.get(l.productId);
      const ing = new Set(p.ingredients.filter((g) => g.removable).map((g) => g.id));
      const ex = new Set(p.extras.map((e) => e.id));
      return { ...l, removed: l.removed.filter((id) => ing.has(id)), extras: l.extras.filter((id) => ex.has(id)) };
    });
    saveCart();
  }

  function productImg(p, cls = 'thumb') {
    if (!p.image) return `<div class="${cls}"></div>`;
    const label = p.imageKind === 'ilustracion' ? '<span class="tag">Ilustración</span>' : '';
    return `<div class="${cls}"><img src="${esc(p.image)}" alt="${p.imageKind === 'ilustracion' ? 'Ilustración de ' : 'Foto de '}${esc(p.name)}" loading="lazy">${label}</div>`;
  }

  function renderMenu() {
    const cats = menu.categories;
    // Cada categoría lleva la imagen de su primer producto como ícono, para reconocerla de un vistazo.
    $('#cats').innerHTML = cats.map((c, i) => {
      const icon = c.products.find((p) => p.image)?.image;
      return `<a href="#cat-${c.id}" class="${i === 0 ? 'on' : ''}" data-cat="${c.id}">${icon ? `<img src="${esc(icon)}" alt="" aria-hidden="true">` : ''}<span>${esc(c.name)}</span></a>`;
    }).join('');
    $('#menu').innerHTML = cats.map((c) => `
      <section class="cat" id="cat-${c.id}" aria-labelledby="h-${c.id}">
        <h2 id="h-${c.id}">${esc(c.name)}</h2>
        ${c.products.some((p) => p.isPlaceholder) ? '<p class="notice notice-demo">Opciones provisionales: el listado real de bebidas aún no está cargado.</p>' : ''}
        <div class="grid">
          ${c.products.map((p) => `
            <button class="card" data-product="${p.id}" aria-label="${esc(p.name)}, ${money(p.price)}">
              ${productImg(p)}
              <div class="card-body">
                <h3>${esc(p.name)}</h3>
                <p class="desc">${esc(p.description)}</p>
                <div class="tags">
                  ${p.priceIsTest ? '<span class="tag tag-demo">Precio de prueba</span>' : ''}
                  ${p.descriptionProvisional ? '<span class="tag tag-warn">Descripción provisional</span>' : ''}
                  ${p.isPlaceholder ? '<span class="tag tag-warn">Provisional</span>' : ''}
                </div>
                <div class="buy"><span class="price">${money(p.price)}</span><span class="add" aria-hidden="true">+</span></div>
              </div>
            </button>`).join('')}
        </div>
      </section>`).join('');
    observeCats();
  }

  function observeCats() {
    if (!('IntersectionObserver' in window)) return;
    const links = [...document.querySelectorAll('#cats a')];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = e.target.id.replace('cat-', '');
        links.forEach((a) => a.classList.toggle('on', a.dataset.cat === id));
        const on = links.find((a) => a.dataset.cat === id);
        on?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      }
    }, { rootMargin: '-40% 0px -55% 0px' });
    document.querySelectorAll('.cat').forEach((s) => io.observe(s));
  }

  // ---------------- Carrito ----------------
  function saveCart() {
    store.set(CART_KEY, cart);
    renderCartBar();
  }
  function unitPrice(l) {
    const p = products.get(l.productId);
    return p.price + p.extras.filter((e) => l.extras.includes(e.id)).reduce((s, e) => s + e.price, 0);
  }
  const cartTotal = () => cart.reduce((s, l) => s + unitPrice(l) * l.quantity, 0);
  const cartCount = () => cart.reduce((s, l) => s + l.quantity, 0);
  const sameConfig = (a, b) => a.productId === b.productId && a.note === b.note &&
    a.removed.join() === b.removed.join() && a.extras.join() === b.extras.join();

  function renderCartBar() {
    const n = cartCount();
    $('#cartbar').hidden = n === 0;
    $('#cartCount').textContent = n;
    $('#headCount').hidden = n === 0;
    $('#headCount').textContent = n;
    if (products.size) $('#cartTotal').textContent = money(cartTotal());
  }

  function lineView(l) {
    const p = products.get(l.productId);
    return {
      removed: p.ingredients.filter((g) => l.removed.includes(g.id)).map((g) => g.name),
      extras: p.extras.filter((e) => l.extras.includes(e.id)),
      note: l.note,
    };
  }

  // ---------------- Personalización de un producto ----------------
  // `editing` = línea existente del carrito que se está modificando.
  function openProduct(pid, editing = null) {
    const p = products.get(pid);
    if (!p) return;
    const st = editing
      ? { quantity: editing.quantity, removed: new Set(editing.removed), extras: new Set(editing.extras), note: editing.note }
      : { quantity: 1, removed: new Set(), extras: new Set(), note: '' };
    const removable = p.ingredients.filter((g) => g.removable);
    const fixed = p.ingredients.filter((g) => !g.removable);
    const anyProvisional = p.ingredients.some((g) => g.provisional);

    const body = `
      <div class="pd-img">${p.image ? `<img src="${esc(p.image)}" alt="">${p.imageKind === 'ilustracion' ? '<span class="tag">Imagen ilustrativa, no es foto del local</span>' : ''}` : ''}</div>
      <p style="margin:0 0 8px">${esc(p.description)}</p>
      <div class="row" style="display:flex;flex-wrap:wrap;gap:6px">
        <span class="price">${money(p.price)}</span>
        ${p.priceIsTest ? '<span class="tag tag-demo">Precio de prueba</span>' : ''}
        ${p.descriptionProvisional ? '<span class="tag tag-warn">Descripción provisional</span>' : ''}
      </div>
      ${p.ingredients.length ? `
        <h3 class="section-title">Ingredientes</h3>
        ${anyProvisional ? '<p class="hint" style="margin:0 0 6px">Los marcados con * están por confirmar con el local.</p>' : ''}
        ${fixed.length ? `<p class="hint" style="margin:0 0 6px">Incluye: ${fixed.map((g) => esc(g.name) + (g.provisional ? '*' : '')).join(', ')}</p>` : ''}
        ${removable.length ? `<p class="hint" style="margin:0 0 6px">Marca lo que quieres <b>quitar</b>:</p>
        <div class="box">${removable.map((g) => `
          <label class="check"><input type="checkbox" data-remove="${g.id}" ${st.removed.has(g.id) ? 'checked' : ''}>
            <span>Sin ${esc(g.name)}${g.provisional ? '*' : ''}</span></label>`).join('')}</div>` : ''}` : ''}
      ${p.extras.length ? `
        <h3 class="section-title">Agregados con costo</h3>
        <div class="box">${p.extras.map((e) => `
          <label class="check"><input type="checkbox" data-extra="${e.id}" ${st.extras.has(e.id) ? 'checked' : ''}>
            <span style="flex:1">${esc(e.name)}</span><b>+${money(e.price)}</b></label>`).join('')}</div>` : ''}
      <h3 class="section-title">Nota para este producto</h3>
      <textarea class="input" id="pdNote" maxlength="140" placeholder="Ej.: sin mayo, agregar mostaza, bien tostado">${esc(st.note)}</textarea>
      <p class="hint">La nota no agrega cobros. Si pides algo que el local no tiene, caja lo verá y te avisará antes de confirmar.</p>
      ${!editing ? '<p class="hint"><b>¿Dos unidades con indicaciones distintas?</b> Agrega una, vuelve a abrir el producto y agrega la otra con su propia nota: quedarán como líneas separadas.</p>' : ''}`;

    const foot = `<div class="foot-row">
        <div class="stepper" aria-label="Cantidad"><button type="button" data-q="-1" aria-label="Quitar una">−</button><output id="pdQty">${st.quantity}</output><button type="button" data-q="1" aria-label="Agregar una">+</button></div>
        <button class="btn btn-primary" id="pdAdd"></button></div>`;
    const sh = sheet({ title: p.name, body, foot });
    const price = () => (p.price + p.extras.filter((e) => st.extras.has(e.id)).reduce((s, e) => s + e.price, 0)) * st.quantity;
    const refresh = () => {
      sh.root.querySelector('#pdQty').textContent = st.quantity;
      sh.root.querySelector('#pdAdd').textContent = `${editing ? 'Guardar' : 'Agregar'} · ${money(price())}`;
    };
    refresh();
    sh.root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.remove) t.checked ? st.removed.add(Number(t.dataset.remove)) : st.removed.delete(Number(t.dataset.remove));
      if (t.dataset.extra) t.checked ? st.extras.add(Number(t.dataset.extra)) : st.extras.delete(Number(t.dataset.extra));
      refresh();
    });
    sh.root.addEventListener('click', (e) => {
      const q = e.target.closest('[data-q]');
      if (q) { st.quantity = Math.min(20, Math.max(1, st.quantity + Number(q.dataset.q))); refresh(); }
      if (e.target.closest('#pdAdd')) {
        const line = {
          lid: editing?.lid || uuid(), productId: p.id, quantity: st.quantity,
          removed: [...st.removed].sort((a, b) => a - b), extras: [...st.extras].sort((a, b) => a - b),
          note: sh.root.querySelector('#pdNote').value.trim().slice(0, 140),
        };
        if (editing) {
          cart = cart.map((l) => (l.lid === editing.lid ? line : l));
        } else {
          const same = cart.find((l) => sameConfig(l, line));
          if (same) same.quantity = Math.min(20, same.quantity + line.quantity); else cart.push(line);
        }
        saveCart();
        sh.close();
        toast(editing ? 'Cambios guardados' : 'Agregado al pedido');
        if (editing) openCart();
      }
    });
  }

  // ---------------- Revisión del pedido ----------------
  let cartSheet = null;
  function cartBody() {
    return `
      ${menu.settings.demoMode ? '<p class="notice notice-demo"><b>Modo demostración:</b> este pedido es de prueba y no es una venta real.</p>' : ''}
      <div id="lines">${cart.map((l) => {
        const p = products.get(l.productId);
        return `<div class="line" data-lid="${l.lid}">
          <div class="line-head"><span>${l.quantity} × ${esc(p.name)}</span><span>${money(unitPrice(l) * l.quantity)}</span></div>
          ${modsHtml(lineView(l))}
          <div class="line-actions">
            <div class="stepper"><button data-step="-1" aria-label="Quitar una unidad">−</button><output>${l.quantity}</output><button data-step="1" aria-label="Agregar una unidad">+</button></div>
            <button class="btn btn-sm" data-edit>Editar</button>
            ${l.quantity > 1 ? '<button class="btn btn-sm" data-split>Indicación distinta para 1</button>' : ''}
            <button class="btn btn-sm btn-bad" data-del aria-label="Eliminar línea">Eliminar</button>
          </div></div>`;
      }).join('')}</div>
      <div class="total-row"><span>Total</span><span>${money(cartTotal())}</span></div>
      ${cart.some((l) => products.get(l.productId).priceIsTest) ? '<p class="hint">Incluye precios de prueba.</p>' : ''}`;
  }
  // Redibuja el contenido sin cerrar la hoja (evita parpadeos al sumar o restar).
  function refreshCart() {
    if (!cart.length) return cartSheet?.close();
    cartSheet.body.innerHTML = cartBody();
  }
  function openCart() {
    cartSheet?.close();
    if (!cart.length) return;
    const foot = '<button class="btn btn-primary btn-block" id="toCheckout">Continuar</button>';
    cartSheet = sheet({ title: 'Tu pedido', body: cartBody(), foot, onClose: () => { cartSheet = null; } });
    cartSheet.root.addEventListener('click', (e) => {
      const lineEl = e.target.closest('[data-lid]');
      const l = lineEl && cart.find((x) => x.lid === lineEl.dataset.lid);
      if (e.target.closest('#toCheckout')) { cartSheet.close(); openCheckout(); return; }
      if (!l) return;
      if (e.target.closest('[data-step]')) {
        l.quantity = Math.min(20, l.quantity + Number(e.target.closest('[data-step]').dataset.step));
        if (l.quantity < 1) cart = cart.filter((x) => x !== l);
        saveCart();
        refreshCart();
      } else if (e.target.closest('[data-del]')) {
        cart = cart.filter((x) => x !== l);
        saveCart();
        refreshCart();
      } else if (e.target.closest('[data-edit]')) {
        cartSheet.close();
        openProduct(l.productId, l);
      } else if (e.target.closest('[data-split]')) {
        // Separa una unidad en su propia línea para darle una indicación distinta
        l.quantity -= 1;
        const copy = { ...l, lid: uuid(), quantity: 1, removed: [...l.removed], extras: [...l.extras] };
        cart.splice(cart.indexOf(l) + 1, 0, copy);
        saveCart();
        cartSheet.close();
        openProduct(copy.productId, copy);
      }
    });
  }

  // ---------------- Envío ----------------
  function openCheckout() {
    const s = menu.settings;
    // Un identificador por intento de envío: si la red falla y se reintenta, no se duplica el pedido.
    let key = store.get(CHECKOUT_KEY, null);
    if (!key || key.cartSig !== JSON.stringify(cart)) { key = { id: uuid(), cartSig: JSON.stringify(cart) }; store.set(CHECKOUT_KEY, key); }
    const b = s.bank;
    const body = `
      <label class="field"><span>Tu nombre</span><input class="input" id="coName" maxlength="40" autocomplete="given-name" placeholder="Para llamarte cuando esté listo" value="${esc(store.get('rm_name', ''))}"></label>
      <div class="field"><span>Forma de pago</span>
        <div class="pay-opts" role="radiogroup">
          <label class="pay-opt"><input type="radio" name="pay" value="efectivo"><span>Efectivo</span></label>
          <label class="pay-opt"><input type="radio" name="pay" value="transferencia"><span>Transferencia</span></label>
        </div></div>
      <div id="cashInfo" hidden><p class="notice notice-info">Pagas en caja. Tu pedido pasa a preparación cuando caja reciba el efectivo.</p></div>
      <div id="transferInfo" hidden>
        <div class="bank">
          <b>Datos para transferir</b> ${s.bankIsTest ? '<span class="tag tag-demo">DATOS DE PRUEBA — NO TRANSFERIR</span>' : ''}
          <dl>
            <dt>Nombre</dt><dd>${esc(b.holder)}</dd><dt>RUT</dt><dd>${esc(b.rut)}</dd><dt>Banco</dt><dd>${esc(b.name)}</dd>
            <dt>Cuenta</dt><dd>${esc(b.account_type)} ${esc(b.account_number)}</dd><dt>Correo</dt><dd>${esc(b.email)}</dd>
            <dt>Monto</dt><dd>${money(cartTotal())}</dd>
          </dl>
        </div>
        <label class="field"><span>Comprobante de transferencia (imagen)</span>
          <input class="input" type="file" id="coReceipt" accept="image/jpeg,image/png,image/webp"></label>
        <img id="coPreview" class="receipt-preview" alt="Vista previa del comprobante" hidden>
        <p class="notice notice-warn"><b>Importante:</b> adjuntar el comprobante no confirma el pago. Caja revisará que el abono haya llegado a la cuenta antes de preparar tu pedido.</p>
      </div>
      <p class="notice notice-bad" id="coError" role="alert" hidden></p>
      <div class="total-row"><span>Total</span><span>${money(cartTotal())}</span></div>`;
    const foot = '<button class="btn btn-primary btn-block" id="coSend">Enviar pedido</button>';
    const sh = sheet({ title: 'Confirmar pedido', body, foot });
    const q = (sel) => sh.root.querySelector(sel);
    let previewUrl = null;
    sh.root.addEventListener('change', (e) => {
      if (e.target.name === 'pay') {
        q('#cashInfo').hidden = e.target.value !== 'efectivo';
        q('#transferInfo').hidden = e.target.value !== 'transferencia';
      }
      if (e.target.id === 'coReceipt') {
        const f = e.target.files[0];
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = f ? URL.createObjectURL(f) : null;
        q('#coPreview').hidden = !f;
        if (f) q('#coPreview').src = previewUrl;
      }
    });
    let tsWidget = null;
    q('#coSend').addEventListener('click', async () => {
      const err = q('#coError');
      err.hidden = true;
      const name = q('#coName').value.trim();
      const pay = sh.root.querySelector('input[name=pay]:checked')?.value;
      if (name.length < 2) { err.textContent = 'Escribe tu nombre.'; err.hidden = false; q('#coName').focus(); return; }
      if (!pay) { err.textContent = 'Elige la forma de pago.'; err.hidden = false; return; }
      const file = pay === 'transferencia' ? q('#coReceipt').files[0] : null;
      if (file && file.size > 8 * 1024 * 1024) { err.textContent = 'La imagen supera los 8 MB.'; err.hidden = false; return; }
      store.set('rm_name', name);
      const order = {
        idempotencyKey: key.id, customerName: name, paymentMethod: pay, expectedTotal: cartTotal(),
        items: cart.map((l) => ({ productId: l.productId, quantity: l.quantity, removedIngredientIds: l.removed, extraIds: l.extras, note: l.note })),
      };
      const fd = new FormData();
      fd.append('order', JSON.stringify(order));
      if (tsWidget) fd.append('turnstile', await tsWidget.token().catch(() => ''));
      if (file) fd.append('receipt', file);
      const btn = q('#coSend');
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      try {
        const r = await api('/api/orders', { method: 'POST', body: fd });
        cart = [];
        saveCart();
        store.del(CHECKOUT_KEY);
        store.set(LAST_KEY, { token: r.token, code: r.code });
        sh.close();
        history.pushState({}, '', `/pedido/${r.token}`);
        route();
      } catch (e2) {
        btn.disabled = false;
        btn.textContent = 'Enviar pedido';
        err.textContent = e2.status ? e2.message : 'Sin conexión. Revisa tu internet y vuelve a tocar “Enviar pedido” (no se duplicará).';
        err.hidden = false;
        // Solo si esta conexión ya envió varios pedidos seguidos, el servidor pide la verificación de Cloudflare.
        if (e2.data?.code === 'TURNSTILE_REQUIRED' && e2.data.siteKey) {
          if (!tsWidget) {
            const box = document.createElement('div');
            box.style.cssText = 'min-height:65px;margin:8px 0';
            err.after(box);
            tsWidget = RM.turnstile(box, e2.data.siteKey, 'pedido');
            tsWidget.ready.catch((e3) => { err.textContent = e3.message; });
          } else tsWidget.reset();
          err.textContent = 'Confirma la verificación de abajo y vuelve a tocar “Enviar pedido”.';
        }
        if (['PRICE_CHANGED', 'MENU_CHANGED', 'UNAVAILABLE'].includes(e2.data?.code)) {
          store.del(CHECKOUT_KEY);
          await loadMenu();
          renderMenu();
          err.textContent += ' La carta se actualizó.';
        }
      }
    });
  }

  // ---------------- Estado del pedido ----------------
  let pollTimer = null;
  async function showStatus(token) {
    $('#app').hidden = true;
    $('#demoBanner').hidden = true;
    const v = $('#statusView');
    v.hidden = false;
    clearTimeout(pollTimer);
    let o;
    try { o = await api(`/api/orders/${encodeURIComponent(token)}`); } catch (e) {
      v.innerHTML = `<p class="notice notice-bad">${e.status === 404 ? 'No encontramos este pedido.' : 'Sin conexión. Reintentando…'}</p><a class="btn" href="/">Volver a la carta</a>`;
      if (e.status !== 404) pollTimer = setTimeout(() => showStatus(token), 5000);
      return;
    }
    $('#demoBanner').hidden = !o.isDemo;
    const order = ['pendiente', 'pago_confirmado', 'en_preparacion', 'listo', 'entregado'];
    const idx = order.indexOf(o.status);
    const waitMsg = o.paymentMethod === 'transferencia'
      ? 'Caja está verificando que la transferencia haya llegado a la cuenta. El comprobante por sí solo no confirma el pago.'
      : 'Acércate a caja para pagar en efectivo.';
    v.innerHTML = `
      ${o.isDemo ? '<p class="notice notice-demo"><b>Pedido de demostración.</b> No es una venta real.</p>' : ''}
      <p class="muted" style="margin:0">Pedido de ${esc(o.customerName)}</p>
      <div class="order-code">${esc(o.code)}</div>
      <p class="muted" style="margin-top:0">Muestra este número en caja.</p>
      ${o.status === 'rechazado' ? '<p class="notice notice-bad"><b>Pedido rechazado.</b> Acércate a caja para más información.</p>' : `
      <ol class="steps">${order.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}"><span class="dot"></span>${STATUS[s]}</li>`).join('')}</ol>`}
      ${o.status === 'pendiente' ? `<p class="notice notice-warn">${waitMsg}</p>` : ''}
      ${o.paymentMethod === 'transferencia' && !o.receiptAttached && o.status === 'pendiente' ? '<p class="notice notice-info">No adjuntaste comprobante. Si ya transferiste, avisa en caja.</p>' : ''}
      <h2 style="font-size:18px;margin:18px 0 8px">Detalle</h2>
      ${o.items.map((it) => `<div class="line"><div class="line-head"><span>${it.quantity} × ${esc(it.productName)}</span><span>${money(it.lineTotal)}</span></div>${modsHtml(it)}</div>`).join('')}
      <div class="total-row"><span>Total</span><span>${money(o.total)}</span></div>
      <p class="hint">Pago: ${o.paymentMethod === 'transferencia' ? 'Transferencia' : 'Efectivo'} · Esta página se actualiza sola.</p>
      <a class="btn btn-block" href="/" id="backToMenu">Volver a la carta</a>`;
    if (!['entregado', 'rechazado'].includes(o.status)) pollTimer = setTimeout(() => showStatus(token), 5000);
  }

  function route() {
    const m = location.pathname.match(/^\/pedido\/([A-Za-z0-9_-]+)$/);
    if (m) return showStatus(m[1]);
    clearTimeout(pollTimer);
    $('#statusView').hidden = true;
    $('#app').hidden = false;
    $('#demoBanner').hidden = !menu?.settings.demoMode;
    const last = store.get(LAST_KEY, null);
    const lo = $('#lastOrder');
    lo.hidden = !last;
    if (last) lo.innerHTML = `Tu último pedido: <b>${esc(last.code)}</b> · <a href="/pedido/${esc(last.token)}" data-link>Ver estado</a>`;
  }

  // ---------------- Eventos ----------------
  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-product]');
    if (card) openProduct(Number(card.dataset.product));
    if (e.target.closest('#openCart, #headCart')) {
      if (cart.length) openCart(); else toast('Tu pedido está vacío: toca un producto para agregarlo');
    }
    const link = e.target.closest('a[data-link], #backToMenu');
    if (link) { e.preventDefault(); history.pushState({}, '', link.getAttribute('href')); route(); }
  });
  window.addEventListener('popstate', route);

  (async () => {
    try {
      await loadMenu();
      renderMenu();
    } catch {
      $('#menu').innerHTML = '<p class="notice notice-bad">No se pudo cargar la carta. Revisa tu conexión y recarga la página.</p>';
    }
    route();
  })();
})();
