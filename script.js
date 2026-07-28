// ══════════════════════════════════════════════════════
// PAYTRACK v15
// Changes from v14:
//   • Active Payments: Sales Person filter dropdown
//   • Active Payments: Sort by Dealer (A-Z/Z-A) & Balance (asc/desc)
//   • Download now respects current filter+sort (via _getFilteredActiveData)
// ══════════════════════════════════════════════════════

function normalizeWebAppUrl(value) {
    const raw = (value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
        const withoutSlash = raw.replace(/\/+$/, '');
        if (withoutSlash.includes('/api') || withoutSlash.includes('/exec')) return withoutSlash;
        return withoutSlash + '/api';
    }
    if (raw.startsWith('/')) return raw;
    return 'https://' + raw;
}

function getConfiguredWebAppUrl() {
    if (typeof window !== 'undefined' && window.PAYTRACK_BACKEND_URL) {
        return normalizeWebAppUrl(window.PAYTRACK_BACKEND_URL);
    }
    if (typeof document !== 'undefined') {
        const meta = document.querySelector('meta[name="paytrack-backend-url"]');
        if (meta && meta.content) return normalizeWebAppUrl(meta.content);
    }
    return '';
}

function getDefaultWebAppUrl() {
    return getConfiguredWebAppUrl() || 'https://payment-management-backend.onrender.com/api';
}

let WEBAPP_URL = normalizeWebAppUrl(
    new URLSearchParams(window.location.search).get('backendUrl')
    || getDefaultWebAppUrl()
);

// ── SESSION ────────────────────────────────────────────
let _currentUser = null;
function _checkSession() {
    const saved = sessionStorage.getItem('pt_user');
    if (saved) { try { _currentUser = JSON.parse(saved); return true; } catch(e) { sessionStorage.removeItem('pt_user'); } }
    return false;
}
function _saveSession(user)  { _currentUser = user; sessionStorage.setItem('pt_user', JSON.stringify(user)); }
function _clearSession()     { _currentUser = null; sessionStorage.removeItem('pt_user'); }

function _renderUserBadge(user) {
    const container = document.getElementById('user-badge-container');
    if (!container) return;
    const initials = (user.name || user.email).charAt(0).toUpperCase();
    container.innerHTML = `
        <div class="user-badge">
            <div class="user-avatar">${initials}</div>
            <div class="user-info">
                <div class="user-name">${user.name || user.email}</div>
                <div class="user-email">${user.email}</div>
            </div>
            <button class="logout-btn" onclick="logoutUser()">Logout</button>
        </div>`;
}

function logoutUser() {
    if (!confirm('Logout karna chahte ho?')) return;
    _clearSession(); location.reload();
}

// ── LOGIN ──────────────────────────────────────────────
async function doLogin() {
    const emailEl = document.getElementById('login-email');
    const passEl  = document.getElementById('login-pass');
    const errEl   = document.getElementById('login-error');
    const btn     = document.getElementById('login-btn');
    const email   = emailEl.value.trim();
    const pass    = passEl.value.trim();
    errEl.style.display = 'none';
    if (!email || !pass) { errEl.textContent = '⚠️ Email aur password dono required hain'; errEl.style.display = 'block'; return; }
    btn.disabled = true; btn.innerHTML = '<span class="btn-spinner"></span> Verifying...';
    try {
        const res = await fetch(WEBAPP_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify({action:'loginUser',payload:{email,password:pass}}), redirect:'follow' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = JSON.parse((await res.text()).replace(/^\uFEFF/,'').trim());
        if (data.success) {
            _saveSession(data.user);
            document.getElementById('login-screen').style.display = 'none';
            _renderUserBadge(data.user);
            toast('Welcome, ' + data.user.name + '! 👋', 'success');
            loadDashboard();
        } else {
            errEl.textContent = '❌ ' + (data.message || 'Wrong credentials');
            errEl.style.display = 'block'; passEl.value = ''; passEl.focus();
        }
    } catch(e) {
        errEl.textContent = '🌐 Network error — WEBAPP_URL check karo (' + e.message + ')';
        errEl.style.display = 'block';
    } finally { btn.disabled = false; btn.innerHTML = 'Sign In →'; }
}

// ══════════════════════════════════════════════════════
// APP DATA
// ══════════════════════════════════════════════════════
const AppData = {
    dashboard: null, today: null, active: null,
    activeAll: null, history: null, archived: null,
};

const AppIndex = {
    invoiceHistory: null,  // Map<"DealerCode||InvoiceNo", records[]>
    dealerHistory:  null,  // Map<dealerCode, records[]>
    built: false,
};

const REQUEST_QUEUE_KEY = 'paytrack_request_queue';
const WRITE_ACTIONS = new Set(['addInvoice', 'logCall', 'archiveNow']);
let RequestQueue = loadRequestQueue();
let _queueProcessing = false;

function loadRequestQueue() {
    try {
        const raw = localStorage.getItem(REQUEST_QUEUE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveRequestQueue() {
    try { localStorage.setItem(REQUEST_QUEUE_KEY, JSON.stringify(RequestQueue)); } catch (e) {}
}

function enqueueRequest(action, payload, query) {
    RequestQueue.push({
        action,
        payload: payload === undefined ? null : payload,
        query: query === undefined ? null : query,
        createdAt: new Date().toISOString(),
        attempts: 0,
    });
    saveRequestQueue();
    toast('📩 Request queued. Connection restore pe automatically sync karega.', 'info');
    processQueuedRequests();
}

function dequeueRequest(index) {
    RequestQueue.splice(index, 1);
    saveRequestQueue();
}

async function processQueuedRequests() {
    if (_queueProcessing || !RequestQueue.length || !WEBAPP_URL) return;
    _queueProcessing = true;
    for (let i = RequestQueue.length - 1; i >= 0; i--) {
        const item = RequestQueue[i];
        const res = await api(item.action, item.payload, item.query, true, false);
        if (res && res.success) {
            dequeueRequest(i);
            toast(`✅ Queued request "${item.action}" synced`, 'success');
        } else {
            item.attempts = (item.attempts || 0) + 1;
            if (item.attempts >= 10) {
                toast(`⚠️ Queued request "${item.action}" failed repeatedly. Server check karo.`, 'error');
            }
            saveRequestQueue();
        }
    }
    _queueProcessing = false;
}

function _buildHistoryIndex(records) {
    AppIndex.invoiceHistory = new Map();
    AppIndex.dealerHistory  = new Map();
    for (const h of records) {
        const inv     = (h['Invoice No.'] || '').trim();
        const dc      = (h['Dealer Code']  || '').trim();
        const compKey = dc + '||' + inv;
        if (inv && dc) {
            if (!AppIndex.invoiceHistory.has(compKey)) AppIndex.invoiceHistory.set(compKey, []);
            AppIndex.invoiceHistory.get(compKey).push(h);
        }
        if (dc) {
            if (!AppIndex.dealerHistory.has(dc)) AppIndex.dealerHistory.set(dc, []);
            AppIndex.dealerHistory.get(dc).push(h);
        }
    }
    AppIndex.built = true;
}

function _indexNewCallEntry(entry) {
    if (!AppIndex.built) return;
    const inv     = (entry['Invoice No.'] || '').trim();
    const dc      = (entry['Dealer Code']  || '').trim();
    const compKey = dc + '||' + inv;
    if (inv && dc) {
        if (!AppIndex.invoiceHistory.has(compKey)) AppIndex.invoiceHistory.set(compKey, []);
        AppIndex.invoiceHistory.get(compKey).unshift(entry);
    }
    if (dc) {
        if (!AppIndex.dealerHistory.has(dc)) AppIndex.dealerHistory.set(dc, []);
        AppIndex.dealerHistory.get(dc).unshift(entry);
    }
}

const AppState = {
    currentPage: 'dashboard', activeFilter: 'all',
    activePage: 1, historyPage: 1, archivedPage: 1,
    todayFilter: 'today', searchTimer: null,
    sessionCallCounts: {}, lastCallMap: {},
    activeSearchQuery: '',  // v14: filter persistence fix
    activeSalesPersonFilter: '',  // v15: sales person filter
    activeSortField: null,        // v15: 'dealer' | 'balance'
    activeSortDir: null,          // v15: 'asc' | 'desc'
};

const PAGE_SIZE = { active: 100, history: 50, archived: 100 };

const _todayStr = (() => {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth()+1).padStart(2,'0') + '-' +
           String(d.getDate()).padStart(2,'0');
})();

// ── Config ─────────────────────────────────────────────
function saveWebAppUrl() {
    const val = normalizeWebAppUrl(document.getElementById('webapp-url-input').value);
    if (!val || !val.startsWith('https://')) { toast('Valid https:// URL daalo', 'error'); return; }
    WEBAPP_URL = val;
    document.getElementById('config-banner').classList.add('hidden');
    toast('URL saved! Ab login karo...', 'success');
    setTimeout(() => { document.getElementById('login-screen').style.display = 'flex'; document.getElementById('login-email').focus(); }, 600);
}

function saveSettingsUrl() {
    const val = normalizeWebAppUrl(document.getElementById('settings-url-input').value);
    if (!val || !val.startsWith('https://')) { toast('Valid https:// URL daalo', 'error'); return; }
    const isChanged = val !== WEBAPP_URL;
    WEBAPP_URL = val;
    document.getElementById('config-banner').classList.add('hidden');
    closeModal('modal-settings');
    if (isChanged) {
        Object.keys(AppData).forEach(k => AppData[k] = null);
        AppIndex.invoiceHistory = null; AppIndex.dealerHistory = null; AppIndex.built = false;
        toast('✅ URL saved! Reconnecting...', 'success');
        setTimeout(() => {
            loadDashboard(true);
            processQueuedRequests();
        }, 300);
    } else { toast('URL same hai — koi change nahi', 'info'); }
}

// ── INIT ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const now = new Date();
    document.getElementById('today-date').textContent =
        now.toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
    document.getElementById('f-dd').value = now.toISOString().split('T')[0];
    const webappInput = document.getElementById('webapp-url-input');
    const settingsInput = document.getElementById('settings-url-input');
    if (webappInput) webappInput.value = WEBAPP_URL;
    if (settingsInput) settingsInput.value = WEBAPP_URL;
    if (!WEBAPP_URL) {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('config-banner').classList.remove('hidden');
        return;
    }
    if (_checkSession()) {
        document.getElementById('login-screen').style.display = 'none';
        _renderUserBadge(_currentUser);
        loadDashboard();
        processQueuedRequests();
        return;
    }
    document.getElementById('login-email').focus();
    processQueuedRequests();
});

window.addEventListener('online', () => {
    toast('Network back! Queued requests sync karte hain...', 'info');
    processQueuedRequests();
});

// ══════════════════════════════════════════════════════
// PROGRESS BAR
// ══════════════════════════════════════════════════════
let _activeReqs = 0, _pct = 0, _pTimer = null;
function startProgress() {
    _activeReqs++;
    if (_activeReqs === 1) {
        _pct = 0; setProgress(15);
        clearInterval(_pTimer);
        _pTimer = setInterval(() => { if (_pct < 85) setProgress(_pct + (85 - _pct) * 0.1); }, 300);
        document.getElementById('progress-bar').classList.add('show');
    }
}
function endProgress() {
    _activeReqs = Math.max(0, _activeReqs - 1);
    if (_activeReqs === 0) {
        clearInterval(_pTimer); setProgress(100);
        setTimeout(() => { document.getElementById('progress-bar').classList.remove('show'); setProgress(0); }, 400);
    }
}
function setProgress(p) { _pct = p; document.getElementById('progress-fill').style.width = p + '%'; }

// ══════════════════════════════════════════════════════
// API
// ══════════════════════════════════════════════════════
async function api(action, payload, query, silent, allowQueue = false) {
    if (!WEBAPP_URL) { toast('Pehle Web App URL set karo (⚙️ Settings)', 'error'); return null; }
    if (!silent) startProgress();
    const body = { action };
    if (payload !== undefined) body.payload = payload;
    if (query   !== undefined) body.query   = query;
    try {
        const res = await fetch(WEBAPP_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(body), redirect:'follow' });
        if (!res.ok) {
            if (allowQueue && WRITE_ACTIONS.has(action)) {
                enqueueRequest(action, payload, query);
                return { success: true, message: 'Request queued for retry' };
            }
            throw new Error(`HTTP ${res.status}`);
        }
        const text = await res.text();
        if (!text || !text.trim()) {
            if (allowQueue && WRITE_ACTIONS.has(action)) {
                enqueueRequest(action, payload, query);
                return { success: true, message: 'Request queued for retry' };
            }
            throw new Error('Empty response.');
        }
        const data = JSON.parse(text.replace(/^\uFEFF/,'').trim());
        if (!data.success) {
            toast(data.message || 'Server error', 'error');
            return null;
        }
        return data;
    } catch(err) {
        let msg = err.message;
        if (msg.includes('Failed to fetch')) msg = 'CORS/network error. Deploy settings check karo.';
        if (allowQueue && WRITE_ACTIONS.has(action)) {
            enqueueRequest(action, payload, query);
            return { success: true, message: 'Request queued for retry' };
        }
        toast('Error: ' + msg, 'error'); return null;
    } finally { if (!silent) endProgress(); }
}

