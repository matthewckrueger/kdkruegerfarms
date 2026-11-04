// KD Krueger Farms - Pickup Order App server.
// Serves the phone app (public/) and the API, and sends push notifications.
const path = require('path');
const express = require('express');
const webpush = require('web-push');
const store = require('./lib/store');
const dispatch = require('./lib/dispatch');

const PORT = process.env.PORT || 3000;
const db = store.load();

// ---- Push notifications -------------------------------------------------
if (!db.vapid) {
  db.vapid = webpush.generateVAPIDKeys();
  store.save();
}
webpush.setVapidDetails(
  'mailto:' + (process.env.CONTACT_EMAIL || 'admin@example.com'),
  db.vapid.publicKey,
  db.vapid.privateKey,
);

async function sendPush(userIds, payload) {
  for (const uid of userIds) {
    const u = db.users.find((x) => x.id === uid);
    if (!u) continue;
    for (const sub of [...(u.subscriptions || [])]) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), {
          TTL: 600,
          urgency: payload.urgent || payload.kind === 'offer' ? 'high' : 'normal',
        });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          u.subscriptions = u.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
          store.save();
        } else {
          console.error('push failed for', u.name, err.statusCode || err.message);
        }
      }
    }
  }
}
dispatch.configure({ notify: (ids, payload) => { sendPush(ids, payload); } });
setInterval(() => {
  try { dispatch.tick(); } catch (e) { console.error(e); }
}, 5000);

// ---- Helpers ------------------------------------------------------------
const app = express();
// Behind Railway's (or any) proxy: use the real visitor IP for the login throttle.
app.set('trust proxy', 1);
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
// Map library, served from our own server instead of a CDN.
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));

const publicUser = (u, full) => ({
  id: u.id, name: u.name, role: u.role, order: u.order,
  ...(full ? { phone: u.phone || '', devices: (u.subscriptions || []).length } : {}),
});

function auth(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer /, '');
  const u = t && db.users.find((x) => (x.sessions || []).includes(t));
  if (!u) return res.status(401).json({ error: 'Please sign in again.' });
  req.user = u;
  req.sessionToken = t;
  next();
}
const dispatcherOnly = (req, res, next) =>
  req.user.role === 'dispatcher' ? next() : res.status(403).json({ error: 'Dispatchers only.' });

function findJob(req) {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) throw Object.assign(new Error('Job not found.'), { status: 404 });
  return job;
}

// Wrap handlers so thrown errors become friendly JSON messages.
const h = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};

function nextOrder() {
  return db.users.reduce((m, u) => Math.max(m, u.order || 0), 0) + 1;
}

// Simple login throttle: 10 bad PINs per 15 minutes per IP.
const failures = new Map();
function throttled(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60000) return false;
  return f.count >= 10;
}
function fail(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 15 * 60000) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

// ---- Public endpoints ---------------------------------------------------
app.get('/api/bootstrap', h(() => ({
  needsSetup: db.users.length === 0,
  vapidPublicKey: db.vapid.publicKey,
  users: db.users.map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name)),
})));

app.post('/api/setup', h((req) => {
  if (db.users.length) throw new Error('Already set up.');
  const { name, pin } = req.body;
  if (!name || !/^\d{4,8}$/.test(String(pin))) throw new Error('Enter a name and a 4-8 digit PIN.');
  const u = { id: store.id(), name: String(name).trim(), role: 'dispatcher', pin: store.hashPin(pin),
    order: 1, sessions: [], subscriptions: [] };
  const token = store.token();
  u.sessions.push(token);
  db.users.push(u);
  store.save();
  return { token };
}));

app.post('/api/login', h((req) => {
  if (throttled(req.ip)) throw new Error('Too many tries. Wait 15 minutes.');
  const u = db.users.find((x) => x.id === req.body.userId);
  if (!u || !store.checkPin(req.body.pin, u.pin)) {
    fail(req.ip);
    throw new Error('Wrong PIN.');
  }
  const token = store.token();
  u.sessions = [...(u.sessions || []).slice(-9), token];
  store.save();
  return { token };
}));

// Accept/decline straight from the notification buttons (no session needed;
// the one-time offer token proves who it was sent to).
app.post('/api/jobs/:id/respond-token', h((req) => {
  const job = findJob(req);
  dispatch.respond(job, { offerToken: req.body.offerToken, answer: req.body.answer });
}));

// ---- Signed-in endpoints ------------------------------------------------
app.use('/api', auth);

app.post('/api/logout', h((req) => {
  req.user.sessions = req.user.sessions.filter((s) => s !== req.sessionToken);
  store.save();
}));

