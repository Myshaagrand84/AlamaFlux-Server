/*
 * Tiny JSON-file datastore for AlamaFlux.
 * No native dependencies — stores everything in data/data.json.
 * Fine for a pilot; migrate to Postgres/SQLite for large-scale production.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

let cache = { users: [] };

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  }
}

function load() {
  ensure();
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || { users: [] };
    if (!Array.isArray(cache.users)) cache.users = [];
  } catch (e) {
    cache = { users: [] };
  }
  return cache;
}

let writeTimer = null;
function persist() {
  // Debounced write to avoid hammering disk on bursts.
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
      console.error('DB write failed:', e.message);
    }
  }, 50);
}

function persistSync() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('DB sync write failed:', e.message);
  }
}

// ---- User helpers ----
function allUsers() {
  return cache.users;
}
function findByEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  return cache.users.find((u) => u.email === e);
}
function findById(id) {
  return cache.users.find((u) => u.id === id);
}
function addUser(user) {
  cache.users.push(user);
  persist();
  return user;
}
function updateUser(id, patch) {
  const u = findById(id);
  if (!u) return null;
  Object.assign(u, patch);
  persist();
  return u;
}
function removeUser(id) {
  const i = cache.users.findIndex((u) => u.id === id);
  if (i < 0) return false;
  cache.users.splice(i, 1);
  persist();
  return true;
}

module.exports = {
  load,
  persist,
  persistSync,
  allUsers,
  findByEmail,
  findById,
  addUser,
  updateUser,
  removeUser,
};