// ── SWR badge helpers ──────────────────────────────────
function _showSwrBadge(id) { const el = document.getElementById(id); if (el) el.innerHTML = '<span class="swr-badge">↻ Refreshing</span>'; }
function _hideSwrBadge(id) { const el = document.getElementById(id); if (el) el.innerHTML = ''; }

// ══════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════
const PAGE_META = {
    dashboard:  ['Dashboard', 'Payment overview & analytics'],
    today:      ["Today's Calling", 'Contacts to call today'],
    active:     ['Active Payments', 'All pending invoices'],
    collection: ['Collection', 'Date-wise payment received'],
    history:    ['Call History', 'Complete call log records'],
    search:     ['Search Results', 'Matching payment records'],
    archived:   ['Archived Payments', 'Historical paid records'],
};

function nav(page, force) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.remove('active'));
    const pg = document.getElementById('page-' + page);
    if (pg) pg.classList.add('active');
    const navBtn = document.querySelector(`.nav-btn[data-page="${page}"]`);
    if (navBtn) navBtn.classList.add('active');
    const [title, sub] = PAGE_META[page] || [page, ''];
    document.getElementById('page-title').textContent = title;
    document.getElementById('page-sub').textContent   = sub;
    AppState.currentPage = page;
    if (page === 'dashboard')  loadDashboard(force);
    if (page === 'today')      loadToday(force);
    if (page === 'active')     loadActive(force);
    if (page === 'collection') loadCollection(force);
    if (page === 'history')    loadHistory(force);
    if (page === 'archived')   loadArchived(force);
}

async function hardRefresh() {
    Object.keys(AppData).forEach(k => AppData[k] = null);
    AppIndex.invoiceHistory = null; AppIndex.dealerHistory = null; AppIndex.built = false;
    AppState.sessionCallCounts = {}; AppState.lastCallMap = {};
    AppState.activeSearchQuery = '';
    AppState.activeSalesPersonFilter = ''; AppState.activeSortField = null; AppState.activeSortDir = null;
    await api('clearCache', null, null, true);
    toast('Cache cleared! Refreshing...', 'info');
    nav(AppState.currentPage, true);
}

// ══════════════════════════════════════════════════════
// DASHBOARD — SWR
// ══════════════════════════════════════════════════════
async function loadDashboard(force) {
    if (!force && AppData.dashboard) {
        renderDashboard(AppData.dashboard, true);
        _bgRefreshDashboard();
        processQueuedRequests();
        return;
    }
    const res = await api('getDashboardData');
    if (!res) return;
    AppData.dashboard = res.data;
    renderDashboard(res.data, res.fromCache);
    if (!AppData.today) api('getTodayCalling', null, null, true).then(r => { if (r) AppData.today = r.data; });
    processQueuedRequests();
}

async function _bgRefreshDashboard() {
    const res = await api('getDashboardData', null, null, true);
    if (res) { AppData.dashboard = res.data; if (AppState.currentPage === 'dashboard') renderDashboard(res.data, false); }
}

function renderDashboard(d, fromCache) {
    document.getElementById('last-update-time').textContent = new Date().toLocaleTimeString();
    document.getElementById('cache-indicator').innerHTML = fromCache ? '<span class="cache-badge">⚡ Cached</span>' : '';
    document.getElementById('s-total').textContent    = fmt(d.totalOutstanding);
    document.getElementById('s-overdue').textContent  = fmt(d.overdue);
    document.getElementById('s-soon').textContent     = fmt(d.dueSoon);
    document.getElementById('s-calls').textContent    = d.todayCallCount;
    document.getElementById('s-parties').textContent  = d.activeParties || 0;
    document.getElementById('s-records').textContent  = `${d.totalRecords} pending invoices`;
    document.getElementById('badge-today').textContent = d.todayCallCount;
    renderAging(d.agingBuckets, d.totalOutstanding);
    renderTopOverdue(d.topOverdue || []);
}

function renderAging(buckets, total) {
    const colors = {'Within Credit':'#059669','<30 Days':'#2563EB','30-60 Days':'#D97706','60-90 Days':'#EA580C','90-120 Days':'#DC2626','>120 Days':'#7C3AED'};
    document.getElementById('aging-container').innerHTML = Object.entries(buckets).map(([lbl, amt]) => {
        const pct = total > 0 ? Math.max(2, (amt/total)*100) : 0;
        return `<div class="aging-item"><span class="aging-lbl">${lbl}</span><div class="aging-bar-track"><div class="aging-bar-fill" style="width:${pct}%;background:${colors[lbl]||'#94A3B8'}"></div></div><span class="aging-amt">${fmt(amt)}</span></div>`;
    }).join('');
}