app.get('/api/state', h((req) => {
  const me = req.user;
  const isDispatcher = me.role === 'dispatcher';
  const active = (j) => !['done', 'canceled'].includes(j.status);
  let jobs;
  if (isDispatcher) {
    const finished = db.jobs.filter((j) => !active(j)).slice(0, 30);
    jobs = [...db.jobs.filter(active), ...finished];
  } else {
    jobs = db.jobs.filter((j) =>
      (j.status === 'offering' && j.offer?.driverId === me.id) ||
      (j.status === 'broadcast' && j.broadcastTokens[me.id]) ||
      j.assignedTo === me.id,
    ).slice(0, 40);
  }
  const names = Object.fromEntries(db.users.map((u) => [u.id, u.name]));
  return {
    me: publicUser(me, true),
    serverTime: new Date().toISOString(),
    settings: db.settings,
    places: isDispatcher ? db.places : [],
    users: db.users.map((u) => publicUser(u, isDispatcher)).sort((a, b) => a.order - b.order),
    jobs: jobs.map((j) => ({
      id: j.id, title: j.title, details: j.details, location: j.location, lat: j.lat ?? null, lng: j.lng ?? null,
      dropoff: j.dropoff || '', dropLat: j.dropLat ?? null, dropLng: j.dropLng ?? null, dueBy: j.dueBy,
      priority: j.priority, status: j.status, createdAt: j.createdAt,
      createdBy: names[j.createdBy] || '',
      assignedTo: j.assignedTo, assignedName: names[j.assignedTo] || '',
      offerTo: j.offer?.driverId || null, offerName: names[j.offer?.driverId] || '',
      offerExpiresAt: j.offer?.expiresAt || null,
      history: isDispatcher ? j.history.map((e) => ({ ...e, name: names[e.userId] || '' })) : undefined,
    })),
  };
}));

app.post('/api/me/subscribe', h((req) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) throw new Error('Bad subscription.');
  // A phone belongs to one person at a time.
  for (const u of db.users) u.subscriptions = (u.subscriptions || []).filter((s) => s.endpoint !== sub.endpoint);
  req.user.subscriptions.push(sub);
  store.save();
}));

app.post('/api/me/test-push', h((req) => {
  if (!req.user.subscriptions?.length) throw new Error('Notifications are not turned on for this phone yet.');
  sendPush([req.user.id], { kind: 'test', title: 'Ding ding!', body: 'Notifications are working.', tag: 'test' });
}));

app.post('/api/jobs/:id/respond', h((req) => {
  dispatch.respond(findJob(req), { driverId: req.user.id, answer: req.body.answer });
}));
app.post('/api/jobs/:id/progress', h((req) => {
  dispatch.setProgress(findJob(req), req.user.id, req.body.status);
}));
app.post('/api/jobs/:id/release', h((req) => {
  dispatch.release(findJob(req), req.user.id);
}));

// ---- Dispatcher endpoints -----------------------------------------------
app.post('/api/jobs', dispatcherOnly, h((req) => ({ id: dispatch.createJob(req.body, req.user.id).id })));
app.post('/api/jobs/:id/broadcast', dispatcherOnly, h((req) => { dispatch.broadcast(findJob(req), req.user.id); }));
app.post('/api/jobs/:id/restart', dispatcherOnly, h((req) => { dispatch.restart(findJob(req), req.user.id); }));
app.post('/api/jobs/:id/cancel', dispatcherOnly, h((req) => { dispatch.cancel(findJob(req), req.user.id); }));

app.post('/api/users', dispatcherOnly, h((req) => {
  const { name, pin, role, phone } = req.body;
  if (!String(name || '').trim()) throw new Error('Name is required.');
  if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4-8 digits.');
  const u = { id: store.id(), name: String(name).trim(), role: role === 'dispatcher' ? 'dispatcher' : 'driver',
    phone: String(phone || ''), pin: store.hashPin(pin), order: nextOrder(),
    sessions: [], subscriptions: [] };
  db.users.push(u);
  store.save();
  // A new driver gets a shot at anything nobody else took.
  if (u.role === 'driver') db.jobs.filter((j) => j.status === 'unclaimed').forEach((j) => dispatch.wake(j));
  return { id: u.id };
}));

