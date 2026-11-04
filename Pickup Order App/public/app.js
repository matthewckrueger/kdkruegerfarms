// KDKF Pickups - phone app (plain JavaScript, no build step).
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let token = null;
  try { token = localStorage.getItem('kdk-token'); } catch {}
  let boot = null; // /api/bootstrap
  let state = null; // /api/state
  let tab = 'jobs';
  let seenOffers = new Set();
  let swReg = null;
  let clockSkew = 0;

  // ---------- API ----------
  async function api(path, opts = {}) {
    const r = await fetch('api/' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 401 && token) { setToken(null); render(); }
    if (!r.ok) throw new Error(out.error || 'Something went wrong.');
    return out;
  }
  function setToken(t) {
    token = t;
    try { t ? localStorage.setItem('kdk-token', t) : localStorage.removeItem('kdk-token'); } catch {}
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 3000);
  }
  async function act(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); await refresh(true); await render(); } catch (e) { toast(e.message); }
  }

  // ---------- "Ding ding" sound while the app is open ----------
  let audio = null;
  document.addEventListener('pointerdown', () => {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    if (audio?.state === 'suspended') audio.resume();
  }, { passive: true });
  function ding() {
    if (!audio) return;
    [0, 0.28].forEach((delay) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = delay ? 1320 : 990;
      g.gain.setValueAtTime(0.0001, audio.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.35, audio.currentTime + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + delay + 0.5);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + delay);
      o.stop(audio.currentTime + delay + 0.55);
    });
    navigator.vibrate?.([300, 120, 300]);
  }

  // ---------- Time helpers ----------
  const serverNow = () => Date.now() + clockSkew;
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return 'today ' + time;
    if (d.toDateString() === tomorrow.toDateString()) return 'tomorrow ' + time;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + time;
  }
  function untilText(iso) {
    const ms = Date.parse(iso) - serverNow();
    const late = ms < 0;
    const m = Math.round(Math.abs(ms) / 60000);
    const txt = m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60 ? (m % 60) + ' min' : ''}`.trim();
    return late ? `${txt} late` : `in ${txt}`;
  }
  function countdown(iso) {
    const s = Math.max(0, Math.round((Date.parse(iso) - serverNow()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  setInterval(() => {
    $$('[data-expires]').forEach((el) => { el.textContent = countdown(el.dataset.expires); });
  }, 1000);
  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const STATUS = {
    offering: 'Pinging', broadcast: 'Sent to all', unclaimed: 'Nobody yet',
    accepted: 'Taken', picked_up: 'Picked up', done: 'Done', canceled: 'Canceled',
  };

  // ---------- Push notifications ----------
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      swReg = await navigator.serviceWorker.register('sw.js');
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'push' && e.data.data?.kind === 'offer') ding();
        refresh();
      });
    } catch (e) { console.warn(e); }
  }
  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function subscribe() {
    if (!swReg) await registerSW();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(boot.vapidPublicKey) });
    }
    await api('me/subscribe', { body: { subscription: sub.toJSON() } });
  }
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were blocked. Turn them on in your phone settings.'); return; }
    await subscribe();
    toast('Notifications on!');
    refresh();
  }
  function pushBanner() {
    if (!pushSupported) {
      if (isIOS && !standalone) {
        return `<div class="banner warn"><b>Install this app to get pings.</b><br>
          Tap the <b>Share</b> button <span aria-hidden="true">⬆️</span> at the bottom of Safari, then <b>Add to Home Screen</b>.
          Open it from your home screen and sign in again.</div>`;
      }
      return `<div class="banner warn">This browser can't show notifications. On iPhone use Safari and Add to Home Screen; on Android use Chrome.</div>`;
    }
    if (Notification.permission === 'granted' && state?.me.devices) {
      return `<div class="row small muted" style="margin-bottom:12px"><span class="grow">🔔 Notifications are on for ${state.me.devices} device${state.me.devices > 1 ? 's' : ''}</span>
        <button class="light small" data-act="test-push">Send test</button></div>`;
    }
    if (Notification.permission === 'denied') {
      return `<div class="banner warn"><b>Notifications are blocked.</b> Turn them on for this app in your phone's Settings, then reopen.</div>`;
    }
    return `<div class="banner"><b>Turn on notifications</b> so you get pinged when a job comes in.
      <div style="margin-top:8px"><button data-act="enable-push">🔔 Turn on notifications</button></div></div>`;
  }

  // ---------- Screens ----------
  async function render() {
    const openKeys = new Set($$('details[open]').map((d) => d.dataset.key));
    await renderInner();
    $$('details[data-key]').forEach((d) => { if (openKeys.has(d.dataset.key)) d.open = true; });
  }
  async function renderInner() {
    $('#menuBtn').hidden = !token;
    if (!boot) boot = await api('bootstrap');
    if (boot.needsSetup) return renderSetup();
    if (!token) return renderLogin();
    if (!state) await refresh(true);
    if (!state) return;
    state.me.role === 'dispatcher' ? renderDispatcher() : renderDriver();
  }

  function renderSetup() {
    app.innerHTML = `
      <h2>Welcome! Let's set things up.</h2>
      <p class="muted">You'll be the first dispatcher (the person who sends out jobs). You can add drivers next.</p>
      <form class="card stack" id="setupForm">
        <div><label for="sName">Your name</label><input id="sName" required autocomplete="name"></div>
        <div><label for="sPin">Pick a 4-8 digit PIN</label><input id="sPin" inputmode="numeric" pattern="\\d{4,8}" required type="password"></div>
        <button class="big">Create</button>
      </form>`;
    $('#setupForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { token: t } = await api('setup', { body: { name: $('#sName').value, pin: $('#sPin').value } });
        setToken(t); boot = null; tab = 'team'; render();
      } catch (err) { toast(err.message); }
    };
  }

  function renderLogin() {
    app.innerHTML = `
      <h2>Sign in</h2>
      <form class="card stack" id="loginForm">
        <div><label for="lUser">Who are you?</label>
          <select id="lUser" required><option value="">Choose your name…</option>
          ${boot.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select></div>
        <div><label for="lPin">PIN</label><input id="lPin" inputmode="numeric" type="password" required autocomplete="current-password"></div>
        <button class="big">Sign in</button>
      </form>
      ${isIOS && !standalone ? `<p class="muted small center">Tip: on iPhone, tap Share → <b>Add to Home Screen</b> first so the app can ping you.</p>` : ''}`;
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { token: t } = await api('login', { body: { userId: $('#lUser').value, pin: $('#lPin').value } });
        setToken(t); state = null; tab = 'jobs'; render();
      } catch (err) { toast(err.message); }
    };
  }

  // ---- Driver ----
  function renderDriver() {
    const me = state.me;
    const offers = state.jobs.filter((j) => (j.status === 'offering' && j.offerTo === me.id) || j.status === 'broadcast');
    const mine = state.jobs.filter((j) => j.assignedTo === me.id && ['accepted', 'picked_up'].includes(j.status));
    const done = state.jobs.filter((j) => j.assignedTo === me.id && j.status === 'done').slice(0, 5);
    app.innerHTML = `
      ${pushBanner()}
      <p class="muted small">Hi ${esc(me.name)} — you'll get pinged when a job comes in. Tap <b>Can't</b> any time and it goes to the next person.</p>
      ${offers.length ? `<h2>New job${offers.length > 1 ? 's' : ''} for you</h2>` : ''}
      ${offers.map(offerCard).join('')}
      <h2>My jobs</h2>
      ${mine.length ? mine.map(myJobCard).join('') : `<p class="muted">No jobs right now.</p>`}
      ${done.length ? `<h2>Recently done</h2>${done.map((j) => `<div class="card"><div class="row"><span class="grow">${esc(j.title)}</span><span class="pill done">Done</span></div></div>`).join('')}` : ''}`;
  }
  // Directions: Apple Maps on iPhone, Google Maps elsewhere, plus a link to the other one.
  function directions(name, lat, lng) {
    const pinned = lat != null && lng != null;
    if (!pinned && !name) return '';
    const dest = pinned ? `${lat},${lng}` : name;
    const google = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
    const apple = `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}${pinned && name ? '&q=' + encodeURIComponent(name) : ''}`;
    const [main, other, otherName] = isIOS ? [apple, google, 'Google Maps'] : [google, apple, 'Apple Maps'];
    return `<div class="actions" style="margin-top:6px">
      <a class="btn small" href="${esc(main)}" target="_blank" rel="noopener">🧭 Directions</a>
      <a class="btn light small" href="${esc(other)}" target="_blank" rel="noopener">${otherName}</a></div>`;
  }
  function stop(icon, label, name, lat, lng) {
    const pinned = lat != null && lng != null;
    if (!name && !pinned) return '';
    return `<div class="stop-row"><div class="meta">${icon} ${label}: <b>${esc(name || 'Map pin')}</b>${pinned ? ' <span class="pinned">· pinned</span>' : ''}</div>
      ${directions(name, lat, lng)}</div>`;
  }
  function jobInfo(j) {
    return `
      ${stop('📍', 'Pick up', j.location, j.lat, j.lng)}
      ${stop('🏁', 'Drop off', j.dropoff, j.dropLat, j.dropLng)}
      ${j.dueBy ? `<div class="meta">⏰ Due <b>${esc(when(j.dueBy))}</b> (${esc(untilText(j.dueBy))})</div>` : ''}
      ${j.details ? `<p class="details">${esc(j.details)}</p>` : ''}`;
  }
  function offerCard(j) {
    return `<div class="card offer ${j.priority === 'urgent' ? 'urgent' : ''}">
      <div class="row"><h3 class="grow">${esc(j.title)}</h3>${j.priority === 'urgent' ? '<span class="pill urgent">Urgent</span>' : ''}</div>
      ${jobInfo(j)}
      ${j.status === 'offering' && j.offerExpiresAt
        ? `<div class="meta">Answer in <span class="countdown" data-expires="${esc(j.offerExpiresAt)}">${countdown(j.offerExpiresAt)}</span> or it goes to the next driver.</div>`
        : `<div class="meta">Sent to everyone — first to say yes gets it.</div>`}
      <div class="btns">
        <button class="go big" data-act="accept" data-id="${esc(j.id)}">I'll take it</button>
        <button class="stop big" data-act="decline" data-id="${esc(j.id)}">Can't</button>
      </div></div>`;
  }
  function myJobCard(j) {
    return `<div class="card">
      <div class="row"><h3 class="grow">${esc(j.title)}</h3><span class="pill ${j.status}">${STATUS[j.status]}</span></div>
      ${jobInfo(j)}
      <div class="actions">
        ${j.status === 'accepted' ? `<button data-act="picked_up" data-id="${esc(j.id)}">Picked up</button>` : ''}
        <button class="go" data-act="done" data-id="${esc(j.id)}">Done</button>
        <button class="light" data-act="release" data-id="${esc(j.id)}">Can't do it after all</button>
      </div></div>`;
  }

  // ---- Dispatcher ----
  function renderDispatcher() {
    app.innerHTML = `
      ${pushBanner()}
      <nav class="tabs" role="tablist">
        ${[['jobs', 'Jobs'], ['new', '+ New job'], ['team', 'Team'], ['settings', 'Settings']]
          .map(([k, l]) => `<button role="tab" class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}
      </nav>
      <section id="pane"></section>`;
    $$('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; renderDispatcher(); }; });
    ({ jobs: paneJobs, new: paneNew, team: paneTeam, settings: paneSettings })[tab]();
  }

  function paneJobs() {
    const open = state.jobs.filter((j) => !['done', 'canceled'].includes(j.status));
    const closed = state.jobs.filter((j) => ['done', 'canceled'].includes(j.status));
    const drivers = state.users.filter((u) => u.role === 'driver');
    $('#pane').innerHTML = `
      <div class="row muted small" style="margin-bottom:8px"><span class="grow">${drivers.length} driver${drivers.length === 1 ? '' : 's'} on the team</span>
        <button class="small" data-tab-go="new">+ New job</button></div>
      ${open.length ? open.map(boardCard).join('') : `<div class="card center muted">No open jobs. Tap <b>+ New job</b> to send one out.</div>`}
      ${closed.length ? `<h2>Finished</h2>${closed.map(boardCard).join('')}` : ''}`;
    $$('[data-tab-go]').forEach((b) => { b.onclick = () => { tab = b.dataset.tabGo; renderDispatcher(); }; });
  }
  function boardCard(j) {
    let who = '';
    if (j.status === 'offering') who = `Pinging <b>${esc(j.offerName)}</b> · <span class="countdown" data-expires="${esc(j.offerExpiresAt)}">${countdown(j.offerExpiresAt)}</span> left`;
    else if (j.status === 'broadcast') who = 'Sent to every driver — waiting for someone to say yes';
    else if (j.status === 'unclaimed') who = '<b>Every available driver passed.</b>';
    else if (j.assignedName) who = `<b>${esc(j.assignedName)}</b>`;
    const open = ['offering', 'broadcast', 'unclaimed'].includes(j.status);
    return `<div class="card">
      <div class="row"><h3 class="grow">${esc(j.title)}</h3>
        ${j.priority === 'urgent' ? '<span class="pill urgent">Urgent</span>' : ''}
        <span class="pill ${j.status}">${STATUS[j.status]}</span></div>
      ${who ? `<div class="meta">👤 ${who}</div>` : ''}
      ${jobInfo(j)}
      <div class="actions">
        ${['unclaimed', 'offering'].includes(j.status) ? `<button class="small" data-act="broadcast" data-id="${esc(j.id)}">📣 Send to everyone</button>` : ''}
        ${open ? `<button class="small light" data-act="restart" data-id="${esc(j.id)}">Start over from #1</button>` : ''}
        ${!['done', 'canceled'].includes(j.status) ? `<button class="small light" data-act="cancel" data-id="${esc(j.id)}">Cancel job</button>` : ''}
      </div>
      <details data-key="h-${esc(j.id)}"><summary>History</summary><ul class="hist">
        ${j.history.map((h) => `<li>${esc(new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} — ${esc(h.event)}${h.name ? ' · ' + esc(h.name) : ''}${h.note ? ' · ' + esc(h.note) : ''}</li>`).join('')}
      </ul></details></div>`;
  }

  function paneNew() {
    const now = new Date();
    const at = (h, m = 0, addDays = 0) => { const d = new Date(); d.setDate(d.getDate() + addDays); d.setHours(h, m, 0, 0); return d; };
    const quick = [
      ['In 1 hr', new Date(now.getTime() + 3600e3)],
      ['In 2 hrs', new Date(now.getTime() + 7200e3)],
      ...(now.getHours() < 11 ? [['By noon', at(12)]] : []),
      ...(now.getHours() < 16 ? [['By 5 PM', at(17)]] : []),
      ['Tomorrow 8 AM', at(8, 0, 1)],
      ['No deadline', null],
    ];
    $('#pane').innerHTML = `
      <form class="card stack" id="jobForm">
        <div><label for="jTitle">What needs to be done?</label>
          <input id="jTitle" required maxlength="120" placeholder="e.g. Pick up hydraulic hose at NAPA"></div>
        ${whereField('pu', '📍 Pick up at', 'e.g. NAPA Auto Parts, Main St')}
        ${whereField('do', '🏁 Drop off at', 'e.g. Shop, Grain bins, North pivot')}
        <div><label for="jDue">Needs to be done by</label>
          <input id="jDue" type="datetime-local">
          <div class="chips">${quick.map(([l, d], i) => `<button type="button" class="chip" data-q="${i}">${l}</button>`).join('')}</div></div>
        <div><label for="jDetails">Details <span class="muted">(optional)</span></label>
          <textarea id="jDetails" maxlength="2000" placeholder="Part number, who to ask for, it's paid for, etc."></textarea></div>
        <label class="row" style="font-weight:600"><input type="checkbox" id="jUrgent"> 🔴 Urgent (shorter time to answer: ${state.settings.urgentOfferMinutes} min)</label>
        <button class="big">Send it out 🔔</button>
        <p class="muted small" style="margin:0">Goes to drivers one at a time, in your Team order. Each has ${state.settings.offerMinutes} min to answer.</p>
      </form>`;
    $$('[data-q]').forEach((b) => {
      b.onclick = () => {
        const d = quick[b.dataset.q][1];
        $('#jDue').value = d ? toLocalInput(d) : '';
        $$('[data-q]').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    const pu = pinPicker('pu');
    const dropoff = pinPicker('do');
    // Most jobs come back to the same spot - start with the last drop-off.
    try {
      const last = JSON.parse(localStorage.getItem('kdk-last-drop'));
      if (last?.name) dropoff.fill(last.name, last.lat, last.lng);
    } catch {}
    $('#jobForm').onsubmit = async (e) => {
      e.preventDefault();
      const due = $('#jDue').value;
      const a = pu.get();
      const d = dropoff.get();
      try {
        for (const x of [a, d]) {
          if (!x.save) continue;
          if (!x.name) throw new Error('Type a name for the spot you want to save.');
          await api('places', { body: { name: x.name, lat: x.lat, lng: x.lng } });
        }
        await api('jobs', { body: {
          title: $('#jTitle').value, details: $('#jDetails').value,
          location: a.name, lat: a.lat, lng: a.lng,
          dropoff: d.name, dropLat: d.lat, dropLng: d.lng,
          dueBy: due ? new Date(due).toISOString() : null, priority: $('#jUrgent').checked ? 'urgent' : 'normal',
        } });
        try { localStorage.setItem('kdk-last-drop', JSON.stringify(d)); } catch {}
        toast('Sent! Pinging the first driver.');
        tab = 'jobs';
        await refresh(true);
        render();
      } catch (err) { toast(err.message); }
    };
  }

  // One "where" field: name box, saved-place chips, and a pop-open map to drop a pin.
  function whereField(k, label, placeholder) {
    return `<div><label for="${k}Loc">${label} <span class="muted">(optional)</span></label>
      ${state.places.length ? `<div class="chips" style="margin:0 0 8px">${state.places.map((p) => `<button type="button" class="chip" data-place-${k}="${esc(p.id)}">📍 ${esc(p.name)}</button>`).join('')}</div>` : ''}
      <input id="${k}Loc" maxlength="300" placeholder="${esc(placeholder)}">
      <div class="row" style="margin-top:8px"><span id="${k}Status" class="grow small muted">No map pin yet</span>
        <button type="button" class="small light" id="${k}Clear" hidden>Remove pin</button>
        <button type="button" class="small" id="${k}Toggle">📍 Drop a pin</button></div>
      <div id="${k}Panel" class="stack" style="margin-top:8px" hidden>
        <div class="row"><input id="${k}Search" style="flex:1;min-width:0" placeholder="Search Google: address or business (or paste a Maps link)" enterkeyhint="search">
          <button type="button" class="small" id="${k}SearchBtn">Search</button></div>
        <div id="${k}Results" class="results"></div>
        <div id="${k}Map" class="map"></div>
        <div class="row"><button type="button" class="small light" id="${k}Here">🎯 Use my location</button>
          <button type="button" class="small light" id="${k}Layer">🛰 Satellite</button></div>
        <p class="muted small" style="margin:0">Tap the map to drop the pin. Drag it to fine-tune.</p>
        <label class="row" style="font-weight:500"><input type="checkbox" id="${k}Save"> Save this spot for next time</label>
      </div></div>`;
  }

  // Map pin picker (Leaflet + OpenStreetMap) for one whereField.
  // get() -> { name, lat, lng, save }   fill(name, lat, lng) prefills it.
  function pinPicker(k) {
    const el = (id) => $('#' + k + id);
    let pin = null;
    let map = null;
    let marker = null;
    let satellite = false;
    let street, sat;
    if (!window.L) el('Toggle').hidden = true;

    function show() {
      el('Status').innerHTML = pin
        ? `<span class="pinned">📍 Pinned</span> <span class="muted">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</span>`
        : 'No map pin yet';
      el('Clear').hidden = !pin;
    }
    function setPin(lat, lng, zoom) {
      pin = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
      try { localStorage.setItem('kdk-map-center', JSON.stringify(pin)); } catch {}
      if (map) {
        if (!marker) {
          marker = L.marker([lat, lng], { draggable: true }).addTo(map);
          marker.on('dragend', () => { const p = marker.getLatLng(); setPin(p.lat, p.lng); });
        } else marker.setLatLng([lat, lng]);
        if (zoom) map.setView([lat, lng], zoom);
      }
      show();
    }
    function clearPin() {
      pin = null;
      if (marker) { marker.remove(); marker = null; }
      show();
    }
    function startCenter() {
      try { const c = JSON.parse(localStorage.getItem('kdk-map-center')); if (c?.lat != null) return [[c.lat, c.lng], 13]; } catch {}
      if (state.places[0]) return [[state.places[0].lat, state.places[0].lng], 12];
      return [[39.8, -98.6], 4]; // middle of the US
    }
    function openMap() {
      el('Panel').hidden = false;
      el('Toggle').textContent = 'Hide map';
      if (!map) {
        const [center, zoom] = pin ? [[pin.lat, pin.lng], 16] : startCenter();
        map = L.map(k + 'Map').setView(center, zoom);
        street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
        }).addTo(map);
        sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19, attribution: 'Imagery &copy; Esri',
        });
        map.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng));
        if (pin) setPin(pin.lat, pin.lng);
      }
      setTimeout(() => map.invalidateSize(), 50);
    }
    el('Toggle').onclick = () => {
      if (el('Panel').hidden) openMap();
      else { el('Panel').hidden = true; el('Toggle').textContent = '📍 Drop a pin'; }
    };
    el('Clear').onclick = clearPin;
    el('Layer').onclick = () => {
      satellite = !satellite;
      if (satellite) { map.removeLayer(street); sat.addTo(map); } else { map.removeLayer(sat); street.addTo(map); }
      el('Layer').textContent = satellite ? '🗺 Map' : '🛰 Satellite';
    };
    el('Here').onclick = () => {
      if (!navigator.geolocation) return toast("This phone can't share its location.");
      toast('Finding you…');
      navigator.geolocation.getCurrentPosition(
        (p) => setPin(p.coords.latitude, p.coords.longitude, 17),
        () => toast('Location is off. Allow it in your phone settings.'),
        { enableHighAccuracy: true, timeout: 15000 },
      );
    };
    async function search() {
      const q = el('Search').value.trim();
      if (!q) return;
      // Typed coordinates like "44.31, -96.79"
      const m = q.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
      if (m) { setPin(+m[1], +m[2], 17); return; }
      const box = el('Results');
      box.innerHTML = '<span class="muted small">Searching…</span>';
      try {
        const b = map.getBounds();
        const viewbox = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].map((n) => n.toFixed(4)).join(',');
        const results = (await api(`geocode?q=${encodeURIComponent(q)}&viewbox=${viewbox}`)).filter((r) => r.lat != null);
        if (!results.length) { box.innerHTML = '<span class="muted small">Google found nothing. Try adding the town, or just tap the map to drop the pin.</span>'; return; }
        box.innerHTML = results.map((r, i) => `<button type="button" data-r="${i}">${esc(r.name)}<small>${esc(r.address)}</small></button>`).join('');
        $$('[data-r]', box).forEach((btn) => {
          btn.onclick = () => {
            const r = results[btn.dataset.r];
            setPin(r.lat, r.lng, 17);
            if (!el('Loc').value.trim() && r.name !== 'Pin from link') el('Loc').value = r.name;
            box.innerHTML = '';
          };
        });
      } catch (err) { box.innerHTML = `<span class="muted small">${esc(err.message)}</span>`; }
    }
    el('SearchBtn').onclick = search;
    el('Search').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    const chips = $$(`[data-place-${k}]`);
    chips.forEach((b) => {
      b.onclick = () => {
        const p = state.places.find((x) => x.id === b.getAttribute(`data-place-${k}`));
        el('Loc').value = p.name;
        setPin(p.lat, p.lng, 16);
        el('Save').checked = false;
        chips.forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    return {
      get: () => ({
        name: el('Loc').value.trim(),
        lat: pin?.lat ?? null,
        lng: pin?.lng ?? null,
        save: !!(pin && el('Save').checked),
      }),
      fill(name, lat, lng) {
        el('Loc').value = name || '';
        if (lat != null && lng != null) setPin(lat, lng); else clearPin();
      },
    };
  }

  function paneTeam() {
    const drivers = state.users.filter((u) => u.role === 'driver');
    const dispatchers = state.users.filter((u) => u.role === 'dispatcher');
    const person = (u, i, list) => `<div class="card">
      <div class="person">
        ${u.role === 'driver' ? `<span class="num" title="Ping order">${i + 1}</span>` : ''}
        <div class="grow" style="flex:1;min-width:0"><b>${esc(u.name)}</b>${u.id === state.me.id ? ' (you)' : ''}
          <div class="meta">${u.devices ? '🔔 notifications on' : '🔕 no notifications yet'}${u.phone ? ' · ' + esc(u.phone) : ''}</div></div>
        ${u.role === 'driver' ? `
          <button class="small light" data-move="-1" data-id="${esc(u.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
          <button class="small light" data-move="1" data-id="${esc(u.id)}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>` : ''}
      </div>
      <details data-key="u-${esc(u.id)}"><summary>Edit</summary><div class="stack" style="margin-top:8px">
        <div class="row"><button class="small light" data-act="pin" data-id="${esc(u.id)}">Reset PIN</button>
          <button class="small light" data-act="role" data-id="${esc(u.id)}" data-role="${u.role === 'driver' ? 'dispatcher' : 'driver'}">Make ${u.role === 'driver' ? 'dispatcher' : 'driver'}</button>
          ${u.id !== state.me.id ? `<button class="small stop" data-act="remove" data-id="${esc(u.id)}">Remove</button>` : ''}</div>
      </div></details></div>`;
    $('#pane').innerHTML = `
      <h2 style="margin-top:0">Drivers <span class="muted small">— pinged in this order</span></h2>
      ${drivers.length ? drivers.map(person).join('') : '<p class="muted">No drivers yet. Add your first one below.</p>'}
      <h2>Dispatchers <span class="muted small">— can send out jobs</span></h2>
      ${dispatchers.map(person).join('')}
      <h2>Add a person</h2>
      <form class="card stack" id="addForm">
        <div><label for="aName">Name</label><input id="aName" required></div>
        <div><label for="aPhone">Phone <span class="muted">(optional, for your reference)</span></label><input id="aPhone" type="tel"></div>
        <div><label for="aPin">Their PIN (4-8 digits — tell them this)</label><input id="aPin" inputmode="numeric" required pattern="\\d{4,8}"></div>
        <div><label for="aRole">Role</label><select id="aRole"><option value="driver">Driver (gets pinged)</option><option value="dispatcher">Dispatcher (sends jobs)</option></select></div>
        <button>Add</button>
      </form>
      <p class="muted small">To get someone set up: send them this link — <b>${esc(location.origin + location.pathname)}</b> — have them add it to their home screen, sign in with their name and PIN, and tap “Turn on notifications.”</p>`;
    $$('[data-move]').forEach((b) => {
      b.onclick = () => {
        const ids = drivers.map((u) => u.id);
        const i = ids.indexOf(b.dataset.id);
        const j = i + Number(b.dataset.move);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        act(() => api('users/order', { body: { ids } }));
      };
    });
    $('#addForm').onsubmit = (e) => {
      e.preventDefault();
      act(async () => {
        await api('users', { body: { name: $('#aName').value, phone: $('#aPhone').value, pin: $('#aPin').value, role: $('#aRole').value } });
        boot = null;
      }, 'Added!');
    };
  }

  function paneSettings() {
    const s = state.settings;
    $('#pane').innerHTML = `
      <form class="card stack" id="setForm">
        <div><label for="sOffer">Minutes a driver has to answer a job</label><input id="sOffer" type="number" min="0.5" max="240" step="0.5" value="${s.offerMinutes}"></div>
        <div><label for="sUrgent">…for an urgent job</label><input id="sUrgent" type="number" min="0.5" max="240" step="0.5" value="${s.urgentOfferMinutes}"></div>
        <div><label for="sRepeat">Re-ping the driver every … minutes until they answer <span class="muted">(0 = just once)</span></label><input id="sRepeat" type="number" min="0" max="60" step="0.5" value="${s.repeatPingMinutes ?? 1}"></div>
        <div><label for="sRem">Remind the driver this many minutes before it's due</label><input id="sRem" type="number" min="1" max="240" value="${s.reminderMinutes}"></div>
        <button>Save</button>
      </form>
      <h2>Saved places</h2>
      ${state.places.length
        ? state.places.map((p) => `<div class="card row"><span class="grow">📍 <b>${esc(p.name)}</b>
            <span class="muted small">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</span></span>
            <a class="btn light small" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener">View</a>
            <button class="small stop" data-act="del-place" data-id="${esc(p.id)}">Delete</button></div>`).join('')
        : '<p class="muted">None yet. When you drop a pin on a new job, tick "Save this spot" to add it here. Saved places show up as one-tap buttons for pickup and drop-off.</p>'}`;
    $('#setForm').onsubmit = (e) => {
      e.preventDefault();
      act(() => api('settings', { method: 'PUT', body: { offerMinutes: $('#sOffer').value, urgentOfferMinutes: $('#sUrgent').value, reminderMinutes: $('#sRem').value, repeatPingMinutes: $('#sRepeat').value } }), 'Saved');
    };
  }

  // ---------- Button clicks ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'enable-push': enablePush().catch((err) => toast(err.message)); break;
      case 'test-push': act(() => api('me/test-push', { body: {} }), 'Sent — check your notifications'); break;
      case 'accept': act(() => api(`jobs/${id}/respond`, { body: { answer: 'accept' } }), "It's yours! 👍"); break;
      case 'decline': act(() => api(`jobs/${id}/respond`, { body: { answer: 'decline' } }), 'No problem — passing it on.'); break;
      case 'picked_up': act(() => api(`jobs/${id}/progress`, { body: { status: 'picked_up' } }), 'Marked picked up'); break;
      case 'done': act(() => api(`jobs/${id}/progress`, { body: { status: 'done' } }), 'Nice work! ✅'); break;
      case 'release':
        if (confirm('Give this job back? It will go to the next driver.')) act(() => api(`jobs/${id}/release`, { body: {} }), 'Passed on.');
        break;
      case 'broadcast': act(() => api(`jobs/${id}/broadcast`, { body: {} }), 'Sent to every driver'); break;
      case 'restart': act(() => api(`jobs/${id}/restart`, { body: {} }), 'Starting over from the top'); break;
      case 'cancel': if (confirm('Cancel this job?')) act(() => api(`jobs/${id}/cancel`, { body: {} }), 'Canceled'); break;
      case 'pin': {
        const pin = prompt('New 4-8 digit PIN:');
        if (pin) act(() => api(`users/${id}`, { method: 'PATCH', body: { pin } }), 'PIN changed');
        break;
      }
      case 'del-place': if (confirm('Delete this saved place?')) act(() => api(`places/${id}`, { method: 'DELETE' }), 'Deleted'); break;
      case 'role': act(() => api(`users/${id}`, { method: 'PATCH', body: { role: b.dataset.role } }), 'Updated'); break;
      case 'remove': if (confirm('Remove this person?')) act(async () => { await api(`users/${id}`, { method: 'DELETE' }); boot = null; }, 'Removed'); break;
    }
  });
  $('#menuBtn').onclick = async () => {
    try { await api('logout', { body: {} }); } catch {}
    setToken(null); state = null; boot = null; render();
  };

  // ---------- Refresh loop ----------
  function isTyping() {
    const a = document.activeElement;
    return a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
  }
  async function refresh(force) {
    if (!token) return;
    try {
      state = await api('state');
      clockSkew = Date.parse(state.serverTime) - Date.now();
    } catch { return; }
    // Ding when a new offer shows up while the app is open.
    const offers = state.jobs.filter((j) => (j.status === 'offering' && j.offerTo === state.me.id) || (j.status === 'broadcast' && state.me.role === 'driver'));
    const fresh = offers.filter((j) => !seenOffers.has(j.id + j.offerExpiresAt));
    if (fresh.length && !force) ding();
    offers.forEach((j) => seenOffers.add(j.id + j.offerExpiresAt));
    // Don't wipe out a half-typed form.
    if (!force && state.me.role === 'dispatcher' && tab !== 'jobs' && isTyping()) return;
    if (!force && state.me.role === 'dispatcher' && tab !== 'jobs') return;
    if (!force) render();
  }
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

  // ---------- Start ----------
  (async () => {
    await registerSW();
    try {
      await render();
      // Make sure the server still has this phone's notification address.
      if (token && pushSupported && Notification.permission === 'granted') subscribe().catch(() => {});
    } catch (e) {
      app.innerHTML = `<div class="card">Can't reach the server. Check your signal and try again.<br><br><button onclick="location.reload()">Retry</button></div>`;
    }
  })();
})();