function renderTopOverdue(records) {
    const tbody = document.getElementById('tbl-overdue');
    if (!records.length) { tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><span class="icon">🎉</span><p>No overdue accounts!</p></div></td></tr>`; return; }
    tbody.innerHTML = records.map((r, i) => `
    <tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td><div class="td-primary">${r['Customer Name']}</div><div style="font-size:11px;color:var(--text-muted)">${r['Dealer Code']}</div></td>
      <td><span class="mono">${r['Invoice No.']}</span></td>
      <td style="font-size:12px">${r['Dispatch Date']||'—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--red)">${fmt(r.balanceNum||0)}</td>
      <td><span style="font-weight:700;color:var(--red)">${r.dueDays} days</span></td>
      <td>${pill(r.priority||'Critical')}</td>
      <td><button class="btn btn-outline btn-sm" onclick="openCallModal('${esc(r['Dealer Code'])}','${esc(r['Customer Name'])}','${esc(r['Location']||'')}','${esc(r['Invoice No.'])}',${r.balanceNum||0})">📞 Call</button></td>
    </tr>`).join('');
}

// ══════════════════════════════════════════════════════
// DATE HELPERS
// ══════════════════════════════════════════════════════
function _parseDateToStr(val) {
    if (!val) return null;
    try {
        const s = String(val).trim();
        const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
        if (m) {
            const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
            const mo = months[m[2].toLowerCase()];
            if (mo !== undefined) {
                const d = new Date(parseInt(m[3]), mo, parseInt(m[1]));
                return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            }
        }
        const d = new Date(s.split(' ')[0]);
        if (!isNaN(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        return null;
    } catch { return null; }
}

// Convert "15-Jun-2026" → "2026-06-15" for string sorting
function _dateSortKey(dateStr) {
    if (!dateStr) return '';
    const m = String(dateStr).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m) {
        const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
        const mo = months[m[2].toLowerCase()];
        if (mo) return m[3] + '-' + mo + '-' + m[1].padStart(2,'0');
    }
    return _parseDateToStr(dateStr) || dateStr;
}

// ══════════════════════════════════════════════════════
// TODAY / PENDING
// ══════════════════════════════════════════════════════
function _categorizeTodayRecords(records) {
    const todayRecs = [], pendingRecs = [];
    for (const r of records) {
        const fupStr    = _parseDateToStr(r['Next Follow-up']);
        const od        = typeof r.overdueDays === 'number' ? r.overdueDays : (r.dueDays || 0);
        const fupIsToday  = fupStr === _todayStr;
        const fupIsPast   = fupStr && fupStr < _todayStr;
        const fupIsFuture = fupStr && fupStr > _todayStr;
        if (fupIsFuture) continue;
        if (fupIsToday || od === 0) { todayRecs.push(r); continue; }
        if (od > 0 || fupIsPast)   { pendingRecs.push(r); continue; }
    }
    return { todayRecs, pendingRecs };
}

function _sortTodayRecords(records) {
    return records.slice().sort((a, b) => {
        const nameA = String(a['Customer Name'] || '').toLowerCase().trim();
        const nameB = String(b['Customer Name'] || '').toLowerCase().trim();
        const nameCmp = nameA.localeCompare(nameB, 'en', { sensitivity: 'base' });
        if (nameCmp !== 0) return nameCmp;
        return String(a['Invoice No.']||'').localeCompare(String(b['Invoice No.']||''), 'en', {sensitivity:'base'});
    });
}

function setTodayFilter(f, el) {
    AppState.todayFilter = f;
    document.querySelectorAll('#tab-today-calling,#tab-pending-calling').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    if (AppData.today) renderToday(AppData.today);
}

async function loadToday(force) {
    if (!force && AppData.today) {
        renderToday(AppData.today);
        api('getTodayCalling', null, null, true).then(r => { if (r) { AppData.today = r.data; if (AppState.currentPage === 'today') renderToday(r.data); } });
        return;
    }
    document.getElementById('call-list-container').innerHTML = '<div class="card"><div class="card-body">' + Array(4).fill('<div class="sk sk-row" style="margin:6px 0"></div>').join('') + '</div></div>';
    const res = await api('getTodayCalling');
    if (!res) return;
    AppData.today = res.data;
    renderToday(res.data);
}

function renderToday(records) {
    const { todayRecs, pendingRecs } = _categorizeTodayRecords(records);
    const sortedToday   = _sortTodayRecords(todayRecs);
    const sortedPending = _sortTodayRecords(pendingRecs);
    document.getElementById('badge-today').textContent         = sortedToday.length;
    document.getElementById('today-count-badge').textContent   = sortedToday.length;
    document.getElementById('pending-count-badge').textContent = sortedPending.length;
    const filtered = AppState.todayFilter === 'pending' ? sortedPending : sortedToday;
    const counts = { Critical:0, High:0, Medium:0, Normal:0, Reminder:0 };
    filtered.forEach(r => { if (r.priority in counts) counts[r.priority]++; });
    const chipColors = { Critical:'var(--red)', High:'var(--orange)', Medium:'var(--yellow)', Normal:'var(--green)', Reminder:'var(--blue)' };
    document.getElementById('today-chips').innerHTML = Object.entries(counts).filter(([,c]) => c > 0)
        .map(([p,c]) => `<div class="s-chip"><div class="s-dot" style="background:${chipColors[p]}"></div><span class="lbl">${p}</span><span class="val">${c}</span></div>`).join('');
    const container = document.getElementById('call-list-container');
    if (!filtered.length) {
        container.innerHTML = `<div class="card"><div class="empty-state"><span class="icon">🎉</span><p>${AppState.todayFilter==='pending'?'No pending calls!':'No calls for today!'}</p></div></div>`;
        return;
    }
    container.innerHTML = filtered.map(r => _buildCallCardHTML(r)).join('');
}

function _buildCallCardHTML(r) {
    const icons  = { Critical:'🚨', High:'⚠️', Medium:'📌', Normal:'📞', Reminder:'🔔' };
    const iconBg = { Critical:'var(--red-bg)', High:'var(--orange-bg)', Medium:'var(--yellow-bg)', Normal:'var(--green-bg)', Reminder:'var(--blue-light)' };
    const prio      = r.priority || 'Normal';
    const callCount = AppState.sessionCallCounts[r['Invoice No.']] || 0;
    const callBadge = callCount > 0 ? `<span class="call-count-badge">✅ Called ${callCount}x</span>` : '';
    const hasRemark = r['Last Remarks'] && r['Last Remarks'] !== '-' && r['Last Remarks'] !== 'No Previous Call';
    const fupStr    = _parseDateToStr(r['Next Follow-up']);
    const fupLabel  = r['Next Follow-up'] ? `<span style="color:${fupStr===_todayStr?'var(--blue)':'var(--text-muted)'}">📅 Follow-up: ${r['Next Follow-up']}</span>` : '';
    const od = typeof r.overdueDays === 'number' ? r.overdueDays : (r.dueDays || 0);
    return `<div class="call-card priority-${prio.toLowerCase()}" data-inv="${esc(r['Invoice No.'])}">
      <div class="call-avatar" style="background:${iconBg[prio]||'var(--bg)'}">${icons[prio]||'📞'}</div>
      <div class="call-info">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div style="font-size:14px;font-weight:700">
            ${r['Customer Name']}
            <span style="font-size:12px;font-weight:400;color:var(--text-muted)">(${r['Dealer Code']})</span>
            ${pill(prio)} ${callBadge}
          </div>
          <div style="background:var(--red-bg);color:var(--red);padding:4px 10px;border-radius:var(--radius-sm);font-weight:800;font-family:'JetBrains Mono';font-size:16px">${fmt(r['Balance'])}</div>
        </div>
        <div style="margin-top:8px;font-size:13px;display:flex;gap:12px;flex-wrap:wrap">
          <span>📞 <a href="tel:${r['Dealer Ph. No.']}" style="color:var(--blue);font-weight:800;text-decoration:none;border-bottom:2px solid var(--blue-light)">${r['Dealer Ph. No.']||'No Phone'}</a></span>
          <span>📄 <span class="mono">${r['Invoice No.']}</span></span>
          <span style="font-weight:900">🚚 ${r['Dispatch Date']||'—'}</span>
          ${fupLabel}
        </div>
        <div style="margin-top:6px;font-size:12px;display:flex;gap:12px;flex-wrap:wrap">
          <span>⏳ Due: <strong style="color:${od>0?'var(--red)':'var(--green)'}">${od}d</strong></span>
          <span>📍 ${r['Location']||'—'}</span>
          ${r['Dealer Type']?`<span>🏷️ ${r['Dealer Type']}</span>`:''}
          <span>👤 ${r['Sales Person']||'—'}</span>
          <span style="font-weight:900">💰 <span style="font-family:'JetBrains Mono'">${fmt(r['Invoice Amount'])}</span></span>
        </div>
        ${hasRemark?`<div style="margin-top:10px;padding:10px;background:#F8FAFC;border:1px solid var(--border);border-radius:var(--radius-sm)"><div style="font-size:10px;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px">Last Conversation</div><div style="font-size:13px;color:var(--text-secondary)">💬 ${r['Last Remarks']}</div><div style="font-size:11px;color:var(--text-muted);margin-top:3px">📅 ${r['Last Call Date']||'—'}</div></div>`:''}
      </div>
      <div class="call-actions" style="margin-left:16px">
        <button class="btn btn-primary btn-sm" onclick="openCallModal('${esc(r['Dealer Code'])}','${esc(r['Customer Name'])}','${esc(r['Location']||'')}','${esc(r['Invoice No.'])}',${r['Balance']})">✍️ Log Call</button>
        <button class="btn btn-ghost btn-sm" onclick="openRemarksModal('${esc(r['Invoice No.'])}','${esc(r['Customer Name'])}','${esc(r['Dealer Code'])}',${r['Balance']||0})">📋 Remarks</button>
      </div>
    </div>`;
}

// ── In-place card update ───────────────────────────────
function _updateCardInPlace(invoiceNo, payload) {
    const newFupStr = _parseDateToStr(payload.followUpDate);
    const amtPaid   = parseFloat(payload.amountReceived) || 0;
    const adjPaid   = parseFloat(payload.adjustment) || 0;
    if (AppData.today) {
        const rec = AppData.today.find(r => r['Invoice No.'] === invoiceNo);
        if (rec) {
            rec['Balance'] = Math.max(0, (rec['Balance'] || 0) - amtPaid - adjPaid);
            if (payload.followUpDate) rec['Next Follow-up'] = payload.followUpDate;
            rec['Last Remarks']   = payload.remarks;
            rec['Last Call Date'] = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
        }
    }
    if (!AppData.today) return;
    const { todayRecs, pendingRecs } = _categorizeTodayRecords(AppData.today);
    const sortedToday   = _sortTodayRecords(todayRecs);
    const sortedPending = _sortTodayRecords(pendingRecs);
    document.getElementById('badge-today').textContent         = sortedToday.length;
    document.getElementById('today-count-badge').textContent   = sortedToday.length;
    document.getElementById('pending-count-badge').textContent = sortedPending.length;
    const currentFiltered = AppState.todayFilter === 'pending' ? sortedPending : sortedToday;
    const stillInTab = currentFiltered.some(r => r['Invoice No.'] === invoiceNo);
    if (stillInTab) {
        const cardEl = document.querySelector(`.call-card[data-inv="${CSS.escape(invoiceNo)}"]`);
        if (cardEl) {
            const rec = AppData.today.find(r => r['Invoice No.'] === invoiceNo);
            if (rec) {
                const temp = document.createElement('div');
                temp.innerHTML = _buildCallCardHTML(rec);
                const newCard = temp.firstElementChild;
                newCard.classList.add('flash-update');
                cardEl.replaceWith(newCard);
            }
        }
    } else {
        const cardEl = document.querySelector(`.call-card[data-inv="${CSS.escape(invoiceNo)}"]`);
        if (cardEl) {
            cardEl.style.transition = 'opacity 0.3s, transform 0.3s';
            cardEl.style.opacity = '0'; cardEl.style.transform = 'translateX(20px)';
            setTimeout(() => { cardEl.remove(); _updateChips(currentFiltered); }, 320);
        }
        if (newFupStr === _todayStr) toast('Record aaj ke Today Calling mein move ho gaya ✅', 'info');
        else if (!newFupStr || newFupStr < _todayStr) toast('Record Pending mein hai — follow-up set karo', 'info');
    }
    _updateChips(currentFiltered);
}

function _updateChips(records) {
    const counts = { Critical:0, High:0, Medium:0, Normal:0, Reminder:0 };
    records.forEach(r => { if (r.priority in counts) counts[r.priority]++; });
    const chipColors = { Critical:'var(--red)', High:'var(--orange)', Medium:'var(--yellow)', Normal:'var(--green)', Reminder:'var(--blue)' };
    document.getElementById('today-chips').innerHTML = Object.entries(counts).filter(([,c]) => c > 0)
        .map(([p,c]) => `<div class="s-chip"><div class="s-dot" style="background:${chipColors[p]}"></div><span class="lbl">${p}</span><span class="val">${c}</span></div>`).join('');
}

// ══════════════════════════════════════════════════════
// ACTIVE PAYMENTS — SWR
// v14 FIX: activeSearchQuery — filter persistence
// v15: Sales Person filter + Dealer/Balance sort
// ══════════════════════════════════════════════════════
async function loadActive(force) {
    if (!force && AppData.activeAll) {
        _populateSalesPersonFilter();
        applyActiveFilter();
        _bgRefreshActive();
        _preloadHistory();
        return;
    }
    document.getElementById('tbl-active').innerHTML = Array(6).fill('<tr><td colspan="15"><div class="sk sk-row"></div></td></tr>').join('');
    const res = await api('getActivePayments', { page:1, pageSize:500 });
    if (!res) return;
    AppData.activeAll = res.data;
    AppState.activePage = 1;
    _populateSalesPersonFilter();
    applyActiveFilter();
    _preloadHistory();
}

async function _bgRefreshActive() {
    _showSwrBadge('active-swr-badge');
    const res = await api('getActivePayments', { page:1, pageSize:500 }, null, true);
    _hideSwrBadge('active-swr-badge');
    if (res) {
        AppData.activeAll = res.data;
        if (AppState.currentPage === 'active') { _populateSalesPersonFilter(); applyActiveFilter(); }
    }
}

let _historyPreloading = false;
async function _preloadHistory() {
    if (AppIndex.built || _historyPreloading) return;
    _historyPreloading = true;
    const res = await api('getCallingHistory', { page:1, pageSize:5000 }, null, true);
    _historyPreloading = false;
    if (res) { AppData.history = res.data; _buildHistoryIndex(res.data); }
}

function filterActive(f, el) {
    AppState.activeFilter = f; AppState.activePage = 1;
    document.querySelectorAll('.filter-tabs .ftab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    if (AppData.activeAll) applyActiveFilter(); else loadActive(true);
}

// v15: Sales Person filter
function applySalesPersonFilter(val) {
    AppState.activeSalesPersonFilter = val;
    AppState.activePage = 1;
    applyActiveFilter();
}

// v15: Dealer A-Z/Z-A & Balance asc/desc sort
function applySortFilter(val) {
    if (!val) {
        AppState.activeSortField = null;
        AppState.activeSortDir = null;
    } else {
        const [field, dir] = val.split('-');
        AppState.activeSortField = field;
        AppState.activeSortDir = dir;
    }
    AppState.activePage = 1;
    applyActiveFilter();
}

function _populateSalesPersonFilter() {
    const sel = document.getElementById('sp-filter');
    if (!sel || !AppData.activeAll) return;
    const names = [...new Set(AppData.activeAll.map(r => r['Sales Person']).filter(Boolean))]
        .sort((a,b) => a.localeCompare(b, 'en', {sensitivity:'base'}));
    const current = AppState.activeSalesPersonFilter;
    sel.innerHTML = '<option value="">👤 All Sales Persons</option>' +
        names.map(n => `<option value="${esc(n)}" ${n===current?'selected':''}>${n}</option>`).join('');
}

function _applyActiveSort(data) {
    const field = AppState.activeSortField, dir = AppState.activeSortDir;
    if (!field) return data;
    const sorted = data.slice();
    sorted.sort((a, b) => {
        if (field === 'dealer') {
            const va = String(a['Customer Name']||'').toLowerCase();
            const vb = String(b['Customer Name']||'').toLowerCase();
            const cmp = va.localeCompare(vb, 'en', { sensitivity:'base' });
            return dir === 'asc' ? cmp : -cmp;
        }
        if (field === 'balance') {
            const va = parseFloat(a['Balance']) || 0;
            const vb = parseFloat(b['Balance']) || 0;
            return dir === 'asc' ? va - vb : vb - va;
        }
        return 0;
    });
    return sorted;
}

// v15: Central filtered+sorted data — used by both table render AND download,
// so jo bhi filter/sort screen par lagा hai wahi download hoga
function _getFilteredActiveData() {
    const f = AppState.activeFilter;
    let data = AppData.activeAll || [];
    if      (f === 'Paid')   data = data.filter(r => r.status === 'Paid');
    else if (f === 'Active') data = data.filter(r => r.status !== 'Paid');
    else if (f !== 'all')    data = data.filter(r => r.priority === f && r.status !== 'Paid');

    if (AppState.activeSalesPersonFilter) {
        data = data.filter(r => (r['Sales Person']||'') === AppState.activeSalesPersonFilter);
    }

    // Apply search query on top of filter (v14 persistence fix)
    const q = AppState.activeSearchQuery.trim().toLowerCase();
    if (q) {
        data = data.filter(r => matchQ(q, r['Customer Name'], r['Invoice No.'], r['Dealer Code'], r['Dealer Ph. No.']));
    }

    return _applyActiveSort(data);
}

function applyActiveFilter() {
    const data = _getFilteredActiveData();
    const ps = PAGE_SIZE.active, total = data.length, pg = AppState.activePage;
    const start = (pg-1)*ps;
    renderActiveRows(data.slice(start, start+ps), { page:pg, pageSize:ps, total, totalPages:Math.ceil(total/ps) }, data);
}

function renderActiveRows(pageData, pagination, allFiltered) {
    document.getElementById('active-count').textContent = `${pagination.total} records`;
    const start = (pagination.page-1)*pagination.pageSize;
    const tbody = document.getElementById('tbl-active');
    if (!pageData.length) {
        tbody.innerHTML = `<tr><td colspan="15"><div class="empty-state"><span class="icon">✅</span><p>Koi record nahi</p></div></td></tr>`;
        document.getElementById('active-pagination').innerHTML = ''; return;
    }
    tbody.innerHTML = pageData.map((r, i) => {
        const paid = r.status === 'Paid';
        return `<tr>
      <td style="color:var(--text-muted)">${start+i+1}</td>
      <td><div class="td-primary">${r['Customer Name']}</div><div style="font-size:11px;color:var(--text-muted)">${r['Dealer Code']}</div></td>
      <td><a href="tel:${r['Dealer Ph. No.']}" style="color:var(--blue);text-decoration:none;font-weight:600;font-size:12.5px">${r['Dealer Ph. No.']||'—'}</a></td>
      <td><span class="mono">${r['Invoice No.']}</span></td>
      <td><span class="badge badge-reminder" style="font-size:11px">${r['Dealer Type']||'—'}</span></td>
      <td style="font-size:12px">${r['Sales Person']||'—'}</td>
      <td style="font-size:12px">${r['Location']||'—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${fmt(r['Invoice Amount'])}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${paid?'var(--green)':'var(--red)'}">${fmt(r['Balance'])}</td>
      <td style="font-size:12px">${r['Dispatch Date']||'—'}</td>
      <td style="font-size:12px">${fmtDate(r['Payment Due Date'])}</td>
      <td style="font-size:12px;font-weight:700;color:${r.dueDays>0&&!paid?'var(--red)':'var(--green)'}">${r.dueDays}d</td>
      <td>${pill(r.priority)}</td>
      <td>${paid?'<span class="badge badge-paid">Paid</span>':'<span class="badge badge-active">Active</span>'}</td>
      <td style="display:flex;gap:4px;align-items:center">
        ${!paid?`<button class="btn btn-outline btn-sm" onclick="openCallModal('${esc(r['Dealer Code'])}','${esc(r['Customer Name'])}','${esc(r['Location']||'')}','${esc(r['Invoice No.'])}',${r['Balance']})">📞</button>`:''}
        <button class="btn btn-ghost btn-sm" onclick="openRemarksModal('${esc(r['Invoice No.'])}','${esc(r['Customer Name'])}','${esc(r['Dealer Code'])}',${r['Balance']||0})">📋</button>
      </td>
    </tr>`;
    }).join('');
    renderPagination('active-pagination', pagination, pg => {
        AppState.activePage = pg;
        applyActiveFilter();
        window.scrollTo({ top:0, behavior:'smooth' });
    });
}

// ══════════════════════════════════════════════════════
// COLLECTION TAB — date-wise payments only
// v14: Analysis ki jagah yeh tab aaya.
//      Sirf Amount Received > 0 wale records dikhte hain.
//      Adjustment-only entries exclude hote hain.
// ══════════════════════════════════════════════════════
async function loadCollection(force) {
    const container = document.getElementById('collection-container');
    if (!force && AppData.history) {
        renderCollection(AppData.history);
        // BG refresh
        api('getCallingHistory', {page:1, pageSize:5000}, null, true).then(r => {
            if (r) {
                AppData.history = r.data; _buildHistoryIndex(r.data);
                if (AppState.currentPage === 'collection') renderCollection(r.data);
            }
        });
        return;
    }
    container.innerHTML = '<div class="card"><div class="card-body">' + Array(5).fill('<div class="sk sk-row" style="margin:6px 0"></div>').join('') + '</div></div>';
    const res = await api('getCallingHistory', {page:1, pageSize:5000});
    if (!res) return;
    AppData.history = res.data;
    _buildHistoryIndex(res.data);
    renderCollection(res.data);
}

function renderCollection(records) {
    const container = document.getElementById('collection-container');

    // Filter: sirf actual payments (Amount Received > 0)
    const payments = records.filter(r => (parseFloat(r['Amount Received']) || 0) > 0);

    // Group by date (extract from Timestamp like "15-Jun-2026 10:30" → "15-Jun-2026")
    const dateGroups = {};
    for (const r of payments) {
        const ts       = String(r['Timestamp'] || '').trim();
        const datePart = ts.split(' ')[0] || ts.substring(0, 11);
        if (!datePart) continue;
        if (!dateGroups[datePart]) dateGroups[datePart] = { entries: [], total: 0 };
        dateGroups[datePart].entries.push(r);
        dateGroups[datePart].total += parseFloat(r['Amount Received']) || 0;
    }

    // Sort dates descending using sortable key
    const sortedDates = Object.keys(dateGroups).sort((a, b) => {
        const ka = _dateSortKey(a), kb = _dateSortKey(b);
        return kb.localeCompare(ka);
    });

    // Summary stats
    const totalCollection = payments.reduce((s, r) => s + (parseFloat(r['Amount Received'])||0), 0);
    const todaySortKey    = _dateSortKey(sortedDates[0] || '');
    const todayTotal      = todaySortKey === _todayStr ? (dateGroups[sortedDates[0]]||{total:0}).total : 0;
    const thisMonthPfx    = _todayStr.substring(0, 7); // "2026-06"
    const thisMonthTotal  = sortedDates
        .filter(d => _dateSortKey(d).startsWith(thisMonthPfx))
        .reduce((s, d) => s + dateGroups[d].total, 0);

    let html = `
    <div class="coll-stats-3" style="margin-bottom:20px">
        <div class="stat-card" style="border:none;box-shadow:var(--shadow-premium)">
            <div class="stat-accent" style="background:var(--green)"></div>
            <div class="stat-top"><span class="stat-label">Total Collected</span><div class="stat-icon-wrap" style="background:var(--green-bg)">💰</div></div>
            <div class="stat-value" style="color:var(--green);font-size:20px">${fmt(totalCollection)}</div>
            <div class="stat-footer">${payments.length} entries all time</div>
        </div>
        <div class="stat-card" style="border:none;box-shadow:var(--shadow-premium)">
            <div class="stat-accent" style="background:var(--blue)"></div>
            <div class="stat-top"><span class="stat-label">This Month</span><div class="stat-icon-wrap" style="background:var(--blue-light)">📅</div></div>
            <div class="stat-value" style="color:var(--blue);font-size:20px">${fmt(thisMonthTotal)}</div>
            <div class="stat-footer">${sortedDates.filter(d=>_dateSortKey(d).startsWith(thisMonthPfx)).length} days active</div>
        </div>
        <div class="stat-card" style="border:none;box-shadow:var(--shadow-premium)">
            <div class="stat-accent" style="background:var(--purple)"></div>
            <div class="stat-top"><span class="stat-label">Collection Days</span><div class="stat-icon-wrap" style="background:var(--purple-bg)">📊</div></div>
            <div class="stat-value">${sortedDates.length}</div>
            <div class="stat-footer">Days with payments received</div>
        </div>
    </div>`;

    if (!payments.length) {
        html += '<div class="empty-state"><span class="icon">💰</span><p>Koi payment record nahi mila abhi tak</p></div>';
        container.innerHTML = html; return;
    }

    // Date-wise cards
    for (const date of sortedDates) {
        const group      = dateGroups[date];
        const isToday    = _dateSortKey(date) === _todayStr;
        const headerBg   = isToday
            ? 'background:linear-gradient(135deg,#0B4F3A,#0B7A56)'
            : 'background:linear-gradient(135deg,var(--navy),#1a2744)';

        html += `
        <div class="card section-gap">
            <div class="coll-date-header" style="${headerBg}">
                <span style="font-size:16px">📅</span>
                <span class="coll-date-label">${date}${isToday?' <span style="font-size:10px;background:rgba(255,255,255,.15);padding:2px 8px;border-radius:10px;margin-left:6px">TODAY</span>':''}</span>
                <span class="coll-date-count">${group.entries.length} payment${group.entries.length>1?'s':''}</span>
                <span class="coll-date-total">${fmt(group.total)}</span>
            </div>
            <div class="tbl-wrap"><table>
                <thead><tr><th>#</th><th>Party Name</th><th>Invoice No.</th><th>Amount Received</th><th>Remarks</th></tr></thead>
                <tbody>
                ${group.entries.map((r, i) => `
                <tr>
                    <td style="color:var(--text-muted)">${i+1}</td>
                    <td>
                        <div class="td-primary">${r['Customer Name']||'—'}</div>
                        <div style="font-size:11px;color:var(--text-muted)">${r['Dealer Code']||''} · ${r['Invoice No.']||''}</div>
                    </td>
                    <td><span class="mono">${r['Invoice No.']||'—'}</span></td>
                    <td><span style="font-family:'JetBrains Mono',monospace;font-weight:800;font-size:14px;color:var(--green)">+${fmt(r['Amount Received'])}</span></td>
                    <td style="font-size:12px;max-width:240px;white-space:normal;color:var(--text-secondary)">${r['Remarks']||'—'}</td>
                </tr>`).join('')}
                </tbody>
            </table></div>
            <div style="padding:10px 20px;background:var(--bg);border-top:1px solid var(--border);display:flex;justify-content:flex-end;align-items:center;gap:6px">
                <span style="font-size:12px;color:var(--text-muted)">Day Total:</span>
                <span style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:800;color:var(--green)">${fmt(group.total)}</span>
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

// ══════════════════════════════════════════════════════
// CALL HISTORY — SWR
// ══════════════════════════════════════════════════════
async function loadHistory(force) {
    if (!force && AppData.history) {
        const ps = PAGE_SIZE.history;
        renderHistoryRows(AppData.history.slice(0,ps), { page:1, pageSize:ps, total:AppData.history.length, totalPages:Math.ceil(AppData.history.length/ps) });
        _bgRefreshHistory(); return;
    }
    document.getElementById('tbl-history').innerHTML = Array(5).fill('<tr><td colspan="10"><div class="sk sk-row"></div></td></tr>').join('');
    const res = await api('getCallingHistory', { page:1, pageSize:500 });
    if (!res) return;
    AppData.history = res.data;
    AppState.historyPage = 1;
    _buildHistoryIndex(res.data);
    const ps = PAGE_SIZE.history;
    renderHistoryRows(res.data.slice(0,ps), { page:1, pageSize:ps, total:res.data.length, totalPages:Math.ceil(res.data.length/ps) });
}

async function _bgRefreshHistory() {
    _showSwrBadge('history-swr-badge');
    const res = await api('getCallingHistory', { page:1, pageSize:500 }, null, true);
    _hideSwrBadge('history-swr-badge');
    if (res) {
        AppData.history = res.data; _buildHistoryIndex(res.data);
        if (AppState.currentPage === 'history') {
            const ps = PAGE_SIZE.history, pg = AppState.historyPage, start = (pg-1)*ps;
            renderHistoryRows(res.data.slice(start,start+ps), { page:pg, pageSize:ps, total:res.data.length, totalPages:Math.ceil(res.data.length/ps) });
        }
    }
}

function renderHistoryRows(records, pagination) {
    const tbody = document.getElementById('tbl-history');
    if (!records.length) { tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><span class="icon">📋</span><p>Koi record nahi</p></div></td></tr>`; document.getElementById('history-pagination').innerHTML = ''; return; }
    const start = (pagination.page-1)*pagination.pageSize;
    tbody.innerHTML = records.map((r,i) => `
    <tr>
      <td style="color:var(--text-muted)">${start+i+1}</td>
      <td style="font-size:11.5px;color:var(--text-muted)">${r['Timestamp']||'—'}</td>
      <td><div class="td-primary">${r['Customer Name']}</div><div style="font-size:11px;color:var(--text-muted)">${r['Dealer Code']}</div></td>
      <td><span class="mono">${r['Invoice No.']}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:12px;color:${r['Amount Received']>0?'var(--green)':'var(--text-muted)'}">${r['Amount Received']>0?fmt(r['Amount Received']):'—'}</td>
      <td style="font-size:12px">${r['Scheduled Follow-up']?fmtDate(r['Scheduled Follow-up']):'—'}</td>
      <td style="font-size:12px">${r['Follow Up Date']?fmtDate(r['Follow Up Date']):'—'}</td>
      <td style="font-size:12px;max-width:200px;white-space:normal">${r['Remarks']||'—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${r['Adjustment Amount']>0?fmt(r['Adjustment Amount']):'—'}</td>
      <td style="font-size:12px">${r['Adjustment Remarks']||'—'}</td>
    </tr>`).join('');
    renderPagination('history-pagination', pagination, pg => {
        AppState.historyPage = pg;
        const data = AppData.history || [], ps = PAGE_SIZE.history, start = (pg-1)*ps;
        renderHistoryRows(data.slice(start,start+ps), { page:pg, pageSize:ps, total:data.length, totalPages:Math.ceil(data.length/ps) });
        window.scrollTo({ top:0, behavior:'smooth' });
    });
}

// ══════════════════════════════════════════════════════
// ARCHIVES — SWR
// ══════════════════════════════════════════════════════
async function loadArchived(force) {
    if (!force && AppData.archived) {
        const ps = PAGE_SIZE.archived;
        renderArchivedRows(AppData.archived.slice(0,ps), { page:1, pageSize:ps, total:AppData.archived.length, totalPages:Math.ceil(AppData.archived.length/ps) });
        _bgRefreshArchived(); return;
    }
    document.getElementById('tbl-archived').innerHTML = Array(5).fill('<tr><td colspan="9"><div class="sk sk-row"></div></td></tr>').join('');
    const res = await api('getArchivedData', { page:1, pageSize:500 });
    if (!res) return;
    AppData.archived = res.data;
    document.getElementById('archive-count').textContent = `${res.pagination.total} historical records`;
    const ps = PAGE_SIZE.archived;
    renderArchivedRows(res.data.slice(0,ps), { page:1, pageSize:ps, total:res.data.length, totalPages:Math.ceil(res.data.length/ps) });
}

async function _bgRefreshArchived() {
    _showSwrBadge('archived-swr-badge');
    const res = await api('getArchivedData', { page:1, pageSize:500 }, null, true);
    _hideSwrBadge('archived-swr-badge');
    if (res && AppState.currentPage === 'archived') {
        AppData.archived = res.data;
        document.getElementById('archive-count').textContent = `${res.pagination.total} historical records`;
        const ps = PAGE_SIZE.archived;
        renderArchivedRows(res.data.slice(0,ps), { page:1, pageSize:ps, total:res.data.length, totalPages:Math.ceil(res.data.length/ps) });
    }
}

function renderArchivedRows(data, pagination) {
    const tbody = document.getElementById('tbl-archived');
    if (!data.length) { tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><span class="icon">📁</span><p>Koi record nahi</p></div></td></tr>`; document.getElementById('archived-pagination').innerHTML = ''; return; }
    const start = (pagination.page-1)*pagination.pageSize;
    tbody.innerHTML = data.map((r,i) => `
    <tr>
      <td style="color:var(--text-muted)">${start+i+1}</td>
      <td><div class="td-primary">${r['Customer Name']}</div><div style="font-size:11px;color:var(--text-muted)">${r['Dealer Code']}</div></td>
      <td><span class="mono">${r['Invoice No.']}</span></td>
      <td><span class="badge badge-reminder" style="font-size:11px">${r['Dealer Type']||'—'}</span></td>
      <td style="font-size:12px">${r['Sales Person']||'—'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${fmt(r['Invoice Amount'])}</td>
      <td style="font-size:12px">${fmtDate(r['Payment Due Date'])}</td>
      <td>${pill(r.priority)}</td>
      <td style="font-size:11.5px;color:var(--text-muted)">${fmtDate(r['Archived Date'])}</td>
    </tr>`).join('');
    renderPagination('archived-pagination', pagination, pg => {
        const data = AppData.archived||[], ps=PAGE_SIZE.archived, start=(pg-1)*ps;
        renderArchivedRows(data.slice(start,start+ps), { page:pg, pageSize:ps, total:data.length, totalPages:Math.ceil(data.length/ps) });
        window.scrollTo({ top:0, behavior:'smooth' });
    });
}

// ══════════════════════════════════════════════════════
// PAGINATION
// ══════════════════════════════════════════════════════
function renderPagination(containerId, pg, onPageClick) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (pg.totalPages <= 1) { el.innerHTML = ''; return; }
    const { page, totalPages, total, pageSize } = pg;
    const from = (page-1)*pageSize+1, to = Math.min(page*pageSize, total);
    el.innerHTML = `
        <span class="pg-info">${from}–${to} of ${total}</span>
        <button class="pg-btn" id="pg-prev-${containerId}" ${page<=1?'disabled':''}>&lsaquo; Prev</button>
        <span id="pg-nums-${containerId}"></span>
        <button class="pg-btn" id="pg-next-${containerId}" ${page>=totalPages?'disabled':''}>Next &rsaquo;</button>`;
    const numsEl = document.getElementById('pg-nums-'+containerId);
    const range = [];
    for (let p = Math.max(1,page-2); p <= Math.min(totalPages,page+2); p++) range.push(p);
    let numsHTML = '';
    if (range[0]>1) numsHTML+=`<button class="pg-btn" data-p="1">1</button>${range[0]>2?'<span style="padding:0 4px;color:var(--text-muted)">…</span>':''}`;
    range.forEach(p => { numsHTML+=`<button class="pg-btn ${p===page?'active':''}" data-p="${p}">${p}</button>`; });
    if (range[range.length-1]<totalPages) numsHTML+=`${range[range.length-1]<totalPages-1?'<span style="padding:0 4px;color:var(--text-muted)">…</span>':''}<button class="pg-btn" data-p="${totalPages}">${totalPages}</button>`;
    numsEl.innerHTML = numsHTML;
    document.getElementById('pg-prev-'+containerId).addEventListener('click', () => onPageClick(page-1));
    document.getElementById('pg-next-'+containerId).addEventListener('click', () => onPageClick(page+1));
    numsEl.querySelectorAll('.pg-btn[data-p]').forEach(btn => { btn.addEventListener('click', () => onPageClick(parseInt(btn.dataset.p))); });
}

// ══════════════════════════════════════════════════════
// FORMS
// ══════════════════════════════════════════════════════
async function submitAddInvoice() {
    const p = {
        salesPerson:   v('f-sp'), dispatchDate: v('f-dd'), dealerCode: v('f-dc'),
        customerName:  v('f-cn'), location:     v('f-loc'), dealerType: v('f-dt'),
        orderNo:       v('f-ord'), dealerPhNo:  v('f-ph'), invoiceNo:  v('f-inv'),
        invoiceAmount: v('f-amt'), creditDays:  v('f-crd'),
    };
    if (!p.salesPerson||!p.customerName||!p.invoiceNo||!p.invoiceAmount) { toast('Sab required (*) fields bharo', 'error'); return; }
    loader('Invoice add ho raha hai...');
    const res = await api('addInvoice', p, null, false, true);
    hideLoader();
    if (!res) return;
    AppData.dashboard = null; AppData.today = null; AppData.activeAll = null;
    toast(res.message, 'success');
    closeModal('modal-add');
    if (AppState.currentPage === 'dashboard') loadDashboard(true);
    if (AppState.currentPage === 'active')    loadActive(true);
}

function openCallModal(dc, name, loc, inv, bal) {
    document.getElementById('c-name').textContent = name;
    document.getElementById('c-inv').textContent  = inv;
    document.getElementById('c-loc').textContent  = loc;
    document.getElementById('c-bal').textContent  = fmt(bal);
    document.getElementById('c-dc').value         = dc;
    document.getElementById('c-amt').value        = '';
    document.getElementById('c-rmk').value        = '';
    document.getElementById('c-adj').value        = '';
    document.getElementById('c-adjr').value       = '';
    document.getElementById('c-fup').value        = _todayStr;
    const btn = document.getElementById('btn-save-call');
    btn.disabled = false; btn.innerHTML = 'Save Call Log';
    const m = document.getElementById('modal-call');
    m.dataset.inv = inv; m.dataset.name = name; m.dataset.loc = loc; m.dataset.bal = bal||0;
    openModal('modal-call');
}

async function submitLogCall() {
    const m = document.getElementById('modal-call');
    const invoiceNo = m.dataset.inv;
    const p = {
        dealerCode:        v('c-dc'),
        customerName:      m.dataset.name,
        location:          m.dataset.loc,
        invoiceNo:         invoiceNo,
        amountReceived:    v('c-amt') || 0,
        followUpDate:      v('c-fup'),
        remarks:           v('c-rmk'),
        adjustment:        v('c-adj') || 0,
        adjustmentRemarks: v('c-adjr'),
        loggedBy:          _currentUser ? _currentUser.email : 'unknown',
    };
    const bal = parseFloat(m.dataset.bal) || 0;
    const amt = parseFloat(p.amountReceived) || 0;
    const adj = parseFloat(p.adjustment) || 0;
    if (amt+adj > bal) { toast(`Total (₹${amt+adj}) balance (₹${bal}) se zyada nahi ho sakta`, 'error'); return; }
    if (!p.remarks)    { toast('Customer remarks daalo', 'error'); return; }

    closeModal('modal-call');
    AppState.sessionCallCounts[invoiceNo] = (AppState.sessionCallCounts[invoiceNo]||0) + 1;

    // Update activeAll in-memory
    if (AppData.activeAll) {
        const rec = AppData.activeAll.find(r => r['Invoice No.'] === invoiceNo && r['Dealer Code'] === p.dealerCode);
        if (rec) {
            rec['Balance'] = Math.max(0, (rec['Balance']||0) - amt - adj);
            if (rec['Balance'] <= 0) rec.status = 'Paid';
        }
        // v14 FIX: applyActiveFilter re-applies both filter AND activeSearchQuery
        if (AppState.currentPage === 'active') applyActiveFilter();
    }

    if (AppState.currentPage === 'today' && AppData.today) {
        _updateCardInPlace(invoiceNo, p);
    }

    const newEntry = {
        'Timestamp':          new Date().toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}),
        'Dealer Code':        p.dealerCode,
        'Customer Name':      p.customerName,
        'Invoice No.':        invoiceNo,
        'Amount Received':    amt,
        'Follow Up Date':     p.followUpDate,
        'Scheduled Follow-up': p.followUpDate,
        'Remarks':            p.remarks,
        'Adjustment Amount':  adj,
        'Adjustment Remarks': p.adjustmentRemarks,
    };
    if (AppData.history) AppData.history.unshift(newEntry);
    _indexNewCallEntry(newEntry);
    AppData.dashboard = null;

    toast('📤 Saving call log...', 'info');
    const res = await api('logCall', p, undefined, true, true);
    if (res) {
        toast('✅ Call logged successfully!', 'success');
        if (AppState.currentPage === 'dashboard') loadDashboard(true);
        else if (AppState.currentPage === 'history') {
            const ps = PAGE_SIZE.history;
            if (AppData.history) renderHistoryRows(AppData.history.slice(0,ps), { page:1, pageSize:ps, total:AppData.history.length, totalPages:Math.ceil(AppData.history.length/ps) });
        } else if (AppState.currentPage === 'collection') {
            if (AppData.history) renderCollection(AppData.history);
        }
    } else {
        AppState.sessionCallCounts[invoiceNo] = Math.max(0, (AppState.sessionCallCounts[invoiceNo]||1)-1);
        if (AppData.history) AppData.history.shift();
        if (AppIndex.invoiceHistory) {
            const compKey = p.dealerCode + '||' + invoiceNo;
            const arr = AppIndex.invoiceHistory.get(compKey);
            if (arr && arr.length) arr.shift();
        }
        toast('⚠️ Save failed — queued for retry if network issue', 'error');
    }
}

// ══════════════════════════════════════════════════════
// GLOBAL SEARCH
// v14 FIX: active page search saves to activeSearchQuery
//          so filter tab + search work together after log
// ══════════════════════════════════════════════════════
async function globalSearch(val) {
    clearTimeout(AppState.searchTimer);
    const q = val.trim().toLowerCase();

    if (AppState.currentPage === 'active' && AppData.activeAll) {
        // v14: save search query so applyActiveFilter() can persist it
        AppState.activeSearchQuery = q;
        AppState.activePage = 1;
        applyActiveFilter();
        return;
    }
    if (AppState.currentPage === 'today' && AppData.today) {
        const filteredData = q ? AppData.today.filter(r => matchQ(q,r['Customer Name'],r['Invoice No.'],r['Dealer Code'],r['Dealer Ph. No.'])) : AppData.today;
        renderToday(filteredData); return;
    }
    if (AppState.currentPage === 'collection' && AppData.history) {
        const payments = AppData.history.filter(r => (parseFloat(r['Amount Received'])||0) > 0);
        const filtered = q ? payments.filter(r => matchQ(q,r['Customer Name'],r['Invoice No.'],r['Dealer Code'])) : payments;
        // Render filtered directly (pass a synthetic records array)
        const fakeAll = q ? AppData.history.filter(r => (parseFloat(r['Amount Received'])||0) > 0 && matchQ(q,r['Customer Name'],r['Invoice No.'],r['Dealer Code'])) : AppData.history;
        renderCollection(fakeAll);
        return;
    }
    if (AppState.currentPage === 'history' && AppData.history) {
        const filtered = q ? AppData.history.filter(r => matchQ(q,r['Customer Name'],r['Invoice No.'],r['Dealer Code'],r['Remarks'])) : AppData.history;
        const ps = PAGE_SIZE.history;
        renderHistoryRows(filtered.slice(0,ps), { page:1,pageSize:ps,total:filtered.length,totalPages:Math.ceil(filtered.length/ps) });
        return;
    }
    if (AppState.currentPage === 'archived' && AppData.archived) {
        const filtered = q ? AppData.archived.filter(r => matchQ(q,r['Customer Name'],r['Invoice No.'],r['Dealer Code'])) : AppData.archived;
        const ps = PAGE_SIZE.archived;
        renderArchivedRows(filtered.slice(0,ps), { page:1,pageSize:ps,total:filtered.length,totalPages:Math.ceil(filtered.length/ps) });
        return;
    }
    if (q.length < 2) { if (AppState.currentPage === 'search') nav('dashboard'); return; }
    AppState.searchTimer = setTimeout(async () => {
        nav('search');
        document.getElementById('tbl-search').innerHTML = Array(5).fill('<tr><td colspan="9"><div class="sk sk-row"></div></td></tr>').join('');
        const res = await api('searchRecords', null, val);
        if (!res) return;
        document.getElementById('search-count').textContent = `${res.data.length} results`;
        const tbody = document.getElementById('tbl-search');
        if (!res.data.length) { tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><span class="icon">🔍</span><p>Koi record nahi mila</p></div></td></tr>`; return; }
        tbody.innerHTML = res.data.map(r => `
        <tr>
          <td><div class="td-primary">${r['Customer Name']}</div><div style="font-size:11px;color:var(--text-muted)">${r['Dealer Code']}</div></td>
          <td><a href="tel:${r['Dealer Ph. No.']}" style="color:var(--blue);text-decoration:none;font-weight:600">${r['Dealer Ph. No.']||'—'}</a></td>
          <td><span class="mono">${r['Invoice No.']}</span></td>
          <td style="font-size:12px">${r['Dispatch Date']||'—'}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:var(--red)">${fmt(r['Balance'])}</td>
          <td style="font-size:12px">${fmtDate(r['Payment Due Date'])}</td>
          <td style="font-size:12px;font-weight:700;color:${r.overdueDays>0?'var(--red)':'var(--green)'}">${Math.max(0,r.overdueDays)}d</td>
          <td>${r['Status']==='Paid'?'<span class="badge badge-paid">Paid</span>':pill(r.priority||'Normal')}</td>
          <td>${r['Status']!=='Paid'?`<button class="btn btn-outline btn-sm" onclick="openCallModal('${esc(r['Dealer Code'])}','${esc(r['Customer Name'])}','${esc(r['Location']||'')}','${esc(r['Invoice No.'])}',${r['Balance']})">📞</button>`:'—'}</td>
        </tr>`).join('');
    }, 400);
}

async function runArchiveNow() {
    if (!confirm('Sab PAID invoices Archive mein move honge. Continue?')) return;
    loader('Archiving paid invoices...');
    const res = await api('archiveNow', null, null, false, true);
    hideLoader();
    if (!res) return;
    AppData.dashboard = null; AppData.today = null; AppData.activeAll = null; AppData.archived = null;
    toast(res.message, 'success');
    nav(AppState.currentPage, true);
}

function downloadActiveExcel() {
    if (!AppData.activeAll || !AppData.activeAll.length) { toast('Pehle Active Payments page kholo', 'error'); return; }
    const filtered = _getFilteredActiveData();  // v15: same filter+sort jo screen par hai
    if (!filtered.length) { toast('Koi record nahi', 'info'); return; }
    const headers = ['Customer Name','Dealer Code','Phone No.','Invoice No.','Sales Person','Invoice Amount','Balance','Dispatch Date','Due Date','Due Days','Priority','Status'];
    const csvRows = [headers.join(',')];
    filtered.forEach(r => csvRows.push([
        `"${(r['Customer Name']||'').replace(/"/g,'""')}"`,
        `"${(r['Dealer Code']||'').replace(/"/g,'""')}"`,
        `"${(r['Dealer Ph. No.']||'').replace(/"/g,'""')}"`,
        `"${(r['Invoice No.']||'').replace(/"/g,'""')}"`,
        `"${(r['Sales Person']||'').replace(/"/g,'""')}"`,
        r['Invoice Amount']||0, r['Balance']||0,
        `"${r['Dispatch Date']||''}"`, `"${fmtDate(r['Payment Due Date'])}"`,
        r.dueDays||0, `"${r.priority||''}"`, r.status||'Active'
    ].join(',')));
    const blob = new Blob(["\ufeff"+csvRows.join('\r\n')], {type:'text/csv;charset=utf-8;'});
    const a = Object.assign(document.createElement('a'), { href:URL.createObjectURL(blob), download:`Active_Payments_${new Date().toISOString().slice(0,10)}.csv` });
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
    toast('Download shuru!', 'success');
}

