/* =========================================================================
   DRRT frontend — talks to a real FastAPI backend (see /backend).
   Nothing here is mocked: auth is real JWT, shelter updates go through the
   server's field-level conflict resolver, incident photos are real uploads,
   the offline queue is real localStorage that replays through /sync/batch,
   and both maps use real OpenStreetMap tiles via Leaflet.
   ========================================================================= */

const API_BASE = window.localStorage.getItem('drrt_api_base') || 'http://localhost:8000';
document.getElementById('apiBaseLabel') && (document.getElementById('apiBaseLabel').textContent = API_BASE);

/* ---------------- session state ---------------- */
let session = null; // {token, username, full_name, role}
try {
  const raw = sessionStorage.getItem('drrt_session');
  if (raw) session = JSON.parse(raw);
} catch (e) { /* ignore */ }

let online = navigator.onLine;
let manualOfflineOverride = false; // "simulate offline" button
let shelters = [], incidents = [], tasks = [], sosAlerts = [];
let survivorMap, survivorMarkers = {};
let authMap, authMarkers = {}, heatLayer;

const QUEUE_KEY = 'drrt_offline_queue';

/* ---------------- generic helpers ---------------- */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
function nowIso() { return new Date().toISOString(); }
function nowStr() { return new Date().toTimeString().split(' ')[0]; }
function toast(msg, cls) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (cls ? ' ' + cls : '');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}
function badgeClass(level) { return level === 'OK' ? 'ok' : (level === 'Low' ? 'low' : 'out'); }
function occStatus(s) {
  const pct = s.occupancy / s.capacity;
  if (pct >= 1) return { cls: 'full', label: 'FULL' };
  if (pct >= 0.85) return { cls: 'limited', label: 'LIMITED' };
  return { cls: 'open', label: 'OPEN' };
}

/* ---------------- queue (real offline persistence) ---------------- */
function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; }
}
function setQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  updateQueuePill();
}
function pushToQueue(item) {
  const q = getQueue();
  q.push(item);
  setQueue(q);
}
function updateQueuePill() {
  const pill = document.getElementById('queuePill');
  const n = getQueue().length;
  if (n > 0) { pill.textContent = n + ' pending'; pill.classList.add('show'); }
  else pill.classList.remove('show');
}

/* ---------------- API client ---------------- */
async function api(path, { method = 'GET', body = null, form = null, auth = true } = {}) {
  const headers = {};
  if (auth && session) headers['Authorization'] = 'Bearer ' + session.token;
  let opts = { method, headers };
  if (form) {
    opts.body = form; // browser sets multipart boundary
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + path, opts);
  if (res.status === 401) {
    doLogout('Session expired — please sign in again.');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/* ================= AUTH ================= */
document.querySelectorAll('.login-tabs button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.login-tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const isReg = b.dataset.mode === 'register';
    document.getElementById('loginFields').style.display = isReg ? 'none' : 'block';
    document.getElementById('registerFields').style.display = isReg ? 'block' : 'none';
    document.getElementById('loginSubmit').textContent = isReg ? 'Create account' : 'Sign in';
  });
});

document.getElementById('loginSubmit').addEventListener('click', async () => {
  const isReg = document.getElementById('registerFields').style.display !== 'none';
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    let data;
    if (isReg) {
      const username = document.getElementById('regUser').value.trim();
      const full_name = document.getElementById('regName').value.trim();
      const password = document.getElementById('regPass').value;
      const role = document.getElementById('regRole').value;
      if (!username || !full_name || !password) { errEl.textContent = 'Fill in all fields.'; return; }
      data = await api('/auth/register', { method: 'POST', body: { username, full_name, password, role }, auth: false });
    } else {
      const username = document.getElementById('loginUser').value.trim();
      const password = document.getElementById('loginPass').value;
      if (!username || !password) { errEl.textContent = 'Enter username and password.'; return; }
      const form = new URLSearchParams();
      form.set('username', username);
      form.set('password', password);
      const res = await fetch(API_BASE + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || 'Login failed'); }
      data = await res.json();
    }
    session = { token: data.access_token, username: data.username, full_name: data.full_name, role: data.role };
    sessionStorage.setItem('drrt_session', JSON.stringify(session));
    boot();
  } catch (e) {
    errEl.textContent = e.message || 'Could not reach the DRRT API — is the backend running at ' + API_BASE + '?';
  }
});