app.patch('/api/users/:id', dispatcherOnly, h((req) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) throw new Error('User not found.');
  const { name, pin, role, phone } = req.body;
  if (name !== undefined) u.name = String(name).trim() || u.name;
  if (phone !== undefined) u.phone = String(phone);
  if (role && ['driver', 'dispatcher'].includes(role)) {
    if (u.role === 'dispatcher' && role !== 'dispatcher' && db.users.filter((x) => x.role === 'dispatcher').length < 2) {
      throw new Error('You need at least one dispatcher.');
    }
    const becameDriver = u.role !== 'driver' && role === 'driver';
    u.role = role;
    if (becameDriver) db.jobs.filter((j) => j.status === 'unclaimed').forEach((j) => dispatch.wake(j));
  }
  if (pin) {
    if (!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must be 4-8 digits.');
    u.pin = store.hashPin(pin);
    u.sessions = [];
  }
  store.save();
}));

app.delete('/api/users/:id', dispatcherOnly, h((req) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) throw new Error('User not found.');
  if (u.id === req.user.id) throw new Error("You can't remove yourself.");
  for (const job of db.jobs) {
    if (job.status === 'offering' && job.offer?.driverId === u.id) dispatch.respond(job, { driverId: u.id, answer: 'decline' });
    if (job.assignedTo === u.id && ['accepted', 'picked_up'].includes(job.status)) dispatch.release(job, u.id);
  }
  db.users = db.users.filter((x) => x.id !== u.id);
  store.save();
}));

// Set the "who gets pinged first" order. Body: { ids: [firstId, secondId, ...] }
app.post('/api/users/order', dispatcherOnly, h((req) => {
  (req.body.ids || []).forEach((uid, i) => {
    const u = db.users.find((x) => x.id === uid);
    if (u) u.order = i + 1;
  });
  store.save();
}));

// ---- Map pins ------------------------------------------------------------
app.post('/api/places', dispatcherOnly, h((req) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const pin = dispatch.cleanPin(req.body.lat, req.body.lng);
  if (!name) throw new Error('Give the place a name.');
  if (pin.lat == null) throw new Error('Drop a pin on the map first.');
  db.places = db.places.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  db.places.push({ id: store.id(), name, ...pin });
  db.places.sort((a, b) => a.name.localeCompare(b.name));
  store.save();
}));
app.delete('/api/places/:id', dispatcherOnly, h((req) => {
  db.places = db.places.filter((p) => p.id !== req.params.id);
  store.save();
}));

const { coordsFromUrl, SHORT_LINK } = require('./lib/maps');
const geocode = require('./lib/geocode');

// Address search, or a pasted Google/Apple Maps link.
app.get('/api/geocode', dispatcherOnly, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 500);
    if (!q) return res.json([]);
    if (SHORT_LINK.test(q)) {
      let url = q;
      let pin = coordsFromUrl(url);
      // Short share links redirect to the full URL; follow a few hops (Google/Apple hosts only).
      for (let i = 0; !pin && i < 4; i++) {
        const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 KDKF-Pickups' } });
        const next = r.headers.get('location');
        if (!next) break;
        url = new URL(next, url).toString();
        if (!/^https:\/\/([a-z0-9-]+\.)*(google\.com|goo\.gl|apple\.com)\//i.test(url)) break;
        pin = coordsFromUrl(url);
      }
      if (!pin || pin.lat == null) throw new Error("Couldn't read a location from that link. Try searching the address instead.");
      return res.json([{ name: 'Pin from link', address: `${pin.lat}, ${pin.lng}`, ...pin }]);
    }
    // Center of the map the dispatcher is looking at, so nearby results come first.
    let center = null;
    const vb = String(req.query.viewbox || '').split(',').map(Number);
    if (vb.length === 4 && vb.every(Number.isFinite)) center = { lat: (vb[1] + vb[3]) / 2, lng: (vb[0] + vb[2]) / 2 };
    res.json(await geocode.search(q, center));
  } catch (e) {
    res.status(400).json({ error: e.message || 'Search failed.' });
  }
});

app.put('/api/settings', dispatcherOnly, h((req) => {
  const s = db.settings;
  for (const k of ['offerMinutes', 'urgentOfferMinutes', 'reminderMinutes', 'repeatPingMinutes']) {
    const v = Number(req.body[k]);
    if (k === 'repeatPingMinutes' && v === 0) s[k] = 0; // 0 = only ping once
    else if (Number.isFinite(v) && v >= 0.5 && v <= 240) s[k] = v;
  }
  store.save();
  return s;
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Pickup Order App running on port ${PORT}, saving data in ${store.DATA_DIR}`);
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
    console.warn('WARNING: no Railway volume attached - jobs and users will be wiped on every deploy!');
  }
});
