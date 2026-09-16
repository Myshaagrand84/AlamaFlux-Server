/*
* AlamaFlux PostgreSQL-backed datastore.
* -----------------------------------------------------------
* When DATABASE_URL is set, all data lives in PostgreSQL —
* safe across Render restarts and free-tier sleeping.
* When no DATABASE_URL, falls back to the original JSON file
* store (for local development).
*
* IMPORTANT: Call init() once at server startup before using
* any other method. All methods return synchronously for the
* JSON path; for PostgreSQL, init() is async but after that
* reads happen from an in-memory cache that is kept in sync
* with the database, so the existing server.js code works
* without any async changes.
* -----------------------------------------------------------
*/

const fs = require('fs');
const path = require('path');

// ---------- JSON fallback (original logic, unchanged) ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
let cache = { users: [] };

function ensureJson() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  }
}

function loadJson() {
  ensureJson();
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || { users: [] };
    if (!Array.isArray(cache.users)) cache.users = [];
  } catch (e) {
    cache = { users: [] };
  }
  return cache;
}

let writeTimer = null;
function persistJson() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('DB write failed:', e.message); }
  }, 50);
}

function persistSyncJson() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.error('DB sync write failed:', e.message); }
}

// ---------- PostgreSQL layer ----------
// Uses an in-memory cache + write-through to PostgreSQL.
// This keeps the same synchronous API that server.js expects
// while ensuring data survives Render restarts.

let pool = null;
let usePg = false;

/* Initialise PostgreSQL. Call once at startup (async). */
async function initPg() {
  if (!process.env.DATABASE_URL) return false;

  try {
    const pg = require('pg');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 5,               // keep small for free tier
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT UNIQUE NOT NULL,
        phone         TEXT DEFAULT '',
        school        TEXT DEFAULT '',
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'teacher',
        status        TEXT NOT NULL DEFAULT 'active',
        token_version INTEGER NOT NULL DEFAULT 1,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
    `);

    // Load all existing rows into the in-memory cache
    const res = await pool.query('SELECT * FROM users');
    cache.users = res.rows.map(row => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone || '',
      school: row.school || '',
      passwordHash: row.password_hash,
      role: row.role,
      status: row.status,
      tokenVersion: row.token_version,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at || null,
    }));

    usePg = true;
    console.log(`[db] PostgreSQL connected — ${cache.users.length} user(s) loaded. Data persists across restarts!`);
    return true;
  } catch (e) {
    console.error('[db] PostgreSQL init failed, falling back to JSON file:', e.message);
    pool = null;
    return false;
  }
}

/* Write a single user row to PostgreSQL */
async function pgInsertUser(user) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO users (id, name, email, phone, school, password_hash, role, status, token_version, created_at, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.name, user.email, user.phone || '', user.school || '',
       user.passwordHash, user.role, user.status, user.tokenVersion || 1,
       user.createdAt, user.lastLoginAt || null]
    );
  } catch (e) {
    console.error('[db] pg insert error:', e.message);
  }
}

/* Update a user row in PostgreSQL */
async function pgUpdateUser(id, patch) {
  if (!pool) return;
  try {
    const sets = [];
    const vals = [];
    let n = 1;

    // Map JS field names to PG column names
    const colMap = {
      name: 'name',
      email: 'email',
      phone: 'phone',
      school: 'school',
      passwordHash: 'password_hash',
      role: 'role',
      status: 'status',
      tokenVersion: 'token_version',
      lastLoginAt: 'last_login_at',
    };

    for (const [key, val] of Object.entries(patch)) {
      const col = colMap[key];
      if (col) {
        sets.push(`${col} = $${n}`);
        vals.push(val);
        n++;
      }
    }

    if (sets.length === 0) return;

    vals.push(id);
    await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${n}`,
      vals
    );
  } catch (e) {
    console.error('[db] pg update error:', e.message);
  }
}

/* Delete a user row from PostgreSQL */
async function pgDeleteUser(id) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  } catch (e) {
    console.error('[db] pg delete error:', e.message);
  }
}

// ---------- Public API (same interface as original db.js) ----------

function load() {
  if (usePg) {
    // Already loaded during initPg(). Just return.
    return cache;
  }
  return loadJson();
}

function persist() {
  if (usePg) return; // PostgreSQL is write-through; no file persist needed
  persistJson();
}

function persistSync() {
  if (usePg) return;
  persistSyncJson();
}

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
  if (usePg) {
    pgInsertUser(user); // fire-and-forget write to PG
  }
  persist();
  return user;
}

function updateUser(id, patch) {
  const u = findById(id);
  if (!u) return null;
  Object.assign(u, patch);
  if (usePg) {
    pgUpdateUser(id, patch);
  }
  persist();
  return u;
}

function removeUser(id) {
  const i = cache.users.findIndex((u) => u.id === id);
  if (i < 0) return false;
  cache.users.splice(i, 1);
  if (usePg) {
    pgDeleteUser(id);
  }
  persist();
  return true;
}

module.exports = {
  init: initPg,   // NEW — call once at startup
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