function doLogout(msg) {
  session = null;
  sessionStorage.removeItem('drrt_session');
  document.getElementById('appWrap').style.display = 'none';
  document.getElementById('loginWrap').style.display = 'flex';
  if (msg) toast(msg, 'warn');
}
document.getElementById('logoutBtn').addEventListener('click', (e) => { e.preventDefault(); doLogout(); });

/* ================= GPS ================= */
function getGps(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve({ error: 'Geolocation not supported by this browser.' }); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => resolve({ error: err.message || 'Location permission denied.' }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

/* ================= connectivity ================= */
function effectiveOnline() { return online && !manualOfflineOverride; }

function setConnUI() {
  const dot = document.getElementById('connDot');
  const txt = document.getElementById('connText');
  const btn = document.getElementById('connToggleBtn');
  if (effectiveOnline()) {
    dot.className = 'dot online'; txt.textContent = 'ONLINE — live sync';
    btn.textContent = 'SIMULATE OFFLINE';
  } else {
    dot.className = 'dot offline';
    txt.textContent = manualOfflineOverride ? 'OFFLINE (simulated) — storing locally' : 'OFFLINE — storing locally';
    btn.textContent = 'RESTORE CONNECTION';
  }
}
window.addEventListener('online', () => { online = true; setConnUI(); if (effectiveOnline()) flushQueue(); });
window.addEventListener('offline', () => { online = false; setConnUI(); toast('Connection lost — updates will queue locally', 'warn'); });

document.getElementById('connToggleBtn').addEventListener('click', () => {
  manualOfflineOverride = !manualOfflineOverride;
  setConnUI();
  if (effectiveOnline()) { toast('Reconnected — syncing…', 'warn'); flushQueue(); }
  else toast('Simulating offline — updates will queue locally', 'warn');
});

/* ================= offline queue flush ================= */
async function flushQueue() {
  if (!session || !effectiveOnline()) return;
  const q = getQueue();
  if (q.length === 0) return;

  // Incident reports carrying a photo need multipart, so those replay
  // individually against /incidents; everything else batches through /sync/batch.
  const photoItems = q.filter(i => i.kind === 'incident_report' && i.photo_base64);
  const batchItems = q.filter(i => !(i.kind === 'incident_report' && i.photo_base64));

  let remaining = [...q];

  for (const item of photoItems) {
    try {
      const form = new FormData();
      form.set('type', item.payload.type);
      form.set('description', item.payload.description || '');
      if (item.payload.lat != null) form.set('lat', item.payload.lat);
      if (item.payload.lon != null) form.set('lon', item.payload.lon);
      form.set('client_uuid', item.client_uuid);
      const blob = base64ToBlob(item.photo_base64, item.photo_mime || 'image/jpeg');
      form.append('photo', blob, item.photo_name || 'photo.jpg');
      await api('/incidents', { method: 'POST', form });
      remaining = remaining.filter(r => r.client_uuid !== item.client_uuid);
      logSyncLocal(item.kind, 'applied', 'photo incident synced');
    } catch (e) {
      logSyncLocal(item.kind, 'rejected', e.message);
      // leave in queue for retry
    }
  }
  setQueue(remaining);

  if (batchItems.length) {
    try {
      const res = await api('/sync/batch', { method: 'POST', body: { actions: batchItems.map(i => ({
        client_uuid: i.client_uuid, kind: i.kind, client_timestamp: i.client_timestamp, payload: i.payload,
      })) } });
      const doneUuids = new Set();
      res.results.forEach(r => {
        doneUuids.add(r.client_uuid);
        logSyncLocal(r.kind, r.outcome, r.detail);
      });
      const stillQueued = getQueue().filter(i => !doneUuids.has(i.client_uuid));
      setQueue(stillQueued);
    } catch (e) {
      toast('Sync failed: ' + e.message, 'err');
    }
  }

  document.getElementById('lastSync').textContent = 'last sync: ' + nowStr();
  toast('Sync complete', 'ok');
  await refreshAll();
}

function base64ToBlob(b64, mime) {
  const byteChars = atob(b64.split(',').pop());
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* local (client-visible) sync log, separate from the server's authoritative one */
let localSyncLog = [];
function logSyncLocal(kind, outcome, detail) {
  localSyncLog.unshift({ kind, outcome, detail, time: nowStr() });
  localSyncLog = localSyncLog.slice(0, 20);
}

/* ================= role nav ================= */
const ROLE_VIEWS = {
  survivor: [{ role: 'survivor', label: 'Survivor', tag: 'S' }],
  volunteer: [{ role: 'volunteer', label: 'Volunteer', tag: 'V' }],
  authority: [{ role: 'authority', label: 'Authority', tag: 'A' }],
};
function buildNav() {
  const nav = document.getElementById('roleNav');
  const views = ROLE_VIEWS[session.role] || [];
  nav.innerHTML = views.map((v, i) =>
    `<button class="${i === 0 ? 'active' : ''}" data-role="${v.role}">${v.label} <span class="tag">${v.tag}</span></button>`
  ).join('');
  document.querySelectorAll('#roleNav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#roleNav button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-' + btn.dataset.role).classList.add('active');
    });
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  if (views[0]) document.getElementById('view-' + views[0].role).classList.add('active');
}

/* ================= data loading ================= */
async function refreshAll() {
  try {
    shelters = await api('/shelters');
    incidents = await api('/incidents');
    tasks = await api('/tasks');
  } catch (e) { toast('Could not load data: ' + e.message, 'err'); return; }

  if (session.role === 'survivor') { renderSurvivorList(); renderSurvivorMap(); }
  if (session.role === 'volunteer') { populateVolShelterSelect(); renderVerifyList(); renderTaskList(); }
  if (session.role === 'authority') { await renderAuthority(); }
}

/* ================= SURVIVOR ================= */
function shelterCardHTML(s) {
  const st = occStatus(s);
  const bedsLeft = Math.max(s.capacity - s.occupancy, 0);
  const totalDots = 20;
  const filledDots = Math.round((s.occupancy / s.capacity) * totalDots);
  let dots = '';
  for (let i = 0; i < totalDots; i++) dots += `<span class="${i < filledDots ? 'filled' : ''}"></span>`;
  return `
    <div class="card shelter-card">
      <div class="head">
        <div><div class="name">${s.name}</div><div class="id">${s.code}</div></div>
        <span class="status-chip ${st.cls}">${st.label}</span>
      </div>
      <div>
        <div class="dotgrid">${dots}</div>
        <div class="bedline"><span>${s.occupancy}/${s.capacity} occupied</span><span>${bedsLeft} beds free</span></div>
      </div>
      <div class="resline">
        <span class="res-badge ${badgeClass(s.food)}">FOOD · ${s.food}</span>
        <span class="res-badge ${badgeClass(s.water)}">WATER · ${s.water}</span>
        <span class="res-badge ${s.medical_facility === 'Available' ? 'ok' : 'out'}">MEDICAL · ${s.medical_facility}</span>
      </div>
      <div class="meta-time">v${s.version} · updated ${new Date(s.updated_at).toLocaleTimeString()} by ${s.updated_by}</div>
    </div>`;
}
function renderSurvivorList() {
  const filter = document.getElementById('survivorFilter').value;
  let list = shelters;
  if (filter === 'food') list = shelters.filter(s => s.food === 'OK');
  if (filter === 'water') list = shelters.filter(s => s.water === 'OK');
  if (filter === 'medical') list = shelters.filter(s => s.medical_facility === 'Available');
  if (filter === 'beds') list = shelters.filter(s => s.occupancy < s.capacity);
  document.getElementById('shelterListSurvivor').innerHTML =
    list.map(shelterCardHTML).join('') || '<div class="empty">No shelters match this filter right now.</div>';
}
document.getElementById('survivorFilter').addEventListener('change', renderSurvivorList);

function renderSurvivorMap() {
  if (!survivorMap) {
    survivorMap = L.map('map').setView([13.08, 80.27], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 18,
    }).addTo(survivorMap);
  }
  shelters.forEach(s => {
    const st = occStatus(s);
    const color = st.cls === 'full' ? '#ef4444' : st.cls === 'limited' ? '#f2a93b' : '#3ddc84';
    if (survivorMarkers[s.code]) survivorMap.removeLayer(survivorMarkers[s.code]);
    const marker = L.circleMarker([s.lat, s.lon], { radius: 9, color, fillColor: color, fillOpacity: 0.7, weight: 2 })
      .bindPopup(`<b>${s.name}</b><br>${s.occupancy}/${s.capacity} occupied · ${st.label}<br>Food: ${s.food} · Water: ${s.water} · Medical: ${s.medical_facility}`)
      .addTo(survivorMap);
    survivorMarkers[s.code] = marker;
  });
}

