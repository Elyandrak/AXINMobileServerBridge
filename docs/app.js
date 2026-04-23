/**
 * AXIN Bridge Dashboard v0.3.0
 * Plataforma mobile de administración para servidores Vintage Story.
 * Tabs: Estado | Chat | Tienda | Admin
 * Sin dependencias externas. Vanilla JS.
 *
 * v0.3: sesión persistente en disco (servidor), login con password, paneles
 * editables (Info del server, Eventos), Jugadores como desplegable.
 */

// ─── Constantes ───────────────────────────────────────────────────────────────

const CONFIG_KEY  = 'axin_bridge_config';
const SESSION_KEY = 'axin_bridge_session';
const PANELS_KEY  = 'axin_bridge_panels_open'; // ids desplegables abiertos
const STATUS_POLL = 15000;
const CHAT_POLL   = 3000;
const PANEL_POLL  = 30000;
const TIMEOUT_MS  = 8000;
const BRIDGE_DEFAULT_PORT = 42421;
const BRIDGE_RECOMMENDED_PORT = 43000;
const RELAY_PUBLIC_BASE = 'https://bridgerelay.axin.es';
const RELAY_ALLOWED_IP = '212.227.153.142';
const RELAY_API_SAMPLE = `${RELAY_PUBLIC_BASE}/s/mi-server/api`;

// ─── Estado global ────────────────────────────────────────────────────────────

const state = {
  phase: 'init',       // 'init' | 'setup' | 'loading' | 'online' | 'offline' | 'error'
  data: null,          // último ServerSnapshot
  error: null,
  lastUpdate: null,
  pollTimer: null,
  tickTimer: null,
  // v0.2
  tab: 'status',       // 'status' | 'chat' | 'market' | 'admin'
  chatMessages: [],
  chatPollTimer: null,
  marketOffers: [],
  marketLoading: false,
  marketBusy: new Set(),
  marketMsg: null,
  session: null,        // { token, playerName, isAdmin } o null
  // v0.3
  panels: [],           // [{ key, title, sections: [{id,title,items:[{text,url}]}] }]
  panelPollTimer: null,
  accountInfo: null,    // { hasPassword, passwordsAllowed }
  authMode: 'login',    // 'login' | 'link'  — modo del setup inicial
};

// ─── Config & Session ─────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
  catch { return {}; }
}
function saveConfig(cfg) { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); }
function hasConfig() {
  const c = loadConfig();
  if (!c.url) return false;
  // Modo relay: URL contiene /s/<slug>/api -> el relay inyecta la API key del bridge.
  if (isRelayUrl(c.url)) return true;
  return !!c.apiKey;
}
function isRelayUrl(url) {
  return !!url && /\/s\/[^/]+\/api\/?$/i.test(String(url).trim());
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}
function saveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

function setSession(s) {
  state.session = s;
  saveSession(s);
}

function clearSession(message = null) {
  state.session = null;
  saveSession(null);
  state.marketOffers = [];
  state.marketBusy.clear();
  if (message) state.marketMsg = { type: 'error', text: message };
  if (state.tab === 'market' || state.tab === 'admin') state.tab = 'status';
}

function isSessionError(error) {
  return ['invalid_session', 'not_linked', 'session_without_uid'].includes(error);
}

function handleSessionError(error) {
  if (!isSessionError(error)) return false;
  clearSession('La sesion vinculada ya no es valida. Vuelve a vincular tu cuenta.');
  render();
  return true;
}

function apiHeaders() {
  const cfg = loadConfig();
  const h = {};
  const relayMode = isRelayUrl(cfg.url);
  // En modo relay la API key del bridge no se expone desde el navegador.
  if (!relayMode && cfg.apiKey) h['X-Api-Key'] = cfg.apiKey;
  else if (!relayMode) h['X-Api-Key'] = ''; // fallará 401 en modo directo sin key
  if (state.session?.token) h['X-Session'] = state.session.token;
  return h;
}

function apiUrl(path) {
  return loadConfig().url?.replace(/\/$/, '') + path;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl(path), {
      ...opts,
      headers: { ...apiHeaders(), ...(opts.headers || {}) },
      signal: controller.signal,
    });
    clearTimeout(t);
    return res;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

async function apiPost(path, body) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function refreshSession() {
  if (!state.session?.token) return false;
  try {
    const res = await apiFetch('/auth/me');
    const data = await res.json();
    if (res.ok && data.linked) {
      setSession({
        token: state.session.token,
        playerName: data.playerName,
        role: data.role || '',
        permissions: data.permissions || [],
        isAdmin: data.isAdmin ?? false
      });
      return true;
    }

    if (res.status === 401 || data.error === 'invalid_session' || data.linked === false) {
      clearSession('La sesion vinculada ya no es valida. Vuelve a vincular tu cuenta.');
      return false;
    }
  } catch {
    // El polling de estado mostrara la caida de conexion si aplica.
  }
  return !!state.session;
}

// ─── Status fetch ─────────────────────────────────────────────────────────────

