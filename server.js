/*
* AlamaFlux backend server — PATCHED for PostgreSQL persistence
* -----------------------------------------------------------
* Changes from original:
*   1. db.load() moved inside async init()
*   2. seedOwner() moved inside async init() (after DB is ready)
*   3. server.listen() moved inside async init()
*   4. Added 'pg' dependency requirement
*
* Everything else is IDENTICAL to the original server.js
* -----------------------------------------------------------
*/

const path = require('path');
require('./lib/loadenv')();
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./lib/db');
const email = require('./lib/email');

// Fire-and-forget email helper
function notify(templateName, user, extra) {
  try {
    Promise.resolve(email.sendTemplate(templateName, user, extra))
      .catch((e) => console.error('[email] send error:', e.message));
  } catch (e) {
    console.error('[email] notify error:', e.message);
  }
}

// ---------- Config ----------
const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'owner@alamaflux.local').toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'changeme123';

if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set — using a random secret. Sessions reset on restart. Set JWT_SECRET in production.');
}

// ---------- Seed owner account ----------
function seedOwner() {
  const existing = db.allUsers().find((u) => u.role === 'owner');
  if (existing) return;
  const hash = bcrypt.hashSync(OWNER_PASSWORD, 10);
  db.addUser({
    id: 'OWNER',
    name: 'System Owner',
    email: OWNER_EMAIL,
    phone: '',
    school: 'AlamaFlux HQ',
    passwordHash: hash,
    role: 'owner',
    status: 'active',
    tokenVersion: 1,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  });
  console.log(`[seed] Owner account created: ${OWNER_EMAIL}`);
  if (!process.env.OWNER_PASSWORD) {
    console.warn(`[warn] Owner password defaults to "${OWNER_PASSWORD}". Change it via OWNER_PASSWORD env.`);
  }
}

// ---------- Presence (in-memory) ----------
const presence = new Map();

function presenceSnapshot() {
  const list = [];
  for (const [uid, p] of presence.entries()) {
    list.push({
      id: uid, name: p.name, email: p.email,
      grade: p.grade, lastActive: p.lastActive, sockets: p.sockets.size,
    });
  }
  return list;
}

let io;
function broadcastPresence() {
  if (io) io.to('admins').emit('presence', presenceSnapshot());
}

// ---------- Helpers ----------
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    school: u.school, role: u.role, status: u.status,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  };
}

function signToken(u) {
  return jwt.sign({ uid: u.id, ver: u.tokenVersion }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = db.findById(payload.uid);
    if (!u) return null;
    if (u.status !== 'active') return null;
    if ((u.tokenVersion || 1) !== payload.ver) return null;
    return u;
  } catch (e) { return null; }
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const u = token && verifyToken(token);
  if (!u) return res.status(401).json({ error: 'Not authenticated or session ended.' });
  req.user = u;
  next();
}

function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
  next();
}

function genId() {
  return 'T' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}

