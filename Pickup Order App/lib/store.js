// Tiny JSON-file database. Fine for a handful of users and a few jobs a day.
// Everything lives in data/db.json so it survives restarts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On Railway, a mounted volume sets RAILWAY_VOLUME_MOUNT_PATH automatically.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULTS = {
  users: [],
  jobs: [],
  places: [], // saved map pins: { id, name, lat, lng }
  settings: {
    offerMinutes: 3, // how long a driver has to answer a normal job
    urgentOfferMinutes: 1, // ...and an urgent one
    reminderMinutes: 30, // remind the driver this long before "due by"
    repeatPingMinutes: 1, // re-ping the driver this often until they answer (0 = once)
  },
  vapid: null,
};

let db = null;

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = { ...structuredClone(DEFAULTS), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    db.settings = { ...DEFAULTS.settings, ...db.settings };
  } else {
    db = structuredClone(DEFAULTS);
  }
  return db;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function reset() {
  db = structuredClone(DEFAULTS);
}

const id = () => crypto.randomBytes(8).toString('hex');
const token = () => crypto.randomBytes(24).toString('base64url');

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

module.exports = { load, save, reset, id, token, hashPin, checkPin, DATA_DIR };