document.getElementById('sosBtn').addEventListener('click', async () => {
  const btn = document.getElementById('sosBtn');
  const note = document.getElementById('sosGpsNote');
  btn.disabled = true; note.textContent = 'Requesting device GPS…';
  const gps = await getGps();
  btn.disabled = false;
  if (gps.error) { note.textContent = '⚠ ' + gps.error + ' — SOS not sent. Enable location and try again.'; toast(gps.error, 'err'); return; }
  note.textContent = `Location captured: ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)} (±${Math.round(gps.accuracy)}m)`;
  const client_uuid = uuidv4();
  const payload = { lat: gps.lat, lon: gps.lon, gps_accuracy_m: gps.accuracy };
  if (effectiveOnline()) {
    try {
      const form = new FormData();
      form.set('lat', gps.lat); form.set('lon', gps.lon); form.set('gps_accuracy_m', gps.accuracy);
      form.set('client_uuid', client_uuid);
      await api('/sos', { method: 'POST', form });
      toast('SOS sent to nearest authority', 'ok');
    } catch (e) { toast('SOS failed: ' + e.message, 'err'); }
  } else {
    pushToQueue({ client_uuid, kind: 'sos', client_timestamp: nowIso(), payload });
    toast('SOS stored locally — will send once reconnected', 'warn');
  }
});

