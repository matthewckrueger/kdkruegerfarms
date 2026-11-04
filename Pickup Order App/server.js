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
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const publicUser = (u, full) => ({
  id: u.id, name: u.name, role: u.role, onDuty: !!u.onDuty, order: u.order,
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
    order: 1, onDuty: false, sessions: [], subscriptions: [] };
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
    users: db.users.map((u) => publicUser(u, isDispatcher)).sort((a, b) => a.order - b.order),
    jobs: jobs.map((j) => ({
      id: j.id, title: j.title, details: j.details, location: j.location, dueBy: j.dueBy,
      priority: j.priority, status: j.status, createdAt: j.createdAt,
      createdBy: names[j.createdBy] || '',
      assignedTo: j.assignedTo, assignedName: names[j.assignedTo] || '',
      offerTo: j.offer?.driverId || null, offerName: names[j.offer?.driverId] || '',
      offerExpiresAt: j.offer?.expiresAt || null,
      history: isDispatcher ? j.history.map((e) => ({ ...e, name: names[e.userId] || '' })) : undefined,
    })),
  };
}));

app.post('/api/me/duty', h((req) => {
  const me = req.user;
  me.onDuty = !!req.body.onDuty;
  store.save();
  for (const job of db.jobs) {
    // Going off duty while holding an offer = pass.
    if (!me.onDuty && job.status === 'offering' && job.offer?.driverId === me.id) {
      dispatch.respond(job, { driverId: me.id, answer: 'decline' });
    }
    // Coming on duty picks up anything nobody else could take.
    if (me.onDuty && me.role === 'driver' && job.status === 'unclaimed' && !job.tried.includes(me.id)) {
      dispatch.wake(job);
    }
  }
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
    phone: String(phone || ''), pin: store.hashPin(pin), order: nextOrder(), onDuty: false,
    sessions: [], subscriptions: [] };
  db.users.push(u);
  store.save();
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
    u.role = role;
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

app.put('/api/settings', dispatcherOnly, h((req) => {
  const s = db.settings;
  for (const k of ['offerMinutes', 'urgentOfferMinutes', 'reminderMinutes']) {
    const v = Number(req.body[k]);
    if (Number.isFinite(v) && v >= 0.5 && v <= 240) s[k] = v;
  }
  store.save();
  return s;
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`Pickup Order App running on http://localhost:${PORT}`));
