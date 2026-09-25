'use strict';
// "Nuevo pedido" desde caja, para clientes que piden en el mostrador (sin teléfono).
// Paso 1: elegir productos (buscar, categorías, "+" rápido o tocar para personalizar).
// Paso 2: revisar, nombre opcional, forma de pago y crear. El servidor recalcula el total.
window.RMMostrador = (() => {
  const { money, esc, toast, sheet, uuid, modsHtml, timeFmt } = RM;
  const $ = (s, r = document) => r.querySelector(s);
  const call = (...a) => window.RMAdmin.call(...a);

  let products = new Map();
  let cats = [];

  async function loadCatalog() {
    const d = await call('/api/admin/catalog');
    cats = d.categories.filter((c) => c.active).map((c) => ({ ...c, products: c.products.filter((p) => p.active) })).filter((c) => c.products.length);
    products = new Map(cats.flatMap((c) => c.products).map((p) => [p.id, p]));
  }

  async function open() {
    try { await loadCatalog(); } catch (e) { toast(e.message, 4000); return; }
    const st = { key: uuid(), lines: [], step: 1, cat: 'todas', q: '', pay: 'efectivo', payNow: false, name: '' };
    const unit = (l) => { const p = products.get(l.productId); return p.price + p.extras.filter((e) => l.extras.includes(e.id)).reduce((s, e) => s + e.price, 0); };
    const total = () => st.lines.reduce((s, l) => s + unit(l) * l.quantity, 0);
    const count = () => st.lines.reduce((s, l) => s + l.quantity, 0);
    const same = (a, b) => a.productId === b.productId && a.note === b.note && a.removed.join() === b.removed.join() && a.extras.join() === b.extras.join();
    const addLine = (line) => {
      const m = st.lines.find((l) => same(l, line));
      if (m) m.quantity = Math.min(20, m.quantity + line.quantity); else st.lines.push(line);
    };
    const view = (l) => {
      const p = products.get(l.productId);
      return { removed: p.ingredients.filter((g) => l.removed.includes(g.id)).map((g) => g.name), extras: p.extras.filter((e) => l.extras.includes(e.id)), note: l.note };
    };

    const sh = sheet({ title: 'Nuevo pedido en caja', wide: true, body: '<div id="moBody"></div>', foot: '<div id="moFoot"></div>' });
    sh.root.querySelector('.sheet').classList.add('mo-sheet');
    let shift = null;
    call('/api/admin/shifts/current').then((d) => { shift = d.shift; if (st.step === 2) render(); }).catch(() => {});

    function productList() {
      const q = st.q.trim().toLowerCase();
      const list = cats.filter((c) => st.cat === 'todas' || String(c.id) === st.cat).flatMap((c) => c.products)
        .filter((p) => !q || p.name.toLowerCase().includes(q));
      return list.map((p) => {
        const inCart = st.lines.filter((l) => l.productId === p.id).reduce((s, l) => s + l.quantity, 0);
        return `<li class="mo-prod" data-pid="${p.id}">
          <button class="mo-main" data-custom="${p.id}">${p.image ? `<img src="${esc(p.image)}" alt="">` : '<span class="noimg"></span>'}
            <span class="mo-txt"><b>${esc(p.name)}</b><span>${money(p.price)}</span></span></button>
          ${inCart ? `<span class="mo-in">${inCart}</span>` : ''}
          <button class="mo-add" data-quick="${p.id}" aria-label="Agregar ${esc(p.name)}">+</button></li>`;
      }).join('') || '<li class="hint" style="padding:12px">Sin resultados.</li>';
    }

    function render() {
      const body = $('#moBody', sh.root);
      const foot = $('#moFoot', sh.root);
      if (st.step === 1) {
        body.innerHTML = `
          <input class="input" id="moQ" type="search" placeholder="Buscar producto" value="${esc(st.q)}" autocomplete="off" aria-label="Buscar producto">
          <div class="chips mo-cats">${[['todas', 'Todas'], ...cats.map((c) => [String(c.id), c.name])].map(([k, n]) => `<button data-cat="${esc(k)}" class="${st.cat === k ? 'on' : ''}">${esc(n)}</button>`).join('')}</div>
          <p class="hint mo-help">Toca <b>+</b> para agregar uno. Toca el producto para quitar ingredientes o escribir una indicación.</p>
          <ul class="mo-list">${productList()}</ul>`;
        foot.innerHTML = `<button class="btn btn-primary btn-block big-btn" data-next ${count() ? '' : 'disabled'}>Revisar pedido (${count()}) · ${money(total())}</button>`;
        $('#moQ', body).addEventListener('input', (e) => { st.q = e.target.value; $('.mo-list', body).innerHTML = productList(); });
        return;
      }
      const t = total();
      body.innerHTML = `
        ${st.lines.length ? '' : '<p class="notice notice-warn">No hay productos. Vuelve atrás para agregar.</p>'}
        <ul class="mo-lines">${st.lines.map((l, i) => {
          const p = products.get(l.productId);
          return `<li data-i="${i}"><div class="mo-lh"><b>${l.quantity} × ${esc(p.name)}</b><b>${money(unit(l) * l.quantity)}</b></div>${modsHtml(view(l))}
            <div class="mo-la"><div class="stepper"><button data-step="-1" aria-label="Quitar una">−</button><output>${l.quantity}</output><button data-step="1" aria-label="Agregar una">+</button></div>
            <button class="btn btn-sm" data-edit>Editar</button><button class="btn btn-sm btn-bad" data-del>Quitar</button></div></li>`;
        }).join('')}</ul>
        <div class="o-total mo-total"><span>Total</span><span>${money(t)}</span></div>
        <p class="hint" style="margin-top:-4px">Precios vigentes. El total final lo calcula el servidor.</p>
        <label class="field"><span>Nombre del cliente (opcional)</span><input class="input" id="moName" maxlength="40" value="${esc(st.name)}" placeholder="Si no lo da, se usa el número de pedido"></label>
        <div class="field"><span>Forma de pago</span><div class="mo-pay">
          <label><input type="radio" name="moPay" value="efectivo" ${st.pay === 'efectivo' ? 'checked' : ''}><span>Efectivo</span></label>
          <label><input type="radio" name="moPay" value="transferencia" ${st.pay === 'transferencia' ? 'checked' : ''}><span>Transferencia</span></label></div></div>
        ${st.pay === 'efectivo'
          ? `<label class="check mo-paynow"><input type="checkbox" id="moPayNow" ${st.payNow ? 'checked' : ''}><span>Recibí <b>${money(t)}</b> en efectivo ahora <small>(se registra la hora de cobro)</small></span></label>`
          : `<p class="notice notice-warn"><b>Un pantallazo no confirma el pago.</b> Revisa en la app o web del banco que llegó el abono de ${money(t)}.</p>
             <label class="check mo-paynow"><input type="checkbox" id="moPayNow" ${st.payNow ? 'checked' : ''}><span>Verifiqué en la cuenta bancaria el abono de <b>${money(t)}</b></span></label>`}
        <p class="hint">${st.payNow ? `El pago quedará confirmado a las ${timeFmt.format(Date.now())} y el pedido pasa a preparación.` : 'Si no marcas el pago, el pedido queda <b>pendiente</b> y lo confirmas después como cualquier otro.'}</p>
        ${shift === null ? '' : !shift && st.payNow ? '<p class="notice notice-warn">No hay un turno de caja abierto: el cobro no quedará en ningún cierre.</p>' : ''}
        <p class="notice notice-bad" id="moErr" role="alert" hidden></p>`;
      foot.innerHTML = `<div class="o-actions"><button class="btn big-btn" data-back>← Agregar</button>
        <button class="btn ${st.payNow ? 'btn-ok' : 'btn-primary'} big-btn" data-create ${st.lines.length ? '' : 'disabled'}>Crear · ${money(t)}</button></div>`;
      $('#moName', body).addEventListener('input', (e) => { st.name = e.target.value; });
    }

    // Personalizar un producto (ingredientes a quitar, extras, nota y cantidad)
    function custom(pid, editing) {
      const p = products.get(pid);
      const c = editing ? { quantity: editing.quantity, removed: new Set(editing.removed), extras: new Set(editing.extras), note: editing.note } : { quantity: 1, removed: new Set(), extras: new Set(), note: '' };
      const removable = p.ingredients.filter((g) => g.removable);
      const s2 = sheet({
        title: p.name,
        body: `${removable.length ? `<h3 class="section-title" style="margin-top:0">Quitar ingredientes</h3><div class="box">${removable.map((g) => `<label class="check"><input type="checkbox" data-rm="${g.id}" ${c.removed.has(g.id) ? 'checked' : ''}><span>Sin ${esc(g.name)}</span></label>`).join('')}</div>` : ''}
          ${p.extras.filter((e) => e.active).length ? `<h3 class="section-title">Agregados con costo</h3><div class="box">${p.extras.filter((e) => e.active).map((e) => `<label class="check"><input type="checkbox" data-ex="${e.id}" ${c.extras.has(e.id) ? 'checked' : ''}><span style="flex:1">${esc(e.name)}</span><b>+${money(e.price)}</b></label>`).join('')}</div>` : ''}
          <h3 class="section-title">Indicación para este producto</h3>
          <textarea class="input" id="cuNote" maxlength="140" placeholder="Ej.: bien tostado, sin mayo">${esc(c.note)}</textarea>
          <p class="hint">Las indicaciones no se cobran.</p>`,
        foot: `<div class="foot-row"><div class="stepper"><button data-q="-1" aria-label="Menos">−</button><output id="cuQty">${c.quantity}</output><button data-q="1" aria-label="Más">+</button></div>
          <button class="btn btn-primary big-btn" style="flex:1" data-ok>${editing ? 'Guardar' : 'Agregar'}</button></div>`,
      });
      s2.root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.rm) t.checked ? c.removed.add(Number(t.dataset.rm)) : c.removed.delete(Number(t.dataset.rm));
        if (t.dataset.ex) t.checked ? c.extras.add(Number(t.dataset.ex)) : c.extras.delete(Number(t.dataset.ex));
      });
      s2.root.addEventListener('click', (e) => {
        const q = e.target.closest('[data-q]');
        if (q) { c.quantity = Math.min(20, Math.max(1, c.quantity + Number(q.dataset.q))); $('#cuQty', s2.root).textContent = c.quantity; }
        if (e.target.closest('[data-ok]')) {
          const line = { productId: p.id, quantity: c.quantity, removed: [...c.removed].sort((a, b) => a - b), extras: [...c.extras].sort((a, b) => a - b), note: $('#cuNote', s2.root).value.trim().slice(0, 140) };
          if (editing) st.lines.splice(st.lines.indexOf(editing), 1, line); else addLine(line);
          s2.close();
          render();
          if (!editing) toast(`${p.name} agregado`, 1400);
        }
      });
    }

    async function create() {
      const btn = $('[data-create]', sh.root);
      const err = $('#moErr', sh.root);
      btn.disabled = true;
      btn.textContent = 'Creando…';
      const body = {
        idempotencyKey: st.key, customerName: st.name.trim(), paymentMethod: st.pay, expectedTotal: total(),
        items: st.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, removedIngredientIds: l.removed, extraIds: l.extras, note: l.note })),
        payNow: st.payNow, cashReceived: st.payNow && st.pay === 'efectivo', bankVerified: st.payNow && st.pay === 'transferencia',
      };
      try {
        const r = await call('/api/admin/orders', { method: 'POST', json: body });
        sh.close();
        toast(`Pedido ${r.order.code} creado${r.order.status === 'pago_confirmado' ? ' y pagado' : ' (pendiente de pago)'}`, 3500);
        window.RMAdmin.orderCreated(r.order);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        if (['PRICE_CHANGED', 'MENU_CHANGED', 'UNAVAILABLE'].includes(e.data?.code)) {
          await loadCatalog().catch(() => {});
          st.lines = st.lines.filter((l) => products.has(l.productId));
          st.key = uuid();
          render();
          $('#moErr', sh.root).textContent = `${e.message} Se actualizaron los precios: revisa el total.`;
          $('#moErr', sh.root).hidden = false;
        } else {
          btn.disabled = false;
          btn.textContent = `Crear · ${money(total())}`;
        }
      }
    }

    sh.root.addEventListener('click', (e) => {
      const t = e.target;
      const cat = t.closest('[data-cat]');
      if (cat) { st.cat = cat.dataset.cat; render(); return; }
      const quick = t.closest('[data-quick]');
      if (quick) { const p = products.get(Number(quick.dataset.quick)); addLine({ productId: p.id, quantity: 1, removed: [], extras: [], note: '' }); render(); toast(`+1 ${p.name}`, 1000); return; }
      const cu = t.closest('[data-custom]');
      if (cu) { custom(Number(cu.dataset.custom)); return; }
      if (t.closest('[data-next]')) { st.step = 2; render(); $('.sheet-body', sh.root).scrollTop = 0; return; }
      if (t.closest('[data-back]')) { st.step = 1; render(); return; }
      if (t.closest('[data-create]')) { create(); return; }
      const li = t.closest('.mo-lines li');
      if (li) {
        const l = st.lines[Number(li.dataset.i)];
        if (t.closest('[data-step]')) { l.quantity += Number(t.closest('[data-step]').dataset.step); if (l.quantity < 1) st.lines.splice(st.lines.indexOf(l), 1); l.quantity = Math.min(20, l.quantity); render(); }
        else if (t.closest('[data-del]')) { st.lines.splice(st.lines.indexOf(l), 1); render(); }
        else if (t.closest('[data-edit]')) custom(l.productId, l);
      }
    });
    sh.root.addEventListener('change', (e) => {
      if (e.target.name === 'moPay') { st.pay = e.target.value; st.payNow = false; render(); }
      if (e.target.id === 'moPayNow') { st.payNow = e.target.checked; render(); }
    });
    render();
  }

  document.getElementById('newOrder')?.addEventListener('click', open);
  return { open };
})();