document.getElementById('incGetGps').addEventListener('click', async () => {
  const note = document.getElementById('incGpsNote');
  note.textContent = 'Requesting device GPS…';
  const gps = await getGps();
  if (gps.error) { note.textContent = '⚠ ' + gps.error; return; }
  note.textContent = `Captured: ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)} (±${Math.round(gps.accuracy)}m)`;
  note.dataset.lat = gps.lat; note.dataset.lon = gps.lon;
});

document.getElementById('incSubmit').addEventListener('click', async () => {
  const type = document.getElementById('incType').value;
  const desc = document.getElementById('incDesc').value.trim();
  const photoInput = document.getElementById('incPhoto');
  const note = document.getElementById('incGpsNote');
  const lat = note.dataset.lat ? parseFloat(note.dataset.lat) : null;
  const lon = note.dataset.lon ? parseFloat(note.dataset.lon) : null;
  if (!desc) { toast('Add a short description first', 'warn'); return; }
  const client_uuid = uuidv4();
  const file = photoInput.files[0] || null;

  if (effectiveOnline()) {
    try {
      const form = new FormData();
      form.set('type', type); form.set('description', desc); form.set('client_uuid', client_uuid);
      if (lat != null) form.set('lat', lat);
      if (lon != null) form.set('lon', lon);
      if (file) form.append('photo', file);
      await api('/incidents', { method: 'POST', form });
      toast('Incident reported', 'ok');
      document.getElementById('incDesc').value = ''; photoInput.value = '';
      note.textContent = 'No location captured yet.'; delete note.dataset.lat; delete note.dataset.lon;
      await refreshAll();
    } catch (e) { toast('Report failed: ' + e.message, 'err'); }
  } else {
    const payload = { type, description: desc, lat, lon };
    if (file) {
      const b64 = await fileToBase64(file);
      pushToQueue({ client_uuid, kind: 'incident_report', client_timestamp: nowIso(), payload, photo_base64: b64, photo_mime: file.type, photo_name: file.name });
    } else {
      pushToQueue({ client_uuid, kind: 'incident_report', client_timestamp: nowIso(), payload });
    }
    toast('Incident saved offline — queued for sync', 'warn');
    document.getElementById('incDesc').value = ''; photoInput.value = '';
    note.textContent = 'No location captured yet.'; delete note.dataset.lat; delete note.dataset.lon;
  }
});

