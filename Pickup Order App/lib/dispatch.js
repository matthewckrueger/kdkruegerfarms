// The "Uber-style" part: offer a job to one driver at a time, in priority
// order. If they say no (or don't answer in time) it rolls to the next one.
// Every driver on the Team list is always in the rotation.
// If nobody takes it, the dispatchers are told and can blast it to everyone.
const store = require('./store');

let notify = () => {}; // set by server.js: notify(userIds, payload)
let now = () => Date.now(); // swappable for tests

function configure(opts) {
  if (opts.notify) notify = opts.notify;
  if (opts.now) now = opts.now;
}

const db = () => store.load();
const user = (uid) => db().users.find((u) => u.id === uid);
const dispatcherIds = () => db().users.filter((u) => u.role === 'dispatcher').map((u) => u.id);
const drivers = () => db().users.filter((u) => u.role === 'driver').sort((a, b) => a.order - b.order);
const iso = (t) => new Date(t).toISOString();

function log(job, event, userId = null, note = '') {
  job.history.push({ at: iso(now()), event, userId, note });
}

function dueText(job) {
  if (!job.dueBy) return '';
  const d = new Date(job.dueBy);
  return ' · Due ' + d.toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: process.env.TZ || 'America/Chicago',
  });
}

function createJob({ title, details, location, dueBy, priority }, createdBy) {
  const job = {
    id: store.id(),
    title: String(title || '').trim().slice(0, 120),
    details: String(details || '').trim().slice(0, 2000),
    location: String(location || '').trim().slice(0, 300),
    dueBy: dueBy ? iso(dueBy) : null,
    priority: priority === 'urgent' ? 'urgent' : 'normal',
    status: 'offering',
    createdBy,
    createdAt: iso(now()),
    assignedTo: null,
    offer: null, // { driverId, token, expiresAt }
    broadcastTokens: {}, // driverId -> token, while broadcasting
    tried: [], // drivers who passed / timed out
    reminded: false,
    overdueNotified: false,
    history: [],
  };
  if (!job.title) throw new Error('What needs to be done?');
  db().jobs.unshift(job);
  log(job, 'created', createdBy);
  offerNext(job);
  store.save();
  return job;
}

function offerNext(job) {
  const next = drivers().find((d) => !job.tried.includes(d.id));
  if (!next) {
    job.status = 'unclaimed';
    job.offer = null;
    log(job, 'unclaimed', null, 'Every driver passed');
    notify(dispatcherIds(), {
      kind: 'unclaimed',
      title: 'Nobody took the job',
      body: `"${job.title}" - open the app to send it to everyone.`,
      jobId: job.id,
      tag: 'job-' + job.id,
    });
    return;
  }
  const s = db().settings;
  const minutes = job.priority === 'urgent' ? s.urgentOfferMinutes : s.offerMinutes;
  job.status = 'offering';
  job.offer = { driverId: next.id, token: store.token(), expiresAt: iso(now() + minutes * 60000) };
  log(job, 'offered', next.id);
  notify([next.id], {
    kind: 'offer',
    title: (job.priority === 'urgent' ? 'URGENT job: ' : 'New job: ') + job.title,
    body: [job.location, job.details].filter(Boolean).join(' - ').slice(0, 140) + dueText(job) +
      ` · Answer within ${minutes} min`,
    jobId: job.id,
    offerToken: job.offer.token,
    urgent: job.priority === 'urgent',
    tag: 'job-' + job.id,
  });
}

// Driver accepts or declines. Either their session (driverId) or the
// one-time token from the notification button identifies them.
function respond(job, { driverId, offerToken, answer }) {
  if (!driverId && offerToken) {
    if (job.offer && job.offer.token === offerToken) driverId = job.offer.driverId;
    else driverId = Object.keys(job.broadcastTokens).find((d) => job.broadcastTokens[d] === offerToken);
  }
  if (!driverId) throw new Error('This job offer has expired.');
  const isCurrent = job.status === 'offering' && job.offer && job.offer.driverId === driverId;
  const isBroadcast = job.status === 'broadcast';
  if (!isCurrent && !isBroadcast) {
    if (job.assignedTo === driverId) return job; // double tap
    throw new Error(job.assignedTo ? 'Someone else already took this job.' : 'This job offer has expired.');
  }

  if (answer === 'accept') {
    job.status = 'accepted';
    job.assignedTo = driverId;
    job.offer = null;
    const others = Object.keys(job.broadcastTokens).filter((d) => d !== driverId);
    job.broadcastTokens = {};
    log(job, 'accepted', driverId);
    const name = user(driverId)?.name || 'A driver';
    notify(dispatcherIds(), {
      kind: 'accepted', title: `${name} took it`, body: job.title, jobId: job.id, tag: 'job-' + job.id,
    });
    if (others.length) {
      notify(others, {
        kind: 'taken', title: 'Job taken', body: `${name} has "${job.title}". Thanks!`,
        jobId: job.id, tag: 'job-' + job.id, silent: true,
      });
    }
  } else {
    log(job, 'declined', driverId);
    if (isCurrent) {
      job.tried.push(driverId);
      offerNext(job);
    } else {
      delete job.broadcastTokens[driverId];
    }
  }
  store.save();
  return job;
}