// ══════════════════════════════════════════════════════
// INVOICE REMARKS MODAL
// ══════════════════════════════════════════════════════
async function openRemarksModal(invoiceNo, customerName, dealerCode, balance) {
    document.getElementById('remarks-modal-name').textContent = customerName + ' (' + dealerCode + ')';
    document.getElementById('remarks-modal-meta').textContent = 'Invoice: ' + invoiceNo + '  ·  Balance: ' + fmt(balance);
    openModal('modal-remarks');
    if (AppIndex.built && AppIndex.invoiceHistory) {
        const compKey = dealerCode + '||' + invoiceNo;
        const records = AppIndex.invoiceHistory.get(compKey) || [];
        _renderRemarksModalContent(records, balance); return;
    }
    if (AppData.history) {
        const records = AppData.history.filter(h => h['Invoice No.'] === invoiceNo && h['Dealer Code'] === dealerCode);
        _buildHistoryIndex(AppData.history);
        _renderRemarksModalContent(records, balance); return;
    }
    document.getElementById('remarks-modal-timeline').innerHTML = `<div class="empty-state"><div class="spinner" style="width:24px;height:24px;border-width:2px"></div><p style="margin-top:8px">Loading history...</p></div>`;
    document.getElementById('remarks-modal-stats').innerHTML = '';
    const res = await api('getCallingHistory', { page:1, pageSize:5000 }, null, true);
    if (res) {
        AppData.history = res.data; _buildHistoryIndex(res.data);
        const compKey = dealerCode + '||' + invoiceNo;
        const records = AppIndex.invoiceHistory.get(compKey) || [];
        _renderRemarksModalContent(records, balance);
    } else {
        document.getElementById('remarks-modal-timeline').innerHTML = '<div class="empty-state"><span class="icon">❌</span><p>History load nahi ho saki</p></div>';
    }
}

