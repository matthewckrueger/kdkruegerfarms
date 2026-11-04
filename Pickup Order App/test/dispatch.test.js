// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-test-'));
const store = require('../lib/store');
const dispatch = require('../lib/dispatch');

let clock = Date.parse('2026-01-05T15:00:00Z');
let sent = [];
dispatch.configure({ notify: (ids, p) => sent.push({ ids, ...p }), now: () => clock });

function setup() {
  store.reset();
  const db = store.load();
  sent = [];
  const mk = (id, role, order) =>
    db.users.push({ id, name: id, role, order, pin: store.hashPin('1234'), sessions: [], subscriptions: [] });
  mk('boss', 'dispatcher', 0);
  mk('amy', 'driver', 1);
  mk('bob', 'driver', 2);
  mk('cal', 'driver', 3);
  return db;
}

test('offers to the first available driver, then rolls on decline', () => {
  setup();
  const job = dispatch.createJob({ title: 'Grab hose' }, 'boss');
  assert.equal(job.status, 'offering');
  assert.equal(job.offer.driverId, 'amy');
  assert.deepEqual(sent.at(-1).ids, ['amy']);

  dispatch.respond(job, { driverId: 'amy', answer: 'decline' });
  assert.equal(job.offer.driverId, 'bob');

  dispatch.respond(job, { driverId: 'bob', answer: 'decline' });
  assert.equal(job.offer.driverId, 'cal');

  dispatch.respond(job, { driverId: 'cal', answer: 'decline' });
  assert.equal(job.status, 'unclaimed');
  assert.deepEqual(sent.at(-1).ids, ['boss']);
});

test('no answer in time passes it on', () => {
  setup();
  const job = dispatch.createJob({ title: 'Seed pickup' }, 'boss');
  clock += 3 * 60000 + 1;
  dispatch.tick();
  assert.equal(job.offer.driverId, 'bob');
});

test('accepting from the notification button token works once', () => {
  setup();
  const job = dispatch.createJob({ title: 'Filters' }, 'boss');
  const t = job.offer.token;
  dispatch.respond(job, { offerToken: t, answer: 'accept' });
  assert.equal(job.status, 'accepted');
  assert.equal(job.assignedTo, 'amy');
  assert.throws(() => dispatch.respond(job, { driverId: 'bob', answer: 'accept' }), /already took/);
});

test('broadcast: first yes wins, others are told', () => {
  setup();
  const job = dispatch.createJob({ title: 'Tires' }, 'boss');
  dispatch.broadcast(job, 'boss');
  assert.equal(job.status, 'broadcast');
  assert.equal(Object.keys(job.broadcastTokens).length, 3);
  dispatch.respond(job, { offerToken: job.broadcastTokens.cal, answer: 'accept' });
  assert.equal(job.assignedTo, 'cal');
  assert.equal(sent.at(-1).kind, 'taken');
});

test('giving a job back sends it to the next driver', () => {
  setup();
  const job = dispatch.createJob({ title: 'Bolts' }, 'boss');
  dispatch.respond(job, { driverId: 'amy', answer: 'accept' });
  dispatch.release(job, 'amy');
  assert.equal(job.offer.driverId, 'bob');
});

test('due-time reminder and overdue alert', () => {
  setup();
  const job = dispatch.createJob({ title: 'Parts', dueBy: clock + 60 * 60000 }, 'boss');
  dispatch.respond(job, { driverId: 'amy', answer: 'accept' });
  clock += 31 * 60000;
  dispatch.tick();
  assert.ok(sent.some((s) => s.kind === 'reminder' && s.ids[0] === 'amy'));
  clock += 30 * 60000;
  dispatch.tick();
  assert.ok(sent.some((s) => s.kind === 'overdue'));
  dispatch.setProgress(job, 'amy', 'done');
  assert.equal(job.status, 'done');
});

test('map pins are kept on the job, bad ones dropped', () => {
  setup();
  const job = dispatch.createJob({ title: 'Seed', location: 'Co-op', lat: '44.3123456', lng: -96.7987654 }, 'boss');
  assert.equal(job.lat, 44.312346);
  assert.equal(job.lng, -96.798765);
  const bad = dispatch.createJob({ title: 'X', lat: 200, lng: 5 }, 'boss');
  assert.equal(bad.lat, null);
  const two = dispatch.createJob({ title: 'Z', location: 'NAPA', lat: 44, lng: -96, dropoff: 'Shop', dropLat: 44.5, dropLng: -96.5 }, 'boss');
  assert.equal(two.dropoff, 'Shop');
  assert.equal(two.dropLat, 44.5);
  assert.match(sent.find((x) => x.kind === 'offer' && x.jobId === two.id).body, /NAPA → Shop/);
  const none = dispatch.createJob({ title: 'Y', lat: null, lng: null }, 'boss');
  assert.equal(none.lat, null);
});

test('re-pings the driver every minute until they answer', () => {
  setup();
  const job = dispatch.createJob({ title: 'Filters' }, 'boss');
  const pings = () => sent.filter((x) => x.kind === 'offer' && x.ids[0] === 'amy').length;
  assert.equal(pings(), 1);
  clock += 30000; dispatch.tick();
  assert.equal(pings(), 1); // not yet
  clock += 31000; dispatch.tick();
  assert.equal(pings(), 2);
  assert.match(sent.at(-1).title, /^Still waiting/);
  clock += 60000; dispatch.tick();
  assert.equal(pings(), 3);
  clock += 60000; dispatch.tick(); // 3 min up: moves to bob
  assert.equal(job.offer.driverId, 'bob');
  assert.equal(pings(), 3);
});

test('urgent 1-minute window still gets a second ping', () => {
  setup();
  dispatch.createJob({ title: 'Now', priority: 'urgent' }, 'boss');
  clock += 31000; dispatch.tick();
  assert.equal(sent.filter((x) => x.kind === 'offer').length, 2);
});