/* ================= VOLUNTEER ================= */
function populateVolShelterSelect() {
  const sel = document.getElementById('volShelterSelect');
  const prev = sel.value;
  sel.innerHTML = shelters.map(s => `<option value="${s.code}">${s.name} (${s.code})</option>`).join('');
  sel.value = prev && shelters.find(s => s.code === prev) ? prev : sel.options[0]?.value;
  loadVolFormFor(sel.value);
}
function loadVolFormFor(code) {
  const s = shelters.find(x => x.code === code);
  if (!s) return;
  document.getElementById('volOcc').value = s.occupancy;
  document.getElementById('volCap').value = s.capacity;
  document.getElementById('volFood').value = s.food;
  document.getElementById('volWater').value = s.water;
  document.getElementById('volMed').value = s.medicine;
  document.getElementById('volMedical').value = s.medical_facility;
  document.getElementById('volBaseVersion').textContent = s.version;
}
document.getElementById('volShelterSelect').addEventListener('change', e => loadVolFormFor(e.target.value));

document.getElementById('volSubmit').addEventListener('click', async () => {
  const code = document.getElementById('volShelterSelect').value;
  const s = shelters.find(x => x.code === code);
  if (!s) return;
  const payload = {
    code, base_version: s.version,
    occupancy: parseInt(document.getElementById('volOcc').value || '0', 10),
    capacity: parseInt(document.getElementById('volCap').value || '0', 10),
    food: document.getElementById('volFood').value,
    water: document.getElementById('volWater').value,
    medicine: document.getElementById('volMed').value,
    medical_facility: document.getElementById('volMedical').value,
  };
  const client_timestamp = nowIso();
  if (effectiveOnline()) {
    try {
      const updated = await api('/shelters/' + code, { method: 'PATCH', body: { ...payload, client_timestamp } });
      toast('Update pushed to network (now v' + updated.version + ')', 'ok');
      await refreshAll();
    } catch (e) { toast('Update failed: ' + e.message, 'err'); }
  } else {
    pushToQueue({ client_uuid: uuidv4(), kind: 'shelter_update', client_timestamp, payload });
    toast('Update saved offline — queued for sync', 'warn');
  }
});