function _renderRemarksModalContent(records, balance) {
    const totalCalls    = records.length;
    const totalReceived = records.reduce((s,h)=>s+(parseFloat(h['Amount Received'])||0),0);
    const totalAdj      = records.reduce((s,h)=>s+(parseFloat(h['Adjustment Amount'])||0),0);
    document.getElementById('remarks-modal-stats').innerHTML = [
        ['📞 Total Calls',    totalCalls,          'var(--blue)'],
        ['💰 Total Received', fmt(totalReceived),   'var(--green)'],
        ['📋 Adjustments',    fmt(totalAdj),        'var(--orange)'],
        ['💳 Current Balance',fmt(balance),         'var(--red)'],
    ].map(([lbl,val,color]) => `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px 16px;flex:1;min-width:110px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${lbl}</div>
            <div style="font-size:16px;font-weight:800;color:${color};font-family:'JetBrains Mono'">${val}</div>
        </div>`).join('');
    const timeline = document.getElementById('remarks-modal-timeline');
    if (!records.length) { timeline.innerHTML = '<div class="empty-state"><span class="icon">📋</span><p>Is invoice par koi call log nahi hai abhi tak</p></div>'; return; }
    timeline.innerHTML = records.map(h => {
        const amt = parseFloat(h['Amount Received'])||0;
        const adj = parseFloat(h['Adjustment Amount'])||0;
        const dotColor = amt>0 ? 'var(--green)' : 'var(--blue)';
        return `<div class="timeline-item">
            <div class="timeline-dot" style="background:${dotColor}"></div>
            <div class="timeline-meta" style="width:100%">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
                    <span style="font-size:12px;font-weight:700;color:var(--text-primary)">${h['Timestamp']||'—'}</span>
                    <div style="display:flex;gap:8px;flex-shrink:0">
                        ${amt>0?`<span style="font-family:'JetBrains Mono';font-size:13px;font-weight:700;color:var(--green)">+${fmt(amt)}</span>`:''}
                        ${adj>0?`<span style="font-family:'JetBrains Mono';font-size:12px;color:var(--orange)">ADJ: ${fmt(adj)}</span>`:''}
                    </div>
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:3px;display:flex;gap:14px;flex-wrap:wrap">
                    ${h['Follow Up Date']?`<span>📅 Follow-up: <strong>${fmtDate(h['Follow Up Date'])}</strong></span>`:''}
                    ${h['Scheduled Follow-up']?`<span>📌 Scheduled: ${fmtDate(h['Scheduled Follow-up'])}</span>`:''}
                </div>
                ${h['Remarks']?`<div style="font-size:13px;color:var(--text-secondary);margin-top:7px;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);border-left:3px solid ${dotColor}">💬 ${h['Remarks']}</div>`:''}
                ${adj>0&&h['Adjustment Remarks']?`<div style="font-size:11.5px;color:var(--orange);margin-top:5px;padding:5px 10px;background:var(--orange-bg);border-radius:var(--radius-sm)">⚠️ Adjustment Reason: ${h['Adjustment Remarks']}</div>`:''}
            </div>
        </div>`;
    }).join('');
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function matchQ(q, ...fields) { return fields.some(f => f && String(f).toLowerCase().includes(q)); }
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-bg')) closeModal(e.target.id); });
function loader(msg) { document.getElementById('loader-msg').textContent = msg||'Loading...'; document.getElementById('loader').classList.add('show'); }
function hideLoader() { document.getElementById('loader').classList.remove('show'); }

function toast(msg, type) {
    type = type||'info';
    const icons = { success:'✅', error:'❌', info:'ℹ️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${msg}</span>`;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => { el.style.transition='opacity 0.3s'; el.style.opacity='0'; }, 3500);
    setTimeout(() => el.remove(), 3800);
}

function fmt(n) {
    const val = parseFloat(n)||0;
    if (val>=1e7) return '₹'+(val/1e7).toFixed(2)+' Cr';
    if (val>=1e5) return '₹'+(val/1e5).toFixed(2)+' L';
    return '₹'+val.toLocaleString('en-IN', { maximumFractionDigits:0 });
}

function fmtDate(val) {
    if (!val) return '—';
    try {
        const s = String(val).trim();
        const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
        if (m) {
            const months={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
            const mo=months[m[2].toLowerCase()];
            if (mo!==undefined) return new Date(parseInt(m[3]),mo,parseInt(m[1])).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
        }
        return new Date(s).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    } catch { return val; }
}

function pill(priority) {
    priority = priority||'Normal';
    const map={Critical:'critical',High:'high',Medium:'medium',Normal:'normal',Reminder:'reminder'};
    return `<span class="badge badge-${map[priority]||'normal'}">${priority}</span>`;
}

function esc(s) { return (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"'); }
function v(id)  { return (document.getElementById(id)||{}).value||''; }