// Send to every driver at once. First "yes" wins.
function broadcast(job, byUserId) {
  if (!['unclaimed', 'offering'].includes(job.status)) throw new Error('Job is not open.');
  job.status = 'broadcast';
  job.offer = null;
  job.broadcastTokens = {};
  for (const d of drivers()) job.broadcastTokens[d.id] = store.token();
  log(job, 'broadcast', byUserId);
  for (const d of drivers()) {
    notify([d.id], {
      kind: 'offer',
      title: 'Anyone? ' + job.title,
      body: [job.location, job.details].filter(Boolean).join(' - ').slice(0, 140) + dueText(job),
      jobId: job.id,
      offerToken: job.broadcastTokens[d.id],
      urgent: true,
      tag: 'job-' + job.id,
    });
  }
  store.save();
  return job;
}

// Start the line over from the top driver.
function restart(job, byUserId) {
  if (!['unclaimed', 'broadcast', 'offering'].includes(job.status)) throw new Error('Job is not open.');
  job.tried = [];
  job.broadcastTokens = {};
  log(job, 'restarted', byUserId);
  offerNext(job);
  store.save();
  return job;
}

// A new driver joined the team: give them a shot at anything nobody took.
function wake(job) {
  if (job.status !== 'unclaimed') return job;
  offerNext(job);
  store.save();
  return job;
}

// Driver can't finish it after all - put it back out, skipping them.
function release(job, driverId) {
  if (job.assignedTo !== driverId || !['accepted', 'picked_up'].includes(job.status)) {
    throw new Error('This is not your job.');
  }
  job.assignedTo = null;
  job.tried.push(driverId);
  log(job, 'released', driverId);
  notify(dispatcherIds(), {
    kind: 'released', title: `${user(driverId)?.name || 'Driver'} gave a job back`, body: job.title,
    jobId: job.id, tag: 'job-' + job.id,
  });
  offerNext(job);
  store.save();
  return job;
}

function setProgress(job, driverId, status) {
  if (job.assignedTo !== driverId) throw new Error('This is not your job.');
  if (!['picked_up', 'done'].includes(status)) throw new Error('Bad status');
  job.status = status;
  log(job, status, driverId);
  notify(dispatcherIds(), {
    kind: status,
    title: `${user(driverId)?.name || 'Driver'}: ${status === 'done' ? 'Done' : 'Picked up'}`,
    body: job.title, jobId: job.id, tag: 'job-' + job.id,
  });
  store.save();
  return job;
}

function cancel(job, byUserId) {
  if (['done', 'canceled'].includes(job.status)) return job;
  const toTell = [job.assignedTo, job.offer?.driverId, ...Object.keys(job.broadcastTokens)].filter(Boolean);
  job.status = 'canceled';
  job.offer = null;
  job.broadcastTokens = {};
  log(job, 'canceled', byUserId);
  if (toTell.length) {
    notify([...new Set(toTell)], {
      kind: 'canceled', title: 'Job canceled', body: job.title, jobId: job.id, tag: 'job-' + job.id,
    });
  }
  store.save();
  return job;
}

// Runs every few seconds: time out unanswered offers, send due-time alerts.
function tick() {
  const t = now();
  const s = db().settings;
  let changed = false;
  for (const job of db().jobs) {
    if (job.status === 'offering' && job.offer && Date.parse(job.offer.expiresAt) <= t) {
      log(job, 'no answer', job.offer.driverId);
      notify([job.offer.driverId], {
        kind: 'missed', title: 'Job passed to the next driver', body: job.title,
        jobId: job.id, tag: 'job-' + job.id, silent: true,
      });
      job.tried.push(job.offer.driverId);
      offerNext(job);
      changed = true;
    }
    if (!job.dueBy) continue;
    const due = Date.parse(job.dueBy);
    if (['accepted', 'picked_up'].includes(job.status) && !job.reminded && due - t <= s.reminderMinutes * 60000) {
      job.reminded = true;
      notify([job.assignedTo], {
        kind: 'reminder', title: 'Reminder: due soon', body: job.title + dueText(job), jobId: job.id, tag: 'job-' + job.id,
      });
      changed = true;
    }
    if (!['done', 'canceled'].includes(job.status) && !job.overdueNotified && due <= t) {
      job.overdueNotified = true;
      notify([...dispatcherIds(), job.assignedTo].filter(Boolean), {
        kind: 'overdue', title: 'Overdue', body: job.title, jobId: job.id, tag: 'job-' + job.id, urgent: true,
      });
      changed = true;
    }
  }
  if (changed) store.save();
}

module.exports = { configure, createJob, respond, broadcast, restart, wake, release, setProgress, cancel, tick };