function renderVerifyList() {
  const wrap = document.getElementById('incidentVerifyList');
  const unverified = incidents.filter(i => !i.verified);
  if (unverified.length === 0) { wrap.innerHTML = '<div class="empty">Nothing awaiting verification.</div>'; return; }
  wrap.innerHTML = unverified.map(i => `
    <div class="list-item">
      ${i.photo_path ? `<img class="thumb" src="${i.photo_path}">` : ''}
      <div class="left" style="flex:1;">
        <div><b>${i.type}</b> — ${i.description}</div>
        <div class="tag-type">${i.code} · reported by ${i.reported_by} · ${new Date(i.created_at).toLocaleTimeString()}</div>
      </div>
      <button class="btn secondary verify-btn" data-verify="${i.code}">Verify</button>
    </div>`).join('');
  wrap.querySelectorAll('[data-verify]').forEach(b => {
    b.addEventListener('click', async () => {
      const code = b.dataset.verify;
      if (effectiveOnline()) {
        try { await api('/incidents/' + code + '/verify', { method: 'POST' }); toast('Incident marked verified', 'ok'); await refreshAll(); }
        catch (e) { toast('Failed: ' + e.message, 'err'); }
      } else {
        pushToQueue({ client_uuid: uuidv4(), kind: 'verify_incident', client_timestamp: nowIso(), payload: { code } });
        toast('Verification saved offline', 'warn');
        incidents.find(x => x.code === code).verified = true; // optimistic local update
        renderVerifyList();
      }
    });
  });
}
function renderTaskList() {
  document.getElementById('taskList').innerHTML = tasks.map(t => `
    <div class="list-item">
      <div class="left"><div>${t.label}</div><div class="tag-type">${t.assigned_to || 'unassigned'}${t.shelter_code ? ' · ' + t.shelter_code : ''}</div></div>
      <span class="res-badge ${t.status === 'Pending' ? 'low' : 'ok'}">${t.status.toUpperCase()}</span>
    </div>`).join('') || '<div class="empty">No tasks assigned.</div>';
}

/* ================= AUTHORITY ================= */
async function renderAuthority() {
  let summary, sosList, syncLogRows;
  try {
    [summary, sosList, syncLogRows] = await Promise.all([
      api('/dashboard/summary'), api('/sos'), api('/sync/log'),
    ]);
  } catch (e) { toast('Dashboard load failed: ' + e.message, 'err'); return; }
  sosAlerts = sosList;

  document.getElementById('statShelters').textContent = summary.active_shelters;
  document.getElementById('statBeds').textContent = summary.beds_available;
  document.getElementById('statOccPct').textContent = summary.avg_occupancy_pct + '%';
  document.getElementById('statIncidents').textContent = summary.open_incidents;
  document.getElementById('statSos').textContent = summary.open_sos;

  const tbody = document.querySelector('#shelterTable tbody');
  tbody.innerHTML = shelters.map(s => `
    <tr>
      <td style="font-family:var(--font-ui);color:var(--text);">${s.name}</td>
      <td>${s.occupancy}/${s.capacity}</td>
      <td style="color:${s.food === 'OK' ? 'var(--safe)' : s.food === 'Low' ? 'var(--amber)' : 'var(--danger)'}">${s.food}</td>
      <td style="color:${s.water === 'OK' ? 'var(--safe)' : s.water === 'Low' ? 'var(--amber)' : 'var(--danger)'}">${s.water}</td>
      <td style="color:${s.medical_facility === 'Available' ? 'var(--safe)' : 'var(--danger)'}">${s.medical_facility === 'Available' ? 'OK' : 'NONE'}</td>
      <td>${s.version}</td>
      <td>${new Date(s.updated_at).toLocaleTimeString()}</td>
    </tr>`).join('');

  document.getElementById('pressureCard').innerHTML = shelters.map(s => {
    const pct = Math.min(Math.round((s.occupancy / s.capacity) * 100), 100);
    return `<div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;"><span>${s.name}</span><span style="font-family:var(--font-mono);color:var(--text-dim);">${pct}%</span></div>
      <div class="heatbar"><div style="width:${pct}%"></div></div>
    </div>`;
  }).join('');

  document.getElementById('authorityIncidentFeed').innerHTML = incidents.map(i => `
    <div class="list-item">
      ${i.photo_path ? `<img class="thumb" src="${API_BASE}${i.photo_path}">` : ''}
      <div class="left" style="flex:1;">
        <div><b>${i.type}</b> — ${i.description}</div>
        <div class="tag-type">${i.code} · ${new Date(i.created_at).toLocaleTimeString()} · reported by ${i.reported_by}</div>
      </div>
      <span class="res-badge ${i.verified ? 'ok' : 'low'}">${i.verified ? 'VERIFIED' : 'UNVERIFIED'}</span>
    </div>`).join('') || '<div class="empty">No incidents reported.</div>';

  document.getElementById('sosFeed').innerHTML = sosAlerts.map(a => `
    <div class="list-item">
      <div class="left"><div><b>${a.user}</b> — ${a.status}</div><div class="tag-type">${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} · ${new Date(a.created_at).toLocaleTimeString()}</div></div>
      <span class="res-badge out">${a.status}</span>
    </div>`).join('') || '<div class="empty">No SOS alerts.</div>';

  const log = document.getElementById('syncLog');
  const combined = syncLogRows.slice(0, 12);
  log.innerHTML = combined.length ? combined.map(e => `
    <div class="entry ${e.outcome === 'applied' ? 'done' : e.outcome === 'conflict_merged' ? 'conflict' : ''}">
      <span>${e.actor} · ${e.action} ${e.entity_id || ''} — ${e.detail}</span>
      <span class="st">${e.outcome} ${new Date(e.server_time).toLocaleTimeString()}</span>
    </div>`).join('') : '<div class="empty">no server activity yet</div>';

  await renderAuthorityMap();
  document.getElementById('lastSync').textContent = 'last sync: ' + nowStr();
}

