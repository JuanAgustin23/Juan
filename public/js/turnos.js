'use strict';
// Pestaña "Caja": apertura y cierre de turno, ingresos/retiros de efectivo e historial de cierres.
// Pensada para el celular del cajero: cifras grandes, botones grandes, una acción por pantalla.
window.RMTurnos = (() => {
  const { money, esc, toast, sheet, store, timeFmt } = RM;
  const $ = (s, r = document) => r.querySelector(s);
  const call = (...a) => window.RMAdmin.call(...a);
  const dateFmt = new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  const KIND = { ingreso: 'Ingreso', retiro: 'Retiro', devolucion: 'Devolución en efectivo', devolucion_transferencia: 'Transferencia devuelta' };
  let root = null;
  let timer = null;
  let histDate = null;

  const hora = (ms) => (ms ? timeFmt.format(ms) : '—');
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
  const diffTag = (d) => (d == null ? '' : d === 0 ? '<span class="tag tag-ok">Cuadra</span>' : d > 0 ? `<span class="tag tag-info">Sobrante ${money(d)}</span>` : `<span class="tag tag-bad">Faltante ${money(-d)}</span>`);
  const pesos = (v) => { const t = String(v ?? '').replace(/[.$\s]/g, ''); return /^\d+$/.test(t) ? Number(t) : NaN; };

  // Cálculo paso a paso del efectivo esperado (igual que el servidor)
  function steps(e, counted) {
    const rows = [
      ['Efectivo inicial', money(e.inicial)],
      [`+ Ventas cobradas en efectivo${e.ventasCantidad != null ? ` (${e.ventasCantidad})` : ''}`, money(e.ventas)],
      ['+ Ingresos manuales', money(e.ingresos)],
      ['− Retiros manuales', money(e.retiros)],
      ['− Devoluciones en efectivo', money(e.devoluciones)],
    ];
    let html = `<div class="calc">${rows.map(([k, v]) => `<div class="calc-row"><span>${k}</span><b>${v}</b></div>`).join('')}
      <div class="calc-row calc-total"><span>= Efectivo esperado</span><b>${money(e.esperado)}</b></div>`;
    if (counted != null) {
      const d = counted - e.esperado;
      html += `<div class="calc-row"><span>Efectivo contado</span><b>${money(counted)}</b></div>
        <div class="calc-row calc-diff ${d === 0 ? 'ok' : d > 0 ? 'plus' : 'minus'}"><span>Diferencia (contado − esperado)</span><b>${d === 0 ? 'Cuadra' : `${d > 0 ? 'Sobrante' : 'Faltante'} ${money(Math.abs(d))}`}</b></div>`;
    }
    return html + '</div>';
  }
  const counters = (p) => `<div class="kcount">
      ${[['Recibidos', p.recibidos], ['Cobrados', p.cobrados], ['Entregados', p.entregados], ['Rechazados', p.rechazados], ['Pendientes', p.pendientes]]
        .map(([k, v]) => `<div class="${k === 'Pendientes' && v ? 'warn' : ''}"><b>${v}</b><span>${k}</span></div>`).join('')}</div>`;
  const movesList = (m) => (m.length ? `<ul class="moves">${m.map((x) => `<li><span class="mv-k mv-${x.kind}">${KIND[x.kind]}</span>
      <span class="mv-r">${esc(x.reason)}<small>${hora(x.at)} · ${esc(x.by)}</small></span><b>${x.kind === 'ingreso' ? '+' : x.kind === 'devolucion_transferencia' ? '' : '−'}${money(x.amount)}</b></li>`).join('')}</ul>`
    : '<p class="hint">Sin ingresos ni retiros.</p>');

  function staffField(id = 'tsBy') {
    return `<label class="field"><span>Responsable</span><input class="input" id="${id}" maxlength="40" autocomplete="name" placeholder="Tu nombre" value="${esc(store.get('rm_staff', ''))}"></label>`;
  }
  function takeStaff(scope, id = 'tsBy') {
    const v = $(`#${id}`, scope).value.trim();
    if (v.length < 2) { toast('Escribe tu nombre como responsable'); $(`#${id}`, scope).focus(); return null; }
    store.set('rm_staff', v);
    return v;
  }

  async function render(el) {
    root = el || root;
    if (!root) return;
    clearTimeout(timer);
    let d;
    try { d = await call('/api/admin/shifts/current'); } catch (e) { root.innerHTML = `<p class="notice notice-bad">${esc(e.message)}</p>`; return; }
    histDate ||= d.today;
    const s = d.shift;
    const warnStorage = d.almacenamiento && !d.almacenamiento.persistente
      ? `<p class="notice notice-bad"><b>Atención:</b> ${esc(d.almacenamiento.detalle)}. Para conservar los cierres hace falta un disco persistente.</p>` : '';
    const demo = d.demo ? '<span class="tag tag-demo">Turno de demostración</span>' : '';
    let body;
    if (!s) {
      body = `<div class="card-s">
        <h2>Abrir caja ${demo}</h2>
        <p class="hint" style="margin-top:0">Cuenta el efectivo que dejas para dar vuelto antes de empezar.</p>
        <label class="field"><span>Efectivo inicial (CLP)</span><input class="input big-input" id="tsOpenCash" inputmode="numeric" pattern="[0-9]*" placeholder="20000"></label>
        ${staffField()}
        <button class="btn btn-primary btn-block big-btn" id="tsOpen">Abrir turno</button>
        ${d.cobrosSinTurnoHoy ? `<p class="notice notice-warn">Hoy hay ${d.cobrosSinTurnoHoy} cobro(s) confirmado(s) sin turno abierto: no aparecen en ningún cierre.</p>` : ''}
      </div>`;
    } else {
      const e = s.summary.efectivo;
      const t = s.summary.transferencias;
      body = `<div class="card-s shift-open">
          <div class="shift-head"><div><h2>Turno abierto</h2><p class="hint" style="margin:2px 0 0">Desde las ${hora(s.openedAt)} · ${esc(s.openedBy)}</p></div>${demo}</div>
          <div class="expected"><span>Efectivo que debería haber en caja</span><b>${money(e.esperado)}</b></div>
          ${steps(e)}
          <div class="transfer-box"><span>Transferencias confirmadas en la cuenta <small>(aparte, no están en la caja)</small></span><b>${money(t.confirmadas)}</b><small>${t.cantidad} pedido(s)</small></div>
          ${counters(s.summary.pedidos)}
          <div class="two-btn"><button class="btn big-btn" id="tsIn">+ Ingreso de efectivo</button><button class="btn big-btn" id="tsOut">− Retiro de efectivo</button></div>
        </div>
        <div class="card-s"><h2>Movimientos del turno</h2>${movesList(s.summary.movimientos)}</div>
        <button class="btn btn-bad btn-block big-btn" id="tsClose">Cerrar turno y contar efectivo</button>`;
    }
    root.innerHTML = `<header class="view-head"><h1>Caja</h1></header>${warnStorage}${body}
      <div class="card-s" style="margin-top:14px"><h2>Historial de cierres</h2>
        <label class="field"><span>Día (hora de Chile)</span><input class="input" type="date" id="tsDate" value="${esc(histDate)}" max="${esc(d.today)}"></label>
        <div id="tsHist"><p class="hint">Cargando…</p></div></div>`;
    $('#tsOpen', root)?.addEventListener('click', openShift);
    $('#tsIn', root)?.addEventListener('click', () => movement('ingreso'));
    $('#tsOut', root)?.addEventListener('click', () => movement('retiro'));
    $('#tsClose', root)?.addEventListener('click', () => closeShift(s));
    $('#tsDate', root).addEventListener('change', (ev) => { histDate = ev.target.value; loadHistory(); });
    loadHistory();
    // Se actualiza sola mientras la pestaña está abierta (sin interrumpir si hay una hoja abierta)
    timer = setTimeout(function tick() {
      if (!root.isConnected || root.closest('[hidden]')) return;
      if (!document.querySelector('.sheet-backdrop')) render();
      else timer = setTimeout(tick, 5000);
    }, 10000);
  }

  async function loadHistory() {
    const box = $('#tsHist', root);
    try {
      const d = await call(`/api/admin/shifts?date=${encodeURIComponent(histDate)}`);
      box.innerHTML = d.shifts.length ? `<ul class="hist">${d.shifts.map((s) => `<li><button class="hist-btn" data-shift="${s.id}">
          <span class="hist-t">Turno ${s.turno}${s.isDemo ? ' <span class="tag tag-demo">DEMO</span>' : ''}</span>
          <span class="hist-h">${hora(s.openedAt)} → ${s.closedAt ? hora(s.closedAt) : 'abierto'} · ${esc(s.openedBy)}</span>
          <span class="hist-d">${s.status === 'cerrado' ? `${money(s.countedCash)} contado ${diffTag(s.difference)}` : '<span class="tag tag-warn">Abierto</span>'}${s.corrections ? ` <span class="tag tag-warn">${s.corrections} corrección(es)</span>` : ''}</span>
        </button></li>`).join('')}</ul>` : `<p class="hint">No hay turnos ${d.demo ? 'de demostración ' : ''}ese día.</p>`;
      box.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => showShift(Number(b.dataset.shift))));
    } catch (e) { box.innerHTML = `<p class="notice notice-bad">${esc(e.message)}</p>`; }
  }

  async function openShift() {
    const cash = pesos($('#tsOpenCash', root).value);
    if (Number.isNaN(cash)) { toast('Escribe el efectivo inicial en pesos, sin puntos. Ej.: 20000'); return; }
    const by = takeStaff(root);
    if (!by) return;
    try {
      await call('/api/admin/shifts/open', { method: 'POST', json: { openingCash: cash, by } });
      toast(`Caja abierta con ${money(cash)}`);
      render();
    } catch (e) { toast(e.message, 4000); }
  }

  function movement(kind) {
    const sh = sheet({
      title: kind === 'ingreso' ? 'Ingreso de efectivo' : 'Retiro de efectivo',
      body: `<label class="field"><span>Monto (CLP)</span><input class="input big-input" id="mvAmount" inputmode="numeric" pattern="[0-9]*" placeholder="5000"></label>
        <label class="field"><span>Motivo</span><input class="input" id="mvReason" maxlength="120" placeholder="${kind === 'ingreso' ? 'Ej.: sencillo traído del banco' : 'Ej.: compra de pan en el almacén'}"></label>
        ${staffField('mvBy')}
        <p class="hint">Se guarda con la hora y el responsable. No se puede borrar: si te equivocas, anota el movimiento contrario con el motivo.</p>`,
      foot: `<button class="btn btn-primary btn-block big-btn" data-save>${kind === 'ingreso' ? 'Registrar ingreso' : 'Registrar retiro'}</button>`,
    });
    $('[data-save]', sh.root).addEventListener('click', async () => {
      const amount = pesos($('#mvAmount', sh.root).value);
      if (Number.isNaN(amount) || amount <= 0) { toast('Escribe el monto en pesos, sin puntos'); return; }
      const reason = $('#mvReason', sh.root).value.trim();
      if (reason.length < 3) { toast('Escribe el motivo'); return; }
      const by = takeStaff(sh.root, 'mvBy');
      if (!by) return;
      try {
        await call('/api/admin/shifts/movements', { method: 'POST', json: { kind, amount, reason, by } });
        sh.close();
        toast(`${kind === 'ingreso' ? 'Ingreso' : 'Retiro'} de ${money(amount)} registrado`);
        render();
      } catch (e) { toast(e.message, 4000); }
    });
  }

  function closeShift(s) {
    const e = s.summary.efectivo;
    const pend = s.summary.pendientes;
    const sh = sheet({
      title: 'Cerrar turno',
      body: `${pend.length ? `<div class="notice notice-warn"><b>${pend.length} pedido(s) pendiente(s)</b>. Revísalos antes de cerrar:</div>
          <ul class="pend">${pend.map((o) => `<li><b>${esc(o.code)}</b> ${esc(o.customerName)}<span>${o.paymentMethod === 'transferencia' ? `Transferencia${o.receiptAttached ? ' · con comprobante (sin verificar)' : ' · sin comprobante'}` : 'Efectivo'} · ${hora(o.createdAt)}</span><b>${money(o.total)}</b></li>`).join('')}</ul>` : '<p class="notice notice-ok">No hay pedidos pendientes.</p>'}
        <h3 class="section-title">Cálculo del efectivo esperado</h3>
        <div id="clCalc">${steps(e)}</div>
        <label class="field" style="margin-top:12px"><span>Efectivo contado físicamente (CLP)</span><input class="input big-input" id="clCounted" inputmode="numeric" pattern="[0-9]*" placeholder="${e.esperado}"></label>
        <p class="hint" style="margin-top:-6px">Transferencias confirmadas del turno (aparte): <b>${money(s.summary.transferencias.confirmadas)}</b></p>
        <label class="field"><span>Nota (opcional)</span><input class="input" id="clNote" maxlength="300" placeholder="Ej.: faltante por vuelto mal dado"></label>
        ${staffField('clBy')}
        ${pend.length ? '<label class="check"><input type="checkbox" id="clRev"><span>Revisé los pedidos pendientes</span></label>' : ''}`,
      foot: '<button class="btn btn-bad btn-block big-btn" data-go>Cerrar turno</button>',
    });
    const inp = $('#clCounted', sh.root);
    inp.addEventListener('input', () => {
      const c = pesos(inp.value);
      $('#clCalc', sh.root).innerHTML = steps(e, Number.isNaN(c) ? null : c);
    });
    $('[data-go]', sh.root).addEventListener('click', async () => {
      const counted = pesos(inp.value);
      if (Number.isNaN(counted)) { toast('Escribe cuánto efectivo contaste, en pesos'); inp.focus(); return; }
      if (pend.length && !$('#clRev', sh.root).checked) { toast('Marca que revisaste los pedidos pendientes'); return; }
      const by = takeStaff(sh.root, 'clBy');
      if (!by) return;
      try {
        const r = await call('/api/admin/shifts/close', { method: 'POST', json: { countedCash: counted, by, pendingReviewed: true, note: $('#clNote', sh.root).value } });
        sh.close();
        toast('Turno cerrado y guardado');
        await render();
        showShift(r.shift.id);
      } catch (err) { toast(err.message, 4000); }
    });
  }

  async function showShift(id) {
    let s;
    try { s = (await call(`/api/admin/shifts/${id}`)).shift; } catch (e) { toast(e.message); return; }
    const sum = s.summary;
    sheet({
      title: `Cierre del ${dateFmt.format(s.openedAt)}`,
      wide: true,
      body: `${s.isDemo ? '<p class="notice notice-demo">Turno de <b>demostración</b>: no son ventas reales.</p>' : ''}
        <dl class="shift-dl">
          <dt>Apertura</dt><dd>${hora(s.openedAt)} · ${esc(s.openedBy)}</dd>
          <dt>Cierre</dt><dd>${s.closedAt ? `${hora(s.closedAt)} · ${esc(s.closedBy)}` : 'Turno abierto'}</dd>
          ${s.closeNote ? `<dt>Nota</dt><dd>${esc(s.closeNote)}</dd>` : ''}
        </dl>
        ${counters(sum.pedidos)}
        <h3 class="section-title">Efectivo</h3>
        ${steps(sum.efectivo, s.status === 'cerrado' ? s.countedCash : null)}
        <div class="transfer-box" style="margin-top:10px"><span>Transferencias confirmadas <small>(aparte)</small></span><b>${money(sum.transferencias.confirmadas)}</b><small>${sum.transferencias.cantidad} pedido(s)</small></div>
        <h3 class="section-title">Cobros del turno</h3>
        ${sum.cobros.length ? `<ul class="pend">${sum.cobros.map((o) => `<li><b>${esc(o.code)}</b> ${esc(o.customerName)}<span>${o.paymentMethod === 'efectivo' ? 'Efectivo' : 'Transferencia'} · ${hora(o.paidAt)}</span><b>${money(o.total)}</b></li>`).join('')}</ul>` : '<p class="hint">Sin cobros.</p>'}
        <h3 class="section-title">Movimientos de efectivo</h3>
        ${movesList(sum.movimientos)}
        ${s.corrections.length ? `<h3 class="section-title">Correcciones después del cierre</h3>
          <p class="hint" style="margin-top:0">El cierre guardado no se modificó. Estos cambios se registraron después:</p>
          <ul class="corr">${s.corrections.map((c) => `<li><div class="corr-top"><span class="mv-k mv-retiro">Corrección</span>
              <b>${c.cashDelta ? `Efectivo ${signed(c.cashDelta)}` : ''}${c.transferDelta ? `Transferencias ${signed(c.transferDelta)}` : ''}</b></div>
            <p>${esc(c.detail)}</p><small>${dateFmt.format(c.at)} ${hora(c.at)} · ${esc(c.by)} · sesión ${esc(c.session || '—')}</small></li>`).join('')}</ul>
          ${s.current ? `<p class="hint">Cifras recalculadas hoy: efectivo esperado ${money(s.current.efectivo.esperado)} · transferencias ${money(s.current.transferencias.confirmadas)}.</p>` : ''}` : ''}`,
    });
  }

  return { render };
})();
