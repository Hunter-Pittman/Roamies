// A read-only projection of supervisors created by Roamie's models. No setup or dispatch UI.
(() => {
  'use strict';
  const R = window.Roamie;
  // Keep older long reports readable without filling the card with a technical transcript.
  R.supervisorSummary = (text, limit = 640) => {
    const plain = String(text ?? '').trim().replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ');
    if (plain.length <= limit) return plain;
    const sentences = plain.split(/(?<=[.!?])\s+/);
    let summary = '';
    for (const sentence of sentences) {
      if (`${summary} ${sentence}`.trim().length > limit) break;
      summary = `${summary} ${sentence}`.trim();
      if (summary.trim().length >= 200) break;
    }
    return summary.trim() || plain.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
  };
  R.supervisorPlace = (point, size, safe, view) => {
    const b = { l: (safe?.left ?? 0) + 12, t: (safe?.top ?? 0) + 12, r: view[0] - (safe?.right ?? 0) - 12, b: view[1] - (safe?.bottom ?? 0) - 12 };
    return [Math.round(Math.max(b.l, Math.min(point[0], b.r - size[0]))), Math.round(Math.max(b.t, Math.min(point[1], b.b - size[1])))];
  };
  if (typeof document === 'undefined') return;
  const root = document.createElement('section');
  root.className = 'rp sv'; root.hidden = true;
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Supervisors');
  root.innerHTML = `
    <div class="rp-in">
      <div class="rp-head sv-head"><span class="rp-dot"></span><span class="rp-status">Supervisors</span>
        <button data-sv="close" class="rp-x" aria-label="Close Supervisors">&times;</button></div>
      <p data-sv="error" role="alert" hidden></p>
      <div class="sv-main">
        <aside><div class="sv-section-head"><h2>Supervisors</h2><span data-sv="count" class="muted">0</span></div>
          <div data-sv="list" aria-label="Supervisors"></div></aside>
        <section data-sv="detail" aria-label="Supervisor details"></section>
      </div>
      <div class="sv-footer" data-sv="monitoring">Connecting to Roamie...</div>
    </div>`;
  document.body.append(root);
  const $ = (id) => root.querySelector(`[data-sv="${id}"]`);
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const when = (t) => t ? new Date(t).toLocaleString() : 'Not observed yet';
  const stateLabel = (r) => r.observation?.outcome === 'failed' ? 'Failed' : ({ completed: 'Done', working: 'Working', watching: 'Watching', needs_attention: 'Needs you', dispatching: 'Starting', paused: 'Paused', stopped: 'Stopped' }[r.state] ?? r.state);
  let records = [], selected = null, drag = null;
  const notificationsShown = new Set();
  function send(request) { api.send?.({ type: 'supervisor_request', request }); }
  function render() {
    $('count').textContent = String(records.length);
    const list = $('list'), detail = $('detail'), scroll = detail.scrollTop;
    const expanded = detail.dataset.supervisorId === selected && detail.querySelector('details')?.open;
    detail.dataset.supervisorId = selected ?? '';
    list.replaceChildren();
    for (const r of [...records].sort((a, b) => b.createdAt - a.createdAt)) {
      const b = node('button', null, `assignment${r.id === selected ? ' selected' : ''}`);
      b.setAttribute('aria-pressed', String(r.id === selected));
      b.append(node('span', r.result && !r.result.read ? 'New result' : stateLabel(r), `badge ${r.state === 'needs_attention' || r.observation?.outcome === 'failed' ? 'attention' : r.state}`), node('strong', r.title));
      b.onclick = () => { selected = r.id; render(); };
      list.append(b);
    }
    detail.replaceChildren();
    const r = records.find((r) => r.id === selected);
    if (!r) {
      const empty = node('div', null, 'empty');
      empty.append(node('h2', 'No supervisors yet.'), node('p', 'Tell Roamie what you need handled. The supervisors it creates will appear here.'));
      detail.append(empty); return;
    }
    const mode = r.mode ?? (r.kind === 'coordinator' ? 'advanced' : 'basic');
    detail.append(node('span', `${stateLabel(r)} · ${mode === 'advanced' ? 'Advanced' : 'Basic'}`, `badge ${r.observation?.outcome === 'failed' ? 'attention' : ''}`), node('h2', r.title, 'detail-title'));
    if (r.question) detail.append(node('h3', 'Needs you'), node('p', r.question, 'notice'));
    else if (!r.brief && r.notice) detail.append(node('p', R.supervisorSummary(r.notice, 300), 'notice'));
    if (r.connection === 'unavailable' || r.connection === 'changed') detail.append(node('p', 'Updates unavailable. Ask Roamie to check this supervisor.', 'notice'));
    if (r.brief) {
      detail.append(node('h3', 'Result'), node('p', R.supervisorSummary(r.brief), 'brief'));
      if (r.result && !r.result.read && !root.hidden) send({ action: 'read', id: r.id });
    }
    detail.append(node('p', `Updated ${when(r.lastCheckedAt)}`, 'muted updated'));
    const more = node('details', null, 'more');
    more.open = !!expanded;
    more.append(node('summary', 'More detail'));
    if (r.objective) more.append(node('p', r.objective, 'objective'));
    if (r.brief && R.supervisorSummary(r.brief) !== r.brief.trim()) more.append(node('pre', r.brief));
    more.append(node('p', `Connection: ${r.connection ?? 'Unknown'}`, 'muted'));
    detail.append(more);
    detail.scrollTop = scroll;
  }
  function event(m) {
    if (m.kind === 'state') {
      records = m.supervisors ?? [];
      if (!records.some((r) => r.id === selected)) selected = records.at(-1)?.id ?? null;
      $('monitoring').textContent = m.monitoring;
      $('error').hidden = !m.error; $('error').textContent = m.error ?? '';
      render();
    } else if (m.kind === 'error') { $('error').hidden = false; $('error').textContent = m.message; }
  }
  const place = (point) => {
    root.style.maxWidth = Math.max(160, innerWidth - (R.safe?.left ?? 0) - (R.safe?.right ?? 0) - 24) + 'px';
    root.style.maxHeight = Math.max(100, innerHeight - (R.safe?.top ?? 0) - (R.safe?.bottom ?? 0) - 24) + 'px';
    const p = R.supervisorPlace(point, [root.offsetWidth, root.offsetHeight], R.safe, [innerWidth, innerHeight]);
    root.style.left = p[0] + 'px'; root.style.top = p[1] + 'px';
  };
  const head = root.querySelector('.sv-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = root.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    root.classList.add('drag'); head.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => { if (drag) place([e.clientX - drag.dx, e.clientY - drag.dy]); });
  for (const type of ['pointerup', 'pointercancel']) head.addEventListener(type, () => { drag = null; root.classList.remove('drag'); });
  const api = R.supervisors = {
    send: null, event,
    notify(message, { blocked = () => false, say }) {
      // A sidecar send is only an attempt. Acknowledge after the overlay actually opens the bubble.
      requestAnimationFrame(() => {
        if (blocked()) return;
        const events = message.events ?? [], fresh = events.filter((e) => !notificationsShown.has(e.key));
        if (fresh.length && !say(message.text, message.mood)) return;
        for (const e of events) {
          notificationsShown.add(e.key);
          send({ action: 'notified', id: e.id, key: e.key });
        }
        while (notificationsShown.size > 100) notificationsShown.delete(notificationsShown.values().next().value);
      });
    },
    get isOpen() { return !root.hidden; },
    open() {
      const fresh = root.hidden; root.hidden = false;
      if (fresh) place(R.ink?.spot?.(root.offsetWidth, root.offsetHeight) ?? [24, (R.safe?.top ?? 0) + 64]);
      root.classList.add('on'); send({ action: 'hello' });
    },
    close() { if (root.hidden) return; root.hidden = true; root.classList.remove('on'); drag = null; send({ action: 'close' }); },
  };
  $('close').onclick = () => api.close();
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); } });
  R.supervisorRect = () => { if (root.hidden) return null; const r = root.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  R.supervisorHit = (x, y) => { if (drag) return true; const r = R.supervisorRect(); return !!r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]; };
  addEventListener('resize', () => { if (api.isOpen) place([parseFloat(root.style.left), parseFloat(root.style.top)]); });
  setInterval(() => { if (api.isOpen) send({ action: 'hello' }); }, 15000);
})();