async function renderAuthorityMap() {
  if (!authMap) {
    authMap = L.map('authMap').setView([13.08, 80.27], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 18,
    }).addTo(authMap);
  }
  shelters.forEach(s => {
    const st = occStatus(s);
    const color = st.cls === 'full' ? '#ef4444' : st.cls === 'limited' ? '#f2a93b' : '#3ddc84';
    if (authMarkers[s.code]) authMap.removeLayer(authMarkers[s.code]);
    const marker = L.circleMarker([s.lat, s.lon], { radius: 9, color, fillColor: color, fillOpacity: 0.7, weight: 2 })
      .bindPopup(`<b>${s.name}</b><br>${s.occupancy}/${s.capacity} · v${s.version}`)
      .addTo(authMap);
    authMarkers[s.code] = marker;
  });
  sosAlerts.forEach(a => {
    L.circleMarker([a.lat, a.lon], { radius: 7, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.9, weight: 2 })
      .bindPopup(`<b>SOS — ${a.user}</b><br>${a.status}`).addTo(authMap);
  });
  try {
    const heatPts = await api('/incidents/heatmap');
    if (heatLayer) authMap.removeLayer(heatLayer);
    if (heatPts.length && window.L.heatLayer) {
      heatLayer = L.heatLayer(heatPts, { radius: 35, blur: 25, maxZoom: 14 }).addTo(authMap);
    }
  } catch (e) { /* heatmap is a nice-to-have, don't block the dashboard on it */ }
}

/* ================= boot ================= */
async function boot() {
  document.getElementById('loginWrap').style.display = 'none';
  document.getElementById('appWrap').style.display = 'block';
  document.getElementById('whoamiName').textContent = session.full_name;
  document.getElementById('whoamiRole').textContent = session.role;
  document.getElementById('footerApi').textContent = API_BASE;
  buildNav();
  setConnUI();
  await refreshAll();
  if (effectiveOnline()) flushQueue();
  setInterval(() => { if (effectiveOnline()) flushQueue(); }, 15000);
  setInterval(() => { if (session) refreshAll(); }, 20000);
}

if (session) boot(); else { document.getElementById('loginWrap').style.display = 'flex'; }