async function fetchStatus() {
  const cfg = loadConfig();
  const relayMode = isRelayUrl(cfg.url);
  if (!cfg.url || (!relayMode && !cfg.apiKey)) { setState('setup'); return; }

  try {
    const res = await apiFetch('/status');
    if (res.status === 401) { setState('error', 'API key incorrecta (401).'); return; }
    if (res.status === 429) { setState('error', 'Rate limit (429). Espera un momento.'); return; }
    if (!res.ok) { setState('offline', `HTTP ${res.status}`); return; }

    state.data = await res.json();
    if (state.session?.token) await refreshSession();
    state.lastUpdate = new Date();
    setState('online');
  } catch (err) {
    if (err.name === 'AbortError') setState('offline', `Sin respuesta en ${TIMEOUT_MS/1000}s`);
    else setState('offline', err.message || 'No se puede conectar');
  }
}

// ─── Chat fetch ───────────────────────────────────────────────────────────────

async function fetchChat() {
  try {
    const res = await apiFetch('/chat');
    if (res.ok) {
      const data = await res.json();
      state.chatMessages = data.messages || [];
      if (state.tab === 'chat') renderChatMessages();
    }
  } catch { /* silently fail — status poll handles connection state */ }
}

async function sendChat(text) {
  try {
    const res = await apiPost('/chat/send', { text });
    const data = await res.json();
    if (res.ok) {
      fetchChat(); // refresh immediately
      return { ok: true, sentAs: data.sentAs };
    }
    if (handleSessionError(data.error)) {
      return { ok: false, error: 'Sesion expirada. Vuelve a vincular tu cuenta.' };
    }
    return { ok: false, error: data.error, waitSeconds: data.waitSeconds };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Market fetch ───────────────────────────────────────────────────────────

async function fetchMarketOffers() {
  if (state.session?.token) await refreshSession();
  if (!state.session) {
    state.marketOffers = [];
    state.marketMsg = { type: 'error', text: 'Vincula tu cuenta para usar la tienda.' };
    return;
  }

  state.marketLoading = true;
  if (state.tab === 'market') renderMarketTab(document.getElementById('tab-content'));

  try {
    const res = await apiFetch('/market/offers');
    const data = await res.json();
    if (res.ok) {
      state.marketOffers = data.offers || [];
      state.marketMsg = null;
    } else {
      if (handleSessionError(data.error)) return;
      state.marketMsg = { type: 'error', text: marketErrorText(data.error) };
    }
  } catch (err) {
    state.marketMsg = { type: 'error', text: err.message || 'No se pudo cargar la tienda.' };
  } finally {
    state.marketLoading = false;
    if (state.tab === 'market') renderMarketTab(document.getElementById('tab-content'));
  }
}

async function buyMarketOffer(offer) {
  const qty = offer.buyQuantity || 1;
  const item = offer.itemName || offer.itemCode;
  const question = `¿Estás seguro de que quieres comprar ${qty}x ${item} por precio ${offer.priceText}?`;
  if (!confirm(question)) return;

  state.marketBusy.add(offer.id);
  state.marketMsg = null;
  renderMarketTab(document.getElementById('tab-content'));

  try {
    const res = await apiPost('/market/buy', { offerId: offer.id, quantity: qty });
    const data = await res.json();
    if (res.ok && data.success) {
      state.marketMsg = { type: 'success', text: `Compra completada: ${data.boughtQuantity}x ${data.itemName}.` };
      await fetchMarketOffers();
      return;
    }
    if (handleSessionError(data.error)) return;
    state.marketMsg = { type: 'error', text: marketErrorText(data.error, data) };
  } catch (err) {
    state.marketMsg = { type: 'error', text: err.message || 'No se pudo comprar.' };
  } finally {
    state.marketBusy.delete(offer.id);
    renderMarketTab(document.getElementById('tab-content'));
  }
}

// ─── Auth / Link ──────────────────────────────────────────────────────────────

async function linkWithCode(code, password) {
  try {
    const payload = { code };
    if (password) payload.password = password;
    const res = await apiPost('/auth/link', payload);
    const data = await res.json();
    if (res.ok && data.success) {
      setSession({
        token: data.token,
        playerName: data.playerName,
        role: data.role || '',
        permissions: data.permissions || [],
        isAdmin: data.isAdmin ?? false
      });
      state.accountInfo = {
        hasPassword: !!data.hasPassword,
        passwordsAllowed: data.passwordsAllowed !== false
      };
      return { ok: true };
    }
    return { ok: false, error: data.error || 'Código inválido' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function loginWithPassword(playerName, password) {
  try {
    const res = await apiPost('/auth/login', { playerName, password });
    const data = await res.json();
    if (res.ok && data.success) {
      setSession({
        token: data.token,
        playerName: data.playerName,
        role: data.role || '',
        permissions: data.permissions || [],
        isAdmin: data.isAdmin ?? false
      });
      state.accountInfo = { hasPassword: true, passwordsAllowed: true };
      return { ok: true };
    }
    return { ok: false, error: data.error || 'invalid_credentials', waitSeconds: data.waitSeconds };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function setAccountPassword(password) {
  try {
    const res = await apiPost('/auth/set-password', { password });
    const data = await res.json();
    if (res.ok && data.success) {
      state.accountInfo = { ...(state.accountInfo || {}), hasPassword: true };
      return { ok: true };
    }
    if (handleSessionError(data.error)) return { ok: false, error: 'session' };
    return { ok: false, error: data.error || 'error' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchAccountInfo() {
  if (!state.session?.token) return;
  try {
    const res = await apiFetch('/auth/account');
    if (!res.ok) return;
    const data = await res.json();
    state.accountInfo = {
      hasPassword: !!data.hasPassword,
      passwordsAllowed: data.passwordsAllowed !== false,
      origin: data.origin
    };
  } catch { /* best effort */ }
}

async function fetchPanels() {
  try {
    const res = await apiFetch('/panels');
    if (!res.ok) return;
    const data = await res.json();
    state.panels = data.panels || [];
    if (state.tab === 'status' && state.phase === 'online') renderStatusTab(document.getElementById('tab-content'), state.data);
  } catch { /* best effort */ }
}

async function unlinkSession() {
  try { await apiPost('/auth/unlink', {}); } catch { /* best effort */ }
  clearSession();
  render();
}

// ─── Admin actions ────────────────────────────────────────────────────────────

async function adminKick(playerName, reason = '') {
  try {
    const res = await apiPost('/admin/kick', { playerName, reason });
    return { status: res.status, ...(await res.json()) };
  } catch (err) { return { error: err.message }; }
}

async function adminTpSpawn(playerName) {
  try {
    const res = await apiPost('/admin/tp-spawn', { playerName });
    return { status: res.status, ...(await res.json()) };
  } catch (err) { return { error: err.message }; }
}

// ─── Permissions helper ───────────────────────────────────────────────────────

function hasPerm(perm) {
  return (state.session?.permissions || [])
    .some(p => String(p).toLowerCase() === String(perm).toLowerCase());
}

// ─── Motor de estado ──────────────────────────────────────────────────────────

function setState(phase, errorMsg = null) {
  state.phase = phase;
  state.error = errorMsg;
  render();
}

async function startPolling() {
  stopPolling();
  if (state.session?.token) {
    await refreshSession();
    fetchAccountInfo();
  }
  fetchStatus();
  fetchPanels();
  state.pollTimer = setInterval(fetchStatus, STATUS_POLL);
  state.tickTimer = setInterval(() => {
    if (state.phase === 'online') updateTimestamp();
  }, 5000);
  state.panelPollTimer = setInterval(fetchPanels, PANEL_POLL);
  startChatPoll();
}

function stopPolling() {
  clearInterval(state.pollTimer);
  clearInterval(state.tickTimer);
  clearInterval(state.panelPollTimer);
  state.panelPollTimer = null;
  stopChatPoll();
}

// ─── Panels open/close persistence ──────────────────────────────────────────

function loadPanelsOpen() {
  try { return JSON.parse(localStorage.getItem(PANELS_KEY) || '{}') || {}; }
  catch { return {}; }
}
function setPanelOpen(key, open) {
  const cur = loadPanelsOpen();
  if (open) cur[key] = true; else delete cur[key];
  localStorage.setItem(PANELS_KEY, JSON.stringify(cur));
}
function isPanelOpen(key, defaultOpen = false) {
  const cur = loadPanelsOpen();
  if (key in cur) return !!cur[key];
  return defaultOpen;
}

function startChatPoll() {
  stopChatPoll();
  fetchChat();
  state.chatPollTimer = setInterval(fetchChat, CHAT_POLL);
}

function stopChatPoll() {
  clearInterval(state.chatPollTimer);
  state.chatPollTimer = null;
}

function switchTab(tab) {
  if (tab === 'market' && !state.session) tab = 'status';
  state.tab = tab;
  render();
  if (tab === 'market') fetchMarketOffers();
}

// ─── Renderizado ──────────────────────────────────────────────────────────────

const app = document.getElementById('app');

function setAppContext(phase, view = '') {
  app.dataset.phase = phase || '';
  app.dataset.view = view || '';
}

function render() {
  switch (state.phase) {
    case 'setup':   renderSetup();              break;
    case 'loading': renderLoading();            break;
    case 'online':  renderMainView();           break;
    case 'offline': renderOffline(state.error); break;
    case 'error':   renderAlert(state.error);   break;
    default:        renderLoading();
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

function renderSetup() {
  const cfg = loadConfig();
  const linked = state.session != null;

  setAppContext('setup', 'setup');
  app.innerHTML = `
    <div class="setup-screen">
      <div class="setup-logo">
        <span class="logo-hex">\u2b21</span>
        <span class="logo-text">AXIN Bridge</span>
      </div>
      <h2 class="setup-title">Configurar servidor</h2>
      <p class="setup-hint">Modo recomendado hoy: conecta la PWA al relay VPS en <code>${esc(RELAY_PUBLIC_BASE)}</code>. La URL pública normal debe ser del tipo <code>${esc(RELAY_API_SAMPLE)}</code>. Solo usa conexión directa al bridge para despliegues controlados.</p>
      <form id="setup-form" class="setup-form" novalidate>
        <label class="field-label">URL del servidor
          <input id="inp-url" class="field-input" type="url"
            placeholder="${esc(RELAY_API_SAMPLE)}" value="${esc(cfg.url || '')}"
            autocorrect="off" autocapitalize="none" spellcheck="false" required>
        </label>
        <label class="field-label">API Key <span class="field-hint">(opcional si usas relay)</span>
          <input id="inp-key" class="field-input" type="password"
            placeholder="Necesaria solo en modo directo" value="${esc(cfg.apiKey || '')}"
            autocorrect="off" autocapitalize="none">
        </label>
        <div id="setup-msg" class="setup-msg hidden"></div>
        <button type="submit" class="btn-primary" id="btn-connect">Conectar</button>
      </form>

      ${linked ? renderLinkedSection() : renderAuthSection()}
    </div>
  `;

  document.getElementById('setup-form').addEventListener('submit', handleSetupSubmit);
  document.getElementById('btn-unlink')?.addEventListener('click', unlinkSession);
  document.getElementById('btn-link')?.addEventListener('click', handleLink);
  document.getElementById('btn-login')?.addEventListener('click', handleLogin);
  document.getElementById('btn-set-password')?.addEventListener('click', handleSetPassword);
  document.querySelectorAll('.auth-mode-btn').forEach(b => {
    b.addEventListener('click', () => { state.authMode = b.dataset.mode; renderSetup(); });
  });
}

function renderLinkedSection() {
  const a = state.accountInfo || {};
  const canSetPwd = a.passwordsAllowed !== false && a.hasPassword === false;
  return `
    <div class="link-section">
      <p class="link-status link-ok">\u2713 Vinculado como <strong>${esc(state.session.playerName)}</strong>
        ${state.session.role ? `<span class="admin-badge">${esc(state.session.role)}</span>` : ''}</p>
      ${a.hasPassword ? `<p class="link-hint">Cuenta con contraseña (puedes re-entrar sin /ams link).</p>` : ''}
      ${canSetPwd ? `
        <p class="link-hint">Define una contraseña para poder volver a entrar tras logout sin generar otro código ingame:</p>
        <div class="link-form">
          <input id="inp-new-pwd" class="field-input" type="password" minlength="6"
            placeholder="Contraseña (mín. 6)" autocorrect="off" autocapitalize="none" spellcheck="false">
          <button class="btn-primary btn-sm" id="btn-set-password">Guardar</button>
        </div>
        <div id="pwd-msg" class="setup-msg hidden"></div>
      ` : ''}
      <button class="btn-sm btn-danger" id="btn-unlink">Desvincular</button>
    </div>
  `;
}

function renderAuthSection() {
  const mode = state.authMode || 'login';
  return `
    <div class="link-section">
      <div class="auth-tabs">
        <button class="auth-mode-btn ${mode === 'login' ? 'active' : ''}" data-mode="login" type="button">Entrar</button>
        <button class="auth-mode-btn ${mode === 'link' ? 'active' : ''}" data-mode="link" type="button">Vincular con código</button>
      </div>
      ${mode === 'login' ? `
        <p class="link-hint">Introduce tu nombre de jugador y la contraseña definida tras vincularte.</p>
        <div class="link-form">
          <input id="inp-player" class="field-input" type="text"
            placeholder="Nombre de jugador" autocorrect="off" autocapitalize="off" spellcheck="false">
          <input id="inp-password" class="field-input" type="password"
            placeholder="Contraseña" autocorrect="off" autocapitalize="none" spellcheck="false">
          <button class="btn-primary btn-sm" id="btn-login">Entrar</button>
        </div>
        <p class="link-hint">¿Primera vez? Pulsa <strong>Vincular con código</strong>.</p>
      ` : `
        <p class="link-hint">Ejecuta <code>/ams link</code> en el juego y pega el código aquí. Opcionalmente define una contraseña para poder volver a entrar sin generar otro código.</p>
        <div class="link-form">
          <input id="inp-code" class="field-input code-input" type="text" maxlength="6"
            placeholder="ABC123" autocorrect="off" autocapitalize="characters" spellcheck="false">
          <input id="inp-link-pwd" class="field-input" type="password"
            placeholder="Contraseña opcional (mín. 6)" autocorrect="off" autocapitalize="none" spellcheck="false">
          <button class="btn-primary btn-sm" id="btn-link">Vincular</button>
        </div>
      `}
      <div id="link-msg" class="setup-msg hidden"></div>
    </div>
  `;
}

async function handleSetupSubmit(e) {
  e.preventDefault();
  const url = document.getElementById('inp-url').value.trim();
  const apiKey = document.getElementById('inp-key').value.trim();
  const btn = document.getElementById('btn-connect');

  // Si la URL parece de relay VPS (/s/<slug>/api), la API key pública no se usa.
  const relayMode = isRelayUrl(url);
  if (!url) { showMsg('setup-msg', 'Introduce la URL.', 'error'); return; }
  if (!relayMode && !apiKey) { showMsg('setup-msg', 'Introduce la API key (o usa una URL de relay).', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Conectando\u2026';

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const headers = {};
    if (apiKey) headers['X-Api-Key'] = apiKey;
    const res = await fetch(url.replace(/\/$/, '') + '/status', {
      headers,
      signal: controller.signal,
    });
    clearTimeout(t);
    if (res.status === 401) { showMsg('setup-msg', 'API key incorrecta.', 'error'); return; }
    if (!res.ok) { showMsg('setup-msg', `Error HTTP ${res.status}.`, 'error'); return; }
    await res.json();
    saveConfig({ url, apiKey: relayMode ? '' : apiKey });
    startPolling();
  } catch (err) {
    showMsg('setup-msg', err.name === 'AbortError' ? 'Sin respuesta.' : `Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Conectar';
  }
}

async function handleLink() {
  const code = document.getElementById('inp-code')?.value.trim();
  const pwd = document.getElementById('inp-link-pwd')?.value;
  if (!code || code.length < 4) { showMsg('link-msg', 'Introduce el código de 6 caracteres.', 'error'); return; }
  if (pwd && pwd.length < 6) { showMsg('link-msg', 'La contraseña debe tener al menos 6 caracteres.', 'error'); return; }
  const r = await linkWithCode(code, pwd || undefined);
  if (r.ok) {
    showMsg('link-msg', 'Vinculado correctamente.', 'success');
    setTimeout(render, 800);
  } else {
    showMsg('link-msg', r.error === 'invalid_or_expired_code' ? 'Código inválido o expirado.' : r.error, 'error');
  }
}

async function handleLogin() {
  const playerName = document.getElementById('inp-player')?.value.trim();
  const password = document.getElementById('inp-password')?.value;
  if (!playerName || !password) { showMsg('link-msg', 'Rellena jugador y contraseña.', 'error'); return; }
  const r = await loginWithPassword(playerName, password);
  if (r.ok) {
    showMsg('link-msg', 'Sesión iniciada.', 'success');
    setTimeout(render, 600);
  } else if (r.error === 'rate_limited') {
    showMsg('link-msg', `Demasiados intentos. Espera ${r.waitSeconds || 60}s.`, 'error');
  } else if (r.error === 'invalid_credentials') {
    showMsg('link-msg', 'Jugador o contraseña incorrectos.', 'error');
  } else if (r.error === 'passwords_disabled') {
    showMsg('link-msg', 'El servidor tiene el login con contraseña desactivado.', 'error');
  } else {
    showMsg('link-msg', r.error || 'Error al iniciar sesión.', 'error');
  }
}

async function handleSetPassword() {
  const pwd = document.getElementById('inp-new-pwd')?.value;
  if (!pwd || pwd.length < 6) { showMsg('pwd-msg', 'Mínimo 6 caracteres.', 'error'); return; }
  const r = await setAccountPassword(pwd);
  if (r.ok) {
    showMsg('pwd-msg', 'Contraseña guardada.', 'success');
    setTimeout(renderSetup, 500);
  } else if (r.error === 'session') {
    showMsg('pwd-msg', 'Sesión expirada. Vuelve a vincularte.', 'error');
  } else {
    showMsg('pwd-msg', r.error || 'Error al guardar.', 'error');
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────

function renderLoading() {
  setAppContext('loading', 'loading');
  app.innerHTML = `
    <div class="loading-screen">
      <div class="spinner" aria-label="Cargando"></div>
      <p class="loading-text">Conectando con el servidor\u2026</p>
    </div>
  `;
}

// ── Main view (tabs) ──────────────────────────────────────────────────────────

function renderMainView() {
  if (!state.data) return;
  const d = state.data;
  const showAdmin = hasPerm('canUseAdminPanel');
  const showMarket = !!state.session;
  const roleLabel = state.session?.role ? ` (${state.session.role})` : '';

  if (state.tab === 'admin' && !showAdmin) state.tab = 'status';
  if (state.tab === 'market' && !showMarket) state.tab = 'status';

  setAppContext('online', state.tab);
  app.innerHTML = `
    <header class="header">
      <div class="header-title">
        <span class="logo-hex small">\u2b21</span>
        <span class="header-name">${esc(d.serverName || 'VS Server')}</span>
        ${state.session ? `<span class="header-user">${esc(state.session.playerName)}${showAdmin ? ' \u2605' : ''}</span>` : ''}
      </div>
      <button class="btn-settings" id="btn-settings" aria-label="Configuración">\u2699</button>
    </header>

    <div class="status-banner status-online">
      <span class="status-dot pulse"></span>
      <span class="status-label">ONLINE</span>
    </div>

    <div class="tab-content" id="tab-content"></div>

    <nav class="tab-bar">
      <button class="tab-btn ${state.tab === 'status' ? 'active' : ''}" data-tab="status">\ud83d\udcca Estado</button>
      <button class="tab-btn ${state.tab === 'chat' ? 'active' : ''}" data-tab="chat">\ud83d\udcac Chat</button>
      ${showMarket ? `<button class="tab-btn ${state.tab === 'market' ? 'active' : ''}" data-tab="market">\ud83d\uded2 Tienda</button>` : ''}
      ${showAdmin ? `<button class="tab-btn ${state.tab === 'admin' ? 'active' : ''}" data-tab="admin">\ud83d\udd27 Admin</button>` : ''}
    </nav>

    <footer class="footer">
      <span id="ts-label" class="footer-ts">${formatRelTime(state.lastUpdate)}</span>
    </footer>
  `;

  // Wire tab clicks
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.getElementById('btn-settings')?.addEventListener('click', renderSetup);

  // Render active tab content
  const content = document.getElementById('tab-content');
  switch (state.tab) {
    case 'status': renderStatusTab(content, d); break;
    case 'chat':   renderChatTab(content);      break;
    case 'market': renderMarketTab(content);    break;
    case 'admin':  renderAdminTab(content, d);  break;
  }
}

// ── Status tab ────────────────────────────────────────────────────────────────

function renderStatusTab(container, d) {
  const playerItems = (d.playerList || []).map(p =>
    `<li class="player-item">
      <span class="player-dot"></span>
      <span class="player-name">${esc(p.name)}</span>
      ${p.ping >= 0 ? `<span class="player-ping">${p.ping}ms</span>` : ''}
    </li>`
  ).join('');

  const modItems = (d.modList || []).map(m =>
    `<li class="mod-item">
      <span class="mod-name">${esc(m.name || m.id)}</span>
      <span class="mod-version">${esc(m.version)}</span>
    </li>`
  ).join('');

  const panelsHtml = (state.panels || []).map(p => {
    const key = `panel:${p.key}`;
    const open = isPanelOpen(key, false);
    const sections = (p.sections || []).map(s => {
      const items = (s.items || []).map(it => {
        const text = esc(it.text || '');
        if (it.url) {
          return `<li class="panel-item"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${text}</a></li>`;
        }
        return `<li class="panel-item">${text}</li>`;
      }).join('');
      return `
        <div class="panel-section">
          ${s.title ? `<h4 class="panel-section-title">${esc(s.title)}</h4>` : ''}
          ${items ? `<ul class="panel-items">${items}</ul>` : '<p class="card-empty">Sin entradas.</p>'}
        </div>`;
    }).join('');
    const icon = p.key === 'eventos' ? '\ud83d\udcc5' : '\u2139\ufe0f';
    return `
      <section class="card">
        <details class="card-details" data-panel-key="${esc(key)}" ${open ? 'open' : ''}>
          <summary class="card-header">
            <span class="card-icon">${icon}</span>
            <span class="card-title">${esc(p.title || p.key)}</span>
          </summary>
          <div class="panel-body">
            ${sections || '<p class="card-empty">Panel vacío.</p>'}
          </div>
        </details>
      </section>`;
  }).join('');

  const playersKey = 'players';
  const playersOpen = isPanelOpen(playersKey, false);

  container.innerHTML = `
    <div class="cards">
      <section class="card">
        <details class="card-details" data-panel-key="${playersKey}" ${playersOpen ? 'open' : ''}>
          <summary class="card-header">
            <span class="card-icon">\ud83d\udc65</span>
            <span class="card-title">Jugadores</span>
            <span class="card-badge">${d.playersOnline || 0}</span>
          </summary>
          <div class="panel-body">
            ${d.playersOnline > 0
              ? `<ul class="player-list">${playerItems}</ul>`
              : `<p class="card-empty">Sin jugadores conectados</p>`}
          </div>
        </details>
      </section>

      <section class="card">
        <div class="card-header">
          <span class="card-icon">\ud83d\udce6</span>
          <span class="card-title">Mods activos</span>
          <span class="card-badge">${d.modsActive || 0}</span>
        </div>
        <p class="card-meta">Bridge v${esc(d.bridgeVersion || '?')}</p>
        ${modItems ? `
          <details class="mod-details">
            <summary class="mod-summary">Ver listado de mods</summary>
            <ul class="mod-list">${modItems}</ul>
          </details>` : ''}
      </section>

      ${panelsHtml}
    </div>
  `;

  container.querySelectorAll('details.card-details[data-panel-key]').forEach(el => {
    el.addEventListener('toggle', () => setPanelOpen(el.dataset.panelKey, el.open));
  });
}

// ── Chat tab ──────────────────────────────────────────────────────────────────

function renderChatTab(container) {
  const senderLabel = state.session
    ? `AxinM\u00f3vil\u00b7${state.session.playerName}`
    : 'Externo-AxinMovil';

  container.innerHTML = `
    <div class="chat-panel">
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-bar">
        <span class="chat-as">Como: ${esc(senderLabel)}</span>
        <div class="chat-send">
          <input id="chat-input" class="field-input chat-input" type="text"
            maxlength="200" placeholder="Escribe un mensaje\u2026"
            autocorrect="off" spellcheck="false">
          <button id="chat-send-btn" class="btn-primary btn-send">\u27a4</button>
        </div>
        <div id="chat-send-msg" class="chat-send-msg hidden"></div>
      </div>
    </div>
  `;

  renderChatMessages();

  const input = document.getElementById('chat-input');
  const btn = document.getElementById('chat-send-btn');

  async function doSend() {
    const text = input.value.trim();
    if (!text) return;
    btn.disabled = true;
    const r = await sendChat(text);
    btn.disabled = false;
    if (r.ok) {
      input.value = '';
      hideChatMsg();
    } else if (r.error === 'cooldown') {
      showChatMsg(`Espera ${r.waitSeconds}s entre mensajes.`);
    } else {
      showChatMsg(r.error || 'Error al enviar.');
    }
    input.focus();
  }

  btn.addEventListener('click', doSend);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
  input.focus();
}

function renderChatMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

  el.innerHTML = state.chatMessages.length === 0
    ? '<p class="chat-empty">Sin mensajes de chat a\u00fan.</p>'
    : state.chatMessages.map(m => {
        const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const cls = m.source === 'bridge' ? 'chat-msg bridge' : 'chat-msg';
        return `<div class="${cls}">
          <span class="chat-from">${esc(m.from)}</span>
          <span class="chat-text">${esc(m.text)}</span>
          <span class="chat-time">${time}</span>
        </div>`;
      }).join('');

  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

function showChatMsg(text) {
  const el = document.getElementById('chat-send-msg');
  if (el) { el.textContent = text; el.className = 'chat-send-msg'; }
}
function hideChatMsg() {
  const el = document.getElementById('chat-send-msg');
  if (el) el.className = 'chat-send-msg hidden';
}

// ─── Market tab ─────────────────────────────────────────────────────────────

function renderMarketTab(container) {
  if (!container) return;

  if (!state.session) {
    container.innerHTML = `
      <div class="cards">
        <section class="card">
          <p class="card-empty">Vincula tu cuenta para usar la tienda.</p>
        </section>
      </div>
    `;
    return;
  }

  const msg = state.marketMsg
    ? `<div class="setup-msg setup-msg--${state.marketMsg.type} market-msg">${esc(state.marketMsg.text)}</div>`
    : '';

  const offers = state.marketOffers || [];
  const items = offers.map(o => {
    const busy = state.marketBusy.has(o.id);
    const qty = o.buyQuantity || 1;
    const unitHint = o.pricePerUnit ? 'por unidad' : 'lote completo';
    return `
      <div class="market-offer">
        <div class="market-main">
          <span class="market-name">${esc(o.itemName || o.itemCode)}</span>
          <span class="market-qty">x${o.quantity}</span>
        </div>
        <div class="market-meta">
          <span>Precio: ${esc(o.priceText || '')}</span>
          <span>${esc(unitHint)}</span>
        </div>
        <div class="market-meta">
          <span>Vendedor: ${esc(o.sellerName || 'desconocido')}</span>
        </div>
        <button class="btn-primary btn-market-buy" data-offer="${esc(o.id)}" ${busy ? 'disabled' : ''}>
          ${busy ? 'Comprando...' : `Comprar ${qty}`}
        </button>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="cards">
      <section class="card">
        <div class="card-header">
          <span class="card-icon">\ud83d\uded2</span>
          <span class="card-title">Tienda</span>
          <button class="btn-sm btn-admin" id="market-refresh">Actualizar</button>
        </div>
        ${msg}
        ${state.marketLoading
          ? '<p class="card-empty">Cargando ofertas...</p>'
          : offers.length === 0
            ? '<p class="card-empty">No hay ofertas activas.</p>'
            : `<div class="market-list">${items}</div>`}
      </section>
    </div>
  `;

  document.getElementById('market-refresh')?.addEventListener('click', fetchMarketOffers);
  container.querySelectorAll('[data-offer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const offer = state.marketOffers.find(o => o.id === btn.dataset.offer);
      if (offer) buyMarketOffer(offer);
    });
  });
}

// ── Admin tab ─────────────────────────────────────────────────────────────────

function renderAdminTab(container, d) {
  if (!hasPerm('canUseAdminPanel')) {
    container.innerHTML = '<p class="card-empty">No tienes permisos de admin.</p>';
    return;
  }

  const players = d.playerList || [];
  const canKick = hasPerm('canKick');
  const canTp = hasPerm('canTpSpawn');
  const role = state.session?.role || 'linked';

  container.innerHTML = `
    <div class="cards">
      <section class="card">
        <div class="card-header">
          <span class="card-icon">\ud83d\udd12</span>
          <span class="card-title">Panel de administraci\u00f3n</span>
        </div>
        <div class="admin-info">
          <p>${esc(state.session.playerName)} <span class="admin-badge">${esc(role)}</span></p>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <span class="card-icon">\ud83d\udc65</span>
          <span class="card-title">Jugadores conectados</span>
          <span class="card-badge">${players.length}</span>
        </div>
        ${players.length === 0
          ? '<p class="card-empty">Sin jugadores.</p>'
          : `<div class="admin-players">
              ${players.map(p => `
                <div class="admin-player-row">
                  <span class="admin-pname">${esc(p.name)}</span>
                  <span class="admin-pping">${p.ping}ms</span>
                  ${canTp ? `<button class="btn-sm btn-admin" data-action="tp-spawn" data-name="${esc(p.name)}">Spawn</button>` : ''}
                  ${canKick ? `<button class="btn-sm btn-danger" data-action="kick" data-name="${esc(p.name)}">Kick</button>` : ''}
                </div>
              `).join('')}
            </div>`
        }
        <div id="admin-msg" class="setup-msg hidden"></div>
      </section>
    </div>
  `;

  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const name = btn.dataset.name;
      btn.disabled = true;

      let result;
      if (action === 'kick') {
        const reason = prompt(`Razón para expulsar a ${name}:`, 'Expulsado por admin');
        if (reason === null) { btn.disabled = false; return; }
        result = await adminKick(name, reason);
      } else if (action === 'tp-spawn') {
        result = await adminTpSpawn(name);
      }

      btn.disabled = false;
      if (result?.success) {
        showMsg('admin-msg', `${action === 'kick' ? 'Expulsado' : 'Teleportado'}: ${name}`, 'success');
      } else {
        if (handleSessionError(result?.error)) return;
        showMsg('admin-msg', result?.error || 'Error', 'error');
      }
    });
  });
}

// ── Offline ───────────────────────────────────────────────────────────────────

function renderOffline(reason) {
  const lastSeen = state.lastUpdate ? `\u00daltimo dato: ${formatRelTime(state.lastUpdate)}` : 'Sin datos previos';

  setAppContext('offline', 'offline');
  app.innerHTML = `
    <header class="header">
      <div class="header-title">
        <span class="logo-hex small">\u2b21</span>
        <span class="header-name">AXIN Bridge</span>
      </div>
      <button class="btn-settings" id="btn-settings" aria-label="Configuración">\u2699</button>
    </header>
    <div class="status-banner status-offline">
      <span class="status-dot"></span>
      <span class="status-label">OFFLINE</span>
    </div>
    <div class="offline-card">
      <p class="offline-reason">${esc(reason || 'No se puede conectar')}</p>
      <p class="offline-last">${lastSeen}</p>
      <button class="btn-retry" id="btn-retry">Reintentar</button>
    </div>
  `;

  document.getElementById('btn-settings')?.addEventListener('click', renderSetup);
  document.getElementById('btn-retry')?.addEventListener('click', () => { setState('loading'); fetchStatus(); });
}

// ── Error ─────────────────────────────────────────────────────────────────────

function renderAlert(message) {
  setAppContext('error', 'error');
  app.innerHTML = `
    <div class="alert-screen">
      <div class="alert-icon">\u26a0</div>
      <p class="alert-msg">${esc(message)}</p>
      <button class="btn-primary" id="btn-recfg">Reconfigurar</button>
    </div>
  `;
  document.getElementById('btn-recfg')?.addEventListener('click', renderSetup);
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatRelTime(date) {
  if (!date) return '';
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 5)  return 'Actualizado ahora';
  if (secs < 60) return `Actualizado hace ${secs}s`;
  return `Actualizado hace ${Math.round(secs / 60)}min`;
}

function updateTimestamp() {
  const el = document.getElementById('ts-label');
  if (el && state.lastUpdate) el.textContent = formatRelTime(state.lastUpdate);
}

function showMsg(elId, text, type) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = `setup-msg setup-msg--${type}`;
}

// ─── Service worker ───────────────────────────────────────────────────────────

function marketErrorText(error, data = {}) {
  const missing = (data.available || [])
    .map(x => `${x.amount}x ${x.item}`)
    .join(' + ');
  const map = {
    invalid_session: 'La sesion vinculada ya no es valida. Vuelve a vincular tu cuenta.',
    not_found: 'El backend cargado no tiene el endpoint de tienda. Reinicia el servidor y despliega la DLL nueva.',
    market_mod_unavailable: 'AxinMenuGUI o su MarketStore no estan disponibles en el servidor.',
    market_query_failed: 'El servidor no pudo leer las ofertas. Revisa el log de AxinBridge.',
    market_main_thread_timeout: 'El servidor tardo demasiado en leer la tienda. Intentalo de nuevo.',
    not_linked: 'Vincula tu cuenta para usar la tienda.',
    session_without_uid: 'La sesión no tiene UID válido. Vuelve a vincular tu cuenta.',
    offer_id_required: 'Oferta no válida.',
    offer_not_found: 'La oferta ya no existe.',
    offer_unavailable: 'La oferta ya no está disponible.',
    cannot_buy_own_offer: 'No puedes comprar tu propia oferta.',
    invalid_quantity: 'Cantidad no válida.',
    lot_price_requires_full_purchase: `Esta oferta se vende como lote completo (${data.requiredQuantity || '?'} unidades).`,
    not_enough_stock: `No queda suficiente stock. Disponible: ${data.requiredQuantity || 0}.`,
    invalid_offer_price: 'La oferta tiene un precio inválido.',
    bank_not_found: 'No tienes Bank registrado para pagar y recibir la compra.',
    no_bank_available: 'No tienes ningún Bank disponible.',
    bank_owner_mismatch: 'El Bank no coincide con tu UID vinculado.',
    bank_json_invalid: 'El JSON de tu Bank no es válido.',
    market_json_invalid: 'El JSON del mercado no es válido.',
    insufficient_funds: missing ? `Saldo insuficiente. Falta ${missing}.` : 'Saldo insuficiente.',
    write_failed: 'No se pudo guardar la compra. Inténtalo de nuevo.'
  };
  return map[error] || error || 'Error en la tienda.';
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ─── Arranque ─────────────────────────────────────────────────────────────────

state.session = loadSession();

if (hasConfig()) {
  setState('loading');
  startPolling();
} else {
  setState('setup');
}
