/*
 * AlamaFlux backend integration layer.
 * Loaded AFTER app.js — it overrides the local-only auth functions so the
 * app uses the central server for accounts, and connects a live session
 * (Socket.IO) so the owner can monitor and force-logout users.
 *
 * Grading data (marks) is now ALSO synced to the server via /api/me/state,
 * so teachers see the same data across devices.
 */
(function () {
  const API = ''; // same origin
  const TOKEN_KEY = 'af_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

  async function api(pathname, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const t = getToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    // Show "waking up" message for Render free-tier cold start
    var wakingEl = document.getElementById('af-waking-msg');
    if (!wakingEl) {
      wakingEl = document.createElement('div');
      wakingEl.id = 'af-waking-msg';
      wakingEl.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;background:linear-gradient(90deg,#5B18C4,#7C3AED);color:#fff;text-align:center;padding:10px;font-size:14px;z-index:99999;font-family:sans-serif;';
      wakingEl.textContent = '\u26A1 Waking up server, please wait...';
      document.body.appendChild(wakingEl);
    }
    try {
      wakingEl.style.display = 'block';
      const res = await fetch(API + pathname, Object.assign({}, opts, { headers }));
      wakingEl.style.display = 'none';
      let data = null;
      try { data = await res.json(); } catch (e) { data = {}; }
      if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      return data;
    } catch (e) {
      wakingEl.style.display = 'none';
      if (e.message === 'Failed to fetch' || (e.name === 'TypeError' && e.message.indexOf('Failed to fetch') === 0)) {
        throw new Error('Server is waking up. Please wait a moment and try again.');
      }
      throw e;
    }
  }

  // ---------- State sync (grading data across devices) ----------
  // After login, we load the server state and MERGE it with localStorage.
  // Server state wins when there's a conflict (newer savedAt timestamp wins).
  // On every local save, we also push the state to the server (debounced).

  let _serverSaveTimer = null;
  const SERVER_SAVE_DELAY = 2000; // 2 seconds after local save

  // Push the current state object to the server (called by debounceSave).
  function pushStateToServer() {
    if (!currentUser) return;
    try {
      const stateStr = localStorage.getItem('nyak_' + currentUser.id + '_data');
      if (!stateStr) return;
      const stateData = JSON.parse(stateStr);
      api('/api/me/state', {
        method: 'PUT',
        body: JSON.stringify({ state: stateData })
      }).then(function (result) {
        console.log('[sync] State saved to server at', result.savedAt);
      }).catch(function (e) {
        console.warn('[sync] Failed to save state to server:', e.message);
      });
    } catch (e) {
      console.warn('[sync] Error pushing state:', e.message);
    }
  }

  // Schedule a server push (debounced so we don't hammer the API)
  function scheduleServerPush() {
    clearTimeout(_serverSaveTimer);
    _serverSaveTimer = setTimeout(pushStateToServer, SERVER_SAVE_DELAY);
  }

  // Load server state and merge with local state (server wins if newer)
  async function loadAndMergeServerState() {
    if (!currentUser) return;
    try {
      const result = await api('/api/me/state');
      if (!result.state) {
        // No server state yet — keep local state as-is, push it to server
        scheduleServerPush();
        return;
      }
      const serverState = result.state;
      const serverSavedAt = result.savedAt ? new Date(result.savedAt).getTime() : 0;
      // Check local state timestamp
      const localRaw = localStorage.getItem('nyak_' + currentUser.id + '_data');
      let localSavedAt = 0;
      if (localRaw) {
        try {
          const localData = JSON.parse(localRaw);
          localSavedAt = localData._savedAt || 0;
        } catch (e) {}
      }
      if (serverSavedAt > localSavedAt) {
        // Server is newer — use server state
        console.log('[sync] Loading server state (newer than local)');
        serverState._savedAt = serverSavedAt;
        localStorage.setItem('nyak_' + currentUser.id + '_data', JSON.stringify(serverState));
        // Reload app state from localStorage
        if (typeof loadUserState === 'function') loadUserState();
        if (typeof renderEntry === 'function') renderEntry();
      } else {
        // Local is newer or equal — push local to server
        console.log('[sync] Local state is current, pushing to server');
        scheduleServerPush();
      }
    } catch (e) {
      console.warn('[sync] Could not load server state:', e.message);
    }
  }

  // ---------- Socket / live session ----------
  let socket = null;
  let activityTimer = null;

  function connectSocket() {
    if (typeof io === 'undefined') return; // socket.io client not loaded
    if (socket) { try { socket.disconnect(); } catch (e) {} }
    socket = io({ auth: { token: getToken() } });
    socket.on('force-logout', (info) => {
      const msg = (info && info.reason) || 'Your session was ended by the administrator.';
      hardLogout(msg);
    });
    // Heartbeat so the owner sees "last active" and current grade.
    clearInterval(activityTimer);
    activityTimer = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('activity', { grade: (typeof currentGrade !== 'undefined' ? currentGrade : null) });
      }
    }, 15000);
  }

  function disconnectSocket() {
    clearInterval(activityTimer);
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
  }

  function hardLogout(message) {
    disconnectSocket();
    setToken(null);
    currentUser = null;
    try { document.getElementById('appContainer').classList.remove('active'); } catch (e) {}
    showAuth('login');
    const box = document.getElementById('loginSuccessBox');
    if (box) { box.textContent = message || 'You have been signed out.'; box.style.display = 'block'; }
  }

  // ---------- Owner admin link ----------
  function injectAdminLink() {
    if (!currentUser || currentUser.role !== 'owner') return;
    const dd = document.getElementById('userDD');
    if (!dd || dd.querySelector('.dd-admin')) return;
    const item = document.createElement('div');
    item.className = 'dd-item dd-admin';
    item.textContent = '\uD83D\uDEE1\uFE0F Admin Dashboard';
    item.onclick = function () { window.open('admin.html', '_blank'); };
    const header = dd.querySelector('.dd-header');
    if (header && header.nextSibling) dd.insertBefore(item, header.nextSibling);
    else dd.appendChild(item);
  }

  // ---------- Overrides ----------
  doRegister = async function () {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const phone = document.getElementById('regPhone').value.trim();
    const school = document.getElementById('regSchool').value.trim();
    const pw = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirm').value;
    const errBox = document.getElementById('regErrorBox');
    const showErr = (m) => { errBox.textContent = m; errBox.style.display = 'block'; };

    if (!name) return showErr('Please enter your full name.');
    if (!email || !email.includes('@')) return showErr('Please enter a valid email address.');
    if (!phone || phone.length < 9) return showErr('Please enter a valid phone number (9 digits).');
    if (pw.length < 6) return showErr('Password must be at least 6 characters.');
    if (pw !== confirm) return showErr('Passwords do not match.');

    try {
      await api('/api/register', { method: 'POST', body: JSON.stringify({ name, email, phone: '+254' + phone, school, password: pw }) });
      errBox.style.display = 'none';
      showAuth('login');
      const s = document.getElementById('loginSuccessBox');
      s.textContent = 'Account created! Please sign in.';
      s.style.display = 'block';
      document.getElementById('loginEmail').value = email;
    } catch (e) { showErr(e.message); }
  };

  doLogin = async function () {
    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const pw = document.getElementById('loginPassword').value;
    const errBox = document.getElementById('loginErrorBox');
    const sucBox = document.getElementById('loginSuccessBox');
    if (!email || !pw) { errBox.textContent = 'Please enter email and password.'; errBox.style.display = 'block'; sucBox.style.display = 'none'; return; }
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password: pw }) });
      setToken(data.token);
      currentUser = data.user;
      errBox.style.display = 'none'; sucBox.style.display = 'none';
      // Load state from server BEFORE entering the app
      await loadAndMergeServerState();
      enterApp();
      injectAdminLink();
      connectSocket();
    } catch (e) {
      errBox.textContent = e.message; errBox.style.display = 'block'; sucBox.style.display = 'none';
    }
  };

  doLogout = async function () {
    // Push state to server before logout
    if (currentUser) {
      try { saveUserState(); } catch (e) {}
      try { pushStateToServer(); } catch (e) {}
    }
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    hardLogout('You have been signed out.');
  };

  updateSchoolName = function (v) {
    if (!currentUser) return;
    currentUser.school = v.trim();
    clearTimeout(window._afSchoolTimer);
    window._afSchoolTimer = setTimeout(() => {
      api('/api/me/school', { method: 'PATCH', body: JSON.stringify({ school: currentUser.school }) }).catch(() => {});
    }, 600);
  };

  saveProfileEdits = async function () {
    const name = document.getElementById('edName').value.trim();
    const phone = document.getElementById('edPhone').value.trim();
    const school = document.getElementById('edSchool').value.trim();
    const curPw = document.getElementById('edCurPw').value;
    const newPw = document.getElementById('edNewPw').value;
    const confPw = document.getElementById('edConfPw').value;

    if (!name) return toast('\u274C Name cannot be empty');
    if (!phone || phone.length < 9) return toast('\u274C Enter a valid 9-digit phone number');
    if (!school) return toast('\u274C School name cannot be empty');

    const body = { name, phone: '+254' + phone, school };
    if (curPw || newPw || confPw) {
      if (!curPw) return toast('\u274C Enter your current password');
      if (!newPw || newPw.length < 6) return toast('\u274C New password must be at least 6 characters');
      if (newPw !== confPw) return toast('\u274C New passwords do not match');
      body.currentPassword = curPw; body.newPassword = newPw;
    }
    try {
      const data = await api('/api/me', { method: 'PUT', body: JSON.stringify(body) });
      currentUser = Object.assign(currentUser, data.user);
      document.getElementById('ddName').textContent = currentUser.name;
      document.getElementById('userBtnLabel').textContent = '\uD83D\uDC64 ' + currentUser.name.split(' ')[0];
      const snt = document.getElementById('schoolNameTop'); if (snt) snt.value = currentUser.school || '';
      window._profileEditing = false;
      renderProfile();
      toast('\u2705 Profile updated!');
    } catch (e) { toast('\u274C ' + e.message); }
  };

  // ---------- Boot (async session restore) ----------
  window.__bootApp = async function () {
    const t = getToken();
    if (!t) { showAuth('login'); return; }
    try {
      const data = await api('/api/me');
      currentUser = data.user;
      // Load state from server BEFORE entering the app
      await loadAndMergeServerState();
      enterApp();
      injectAdminLink();
      connectSocket();
    } catch (e) {
      setToken(null);
      showAuth('login');
    }
  };

  // ---------- Hook into local saves to also push to server ----------
  // Override saveUserState to also schedule a server push
  const _origSaveUserState = typeof saveUserState === 'function' ? saveUserState : null;
  if (_origSaveUserState) {
    saveUserState = function () {
      _origSaveUserState();
      // Add a timestamp so we can compare local vs server
      try {
        const raw = localStorage.getItem('nyak_' + currentUser.id + '_data');
        if (raw) {
          const d = JSON.parse(raw);
          d._savedAt = Date.now();
          localStorage.setItem('nyak_' + currentUser.id + '_data', JSON.stringify(d));
        }
      } catch (e) {}
      scheduleServerPush();
    };
  }

  window.__bootApp();
})();