// ---------- Auth routes ----------
app.post('/api/register', (req, res) => {
  const { name, email, phone, school, password } = req.body || {};
  if (!name || !email || !email.includes('@')) return res.status(400).json({ error: 'Valid name and email required.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.findByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id: genId(), name: name.trim(), email: email.toLowerCase().trim(),
    phone: (phone || '').trim(), school: (school || '').trim(),
    passwordHash: hash, role: 'teacher', status: 'active',
    tokenVersion: 1, createdAt: new Date().toISOString(), lastLoginAt: null,
  };
  db.addUser(user);
  notify('welcome', user);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.findByEmail(email || '');
  if (!u || !bcrypt.compareSync(password || '', u.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (u.status !== 'active') {
    return res.status(403).json({ error: 'This account has been suspended. Contact the administrator.' });
  }
  db.updateUser(u.id, { lastLoginAt: new Date().toISOString() });
  res.json({ token: signToken(u), user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/logout', auth, (req, res) => {
  res.status(204).end();
});

app.put('/api/me', auth, (req, res) => {
  const { name, phone, school, currentPassword, newPassword } = req.body || {};
  const patch = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim();
  if (typeof phone === 'string') patch.phone = phone;
  if (typeof school === 'string') patch.school = school;
  if (newPassword) {
    if (!bcrypt.compareSync(currentPassword || '', req.user.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    patch.passwordHash = bcrypt.hashSync(newPassword, 10);
    patch.tokenVersion = (req.user.tokenVersion || 1) + 1;
  }
  const u = db.updateUser(req.user.id, patch);
  res.json({ user: publicUser(u) });
});

app.put('/api/me/school', auth, (req, res) => {
  const school = (req.body && typeof req.body.school === 'string') ? req.body.school : '';
  const u = db.updateUser(req.user.id, { school });
  res.json({ user: publicUser(u) });
});

// ---------- Admin routes (owner only) ----------
app.get('/api/admin/users', auth, ownerOnly, (req, res) => {
  const online = new Set(presence.keys());
  const users = db.allUsers().map((u) => ({
    ...publicUser(u),
    online: online.has(u.id),
    lastActive: presence.get(u.id) ? presence.get(u.id).lastActive : null,
  }));
  res.json({ users });
});

app.get('/api/admin/sessions', auth, ownerOnly, (req, res) => {
  res.json({ sessions: presenceSnapshot() });
});

function kickUserSockets(userId, reason) {
  const p = presence.get(userId);
  if (p && io) {
    for (const sid of p.sockets) {
      io.to(sid).emit('force-logout', { reason: reason || 'Your session was ended by the administrator.' });
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }
}

app.post('/api/admin/users/:id/suspend', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Cannot suspend the owner account.' });
  db.updateUser(u.id, { status: 'suspended', tokenVersion: (u.tokenVersion || 1) + 1 });
  kickUserSockets(u.id, 'Your account has been suspended by the administrator.');
  notify('suspended', u, { ownerName: req.user.name, reason: (req.body && req.body.reason) || '' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/activate', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.updateUser(u.id, { status: 'active' });
  notify('activated', u, { ownerName: req.user.name });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/logout', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.updateUser(u.id, { tokenVersion: (u.tokenVersion || 1) + 1 });
  kickUserSockets(u.id, 'You were signed out by the administrator.');
  notify('forceLogout', u, { ownerName: req.user.name });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Cannot delete the owner account.' });
  kickUserSockets(u.id, 'Your account has been removed by the administrator.');
  notify('deleted', u, { ownerName: req.user.name });
  db.removeUser(u.id);
  res.json({ ok: true });
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HTTP + Socket.IO ----------
const server = http.createServer(app);
io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const u = token && verifyToken(token);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u;
  next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  if (u.role === 'owner') {
    socket.join('admins');
    socket.emit('presence', presenceSnapshot());
    return;
  }
  let p = presence.get(u.id);
  if (!p) {
    p = { sockets: new Set(), lastActive: Date.now(), grade: null, name: u.name, email: u.email };
    presence.set(u.id, p);
  }
  p.sockets.add(socket.id);
  p.lastActive = Date.now();
  broadcastPresence();

  socket.on('activity', (data) => {
    p.lastActive = Date.now();
    if (data && typeof data.grade === 'number') p.grade = data.grade;
    broadcastPresence();
  });

  socket.on('disconnect', () => {
    p.sockets.delete(socket.id);
    if (p.sockets.size === 0) presence.delete(u.id);
    broadcastPresence();
  });
});

// ========== ASYNC STARTUP — connect to PostgreSQL FIRST ==========
async function start() {
  // 1. Initialize database (PostgreSQL if available, else JSON file)
  await db.init();

  // 2. Load data (for JSON path; PG path already loaded in init)
  db.load();

  // 3. Seed the owner account
  seedOwner();

  // 4. Start listening — bind to 0.0.0.0 so Render can reach us
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`AlamaFlux server running on http://0.0.0.0:${PORT}`);
    console.log(`Owner login: ${OWNER_EMAIL}`);
  });
}

start().catch((err) => {
  console.error('[fatal] Server failed to start:', err);
  process.exit(1);
});

// ---------- Graceful shutdown ----------
process.on('SIGINT', () => { db.persistSync(); process.exit(0); });
process.on('SIGTERM', () => { db.persistSync(); process.exit(0); });
