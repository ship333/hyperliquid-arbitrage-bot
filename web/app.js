// ===== Populate Active Opportunities from Backtest =====
function mapBacktestTradeToOpp(t){
  // Normalize various possible field names from backtest payload
  const pair = t.pair || t.asset_pair || t.symbol_pair || t.route || 'UNKNOWN/UNKNOWN';
  const route = t.route || t.route_id || t.path || pair;
  const chain_name = t.chain_name || t.chain || 'hyperevm-mainnet';
  const spread_bps = Number(t.spread_bps ?? t.spread_bp ?? t.spread ?? 0);
  const liquidity_usd = Number(t.liquidity_usd ?? t.liq_usd ?? t.liquidity ?? 0);
  const est_profit_usd = Number(t.est_profit_usd ?? t.net_usd ?? t.profit_usd ?? 0);
  const confidence = Number(t.confidence ?? t.score ?? 0);
  const est_gas_usd = Number(t.est_gas_usd ?? t.gas_usd ?? 0);
  const ts = t.ts || t.time || new Date().toISOString();
  return { pair, route, chain_name, spread_bps, liquidity_usd, est_profit_usd, confidence, est_gas_usd, ts };
}

function clearActiveOpps(){
  const tbody = document.getElementById('opp-tbody');
  if (tbody) tbody.innerHTML = '';
  if (typeof oppsByKey !== 'undefined' && oppsByKey?.clear) try { oppsByKey.clear(); } catch {}
}

function populateFromBacktest(){
  const trades = Array.isArray(lastBacktestTopTrades) ? lastBacktestTopTrades : [];
  if (!trades.length) return;
  clearActiveOpps();
  trades.map(mapBacktestTradeToOpp).forEach(o=> upsertOppRow(o));
}
let BACKEND_BASE = 'http://127.0.0.1:9011';
try { const saved = localStorage.getItem('backend_base'); if (saved) BACKEND_BASE = saved; } catch {}
const backendInput = document.getElementById('backend-input');
if (backendInput) backendInput.value = BACKEND_BASE;

let ws = null;
let wsTimer = null;
let reconnectDelayMs = 1000;
const wsStatus = document.getElementById('ws-status');
// Opp list state (static rows, dynamic cells)
const oppsByKey = new Map(); // key -> { data, tr, cells }

// Backend health state
let backendHealthy = false;
let last404At = 0;
let detectingBackend = false;
let backendHealthTimer = null;
let prevBackendHealthy = null;

function setBackendBase(next){
  if (!next || BACKEND_BASE === next) return;
  const prev = BACKEND_BASE;
  BACKEND_BASE = next.replace(/\/$/, '');
  try { localStorage.setItem('backend_base', BACKEND_BASE); } catch {}
  console.log('Backend base changed', { prev, next: BACKEND_BASE });
  if (backendInput) backendInput.value = BACKEND_BASE;
  try { ws?.close(); } catch {}
  wsConnect();
  // Refresh strategies to reflect new backend
  initStrategiesUI();
}

async function checkBackendOnce(base){
  try {
    const url = base.replace(/\/$/, '') + '/api/strategies';
    const res = await fetch(url, { method:'GET' });
    if (res.ok) return true;
  } catch {}
  try {
    const res2 = await fetch(base.replace(/\/$/, '') + '/openapi.json', { method:'GET' });
    if (res2.ok) return true;
  } catch {}
  return false;
}

async function detectBackendBase(){
  if (detectingBackend) return;
  detectingBackend = true;
  const candidates = [
    BACKEND_BASE,
    'http://127.0.0.1:9011',
    'http://localhost:9011',
    'http://127.0.0.1:8000',
    'http://localhost:8000',
  ].filter(Boolean);
  for (const cand of candidates){
    // Skip duplicates
    if (!cand) continue;
    const ok = await checkBackendOnce(cand);
    if (ok){ backendHealthy = true; setBackendBase(cand); detectingBackend = false; return; }
  }
  backendHealthy = false;
  detectingBackend = false;
  updateBackendStatusIndicator();
}

// ================ Goldsky (Pool History) ================
async function fetchGoldskyPool(){
  try {
    const input = document.getElementById('goldsky-pool-id');
    const outDiv = document.getElementById('goldsky-output');
    const poolId = (input?.value || '').trim();
    if (!poolId){ showError('Goldsky: pool id is required'); return; }

    // Small backoff if we just saw 404s
    const now = Date.now();
    if (now - last404At < 2000) { await detectBackendBase(); }

    const url = `${BACKEND_BASE}/api/goldsky/pools/${encodeURIComponent(poolId)}/history?limit=1000`;
    const res = await fetch(url).catch(() => ({ ok:false, status:0, json: async()=>({}) }));
    if (!res.ok){
      if (res.status === 404){ last404At = Date.now(); detectBackendBase(); scheduleHealthCheck(); }
      showError(`Goldsky fetch failed (HTTP ${res.status||0})`);
      return;
    }
    const data = await res.json();
    if (data && data.error){
      // Backend surfaces useful context: mode/provider_url
      showError('Goldsky backend error', { error: data.error, mode: data.mode, provider_url: data.provider_url });
      return;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    toast(`Goldsky: got ${items.length} snapshots for pool ${poolId}`);
    if (outDiv){
      try { outDiv.textContent = JSON.stringify(items.slice(0, 5), null, 2); } catch {}
    }
    console.log('Goldsky pool snapshots', { poolId, count: items.length, samples: items.slice(0,5) });
    backendHealthy = true; updateBackendStatusIndicator();
    try { localStorage.setItem('backend_base', BACKEND_BASE); } catch {}
  } catch (e) {
    showError('Goldsky fetch exception', e);
    backendHealthy = false; scheduleHealthCheck();
  }
}

function updateBackendStatusIndicator(){
  const el = document.getElementById('backend-status');
  if (!el) return;
  el.textContent = backendHealthy ? 'Backend: OK' : 'Backend: Unreachable';
  el.className = backendHealthy ? 'status-green' : 'status-red';
  // Toggle controls
  setControlsEnabled(!!backendHealthy);
  if (prevBackendHealthy !== null && prevBackendHealthy !== backendHealthy) {
    toast(backendHealthy ? 'Connected to backend' : 'Backend unreachable');
  }
  prevBackendHealthy = backendHealthy;
}

async function scheduleHealthCheck(){
  updateBackendStatusIndicator();
  if (backendHealthy) { if (backendHealthTimer) { clearTimeout(backendHealthTimer); backendHealthTimer = null; } return; }
  if (backendHealthTimer) return;
  backendHealthTimer = setTimeout(async () => {
    await detectBackendBase();
    backendHealthTimer = null; // allow next loop if still unhealthy
    scheduleHealthCheck();
  }, 5000);
}

// ================ Backend Health & Trade Helpers ================
async function pingHealth(){
  try {
    const res = await fetch(`${BACKEND_BASE}/api/health`, { method:'GET' });
    if (!res.ok) { backendHealthy = false; updateBackendStatusIndicator(); showError('Health check failed', { status: res.status }); return null; }
    const data = await res.json();
    backendHealthy = true; updateBackendStatusIndicator();
    toast('Health: OK');
    console.debug('Health payload', data);
    return data;
  } catch (e) {
    backendHealthy = false; updateBackendStatusIndicator();
    showError('Health check exception', e);
    return null;
  }
}

async function tradeQuote(amount_in, slippage_bps=50){
  const body = { amount_in: Number(amount_in||0), slippage_bps: Number(slippage_bps||0) };
  try {
    const res = await fetch(`${BACKEND_BASE}/api/trade/quote`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showError('Quote failed', data); return null; }
    toast(`Quote: out_min=${data.amount_out_min}`);
    return data;
  } catch (e) { showError('Quote exception', e); return null; }
}

async function tradeSimulate(opts){
  const body = Object.assign({ amount_in:0, slippage_bps:50, gas_price_wei:0, gas_limit:250000, native_price_usd:0 }, opts||{});
  try {
    const res = await fetch(`${BACKEND_BASE}/api/trade/simulate`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showError('Simulate failed', data); return null; }
    toast(`Simulated: net_usd=${Number(data.net_value_usd||0).toFixed(4)} gas_usd=${Number(data.gas_cost_usd||0).toFixed(4)}`);
    return data;
  } catch (e) { showError('Simulate exception', e); return null; }
}

async function getTradeLimits(){
  try {
    const res = await fetch(`${BACKEND_BASE}/api/trade/limits`, { method:'GET' });
    const data = await res.json();
    if (!res.ok) { showError('Get limits failed', data); return null; }
    toast('Fetched trade limits');
    return data;
  } catch (e) { showError('Get limits exception', e); return null; }
}

async function setTradeLimits(lims){
  try {
    const res = await fetch(`${BACKEND_BASE}/api/trade/limits`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(lims||{}) });
    const data = await res.json();
    if (!res.ok) { showError('Set limits failed', data); return null; }
    toast('Updated trade limits');
    return data;
  } catch (e) { showError('Set limits exception', e); return null; }
}

// Expose helpers for quick manual testing in console
try { Object.assign(window, { pingHealth, tradeQuote, tradeSimulate, getTradeLimits, setTradeLimits }); } catch {}

async function getCircuit(){
  try {
    const res = await fetch(`${BACKEND_BASE}/api/trade/circuit`, { method:'GET' });
    const data = await res.json();
    if (!res.ok) { showError('Get circuit failed', data); return null; }
    toast(`Circuit: ${data.enabled ? 'ENABLED' : 'DISABLED'}`);
    return data;
  } catch (e) { showError('Get circuit exception', e); return null; }
}

async function setCircuit(enabled){
  try {
    const res = await fetch(`${BACKEND_BASE}/api/trade/circuit`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: !!enabled }) });
    const data = await res.json();
    if (!res.ok) { showError('Set circuit failed', data); return null; }
    toast(`Circuit set to ${data.enabled ? 'ENABLED' : 'DISABLED'}`);
    return data;
  } catch (e) { showError('Set circuit exception', e); return null; }
}

async function startLiveArb(params){
  try {
    const res = await fetch(`${BACKEND_BASE}/api/arb/live/start`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(params||{}) });
    const data = await res.json();
    if (!res.ok) { showError('Start live arb failed', data); return null; }
    toast('Live arbitrage loop started');
    return data;
  } catch (e) { showError('Start live arb exception', e); return null; }
}

async function stopLiveArb(){
  try {
    const res = await fetch(`${BACKEND_BASE}/api/arb/live/stop`, { method:'POST' });
    const data = await res.json();
    if (!res.ok) { showError('Stop live arb failed', data); return null; }
    toast('Live arbitrage loop stopped');
    return data;
  } catch (e) { showError('Stop live arb exception', e); return null; }
}

try { Object.assign(window, { getCircuit, setCircuit, startLiveArb, stopLiveArb }); } catch {}

function setControlsEnabled(enabled){
  const ids = [
    'run-backtest','run-sweep','run-strategy',
    'start-bot','emergency-stop','save-strategy','upload-strategy',
    'refresh-strategies','gas-refresh','btn-gas-price'
  ];
  ids.forEach(id=>{ const el=document.getElementById(id); if (el) el.disabled = !enabled; });
}

// UI helpers
function truncateMiddle(str, head=10, tail=6){
  if (!str) return '';
  const s = String(str);
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
function copyToClipboard(text){
  try { navigator.clipboard.writeText(String(text)); toast('Copied'); } catch { /* ignore */ }
}
function makeCopyBtn(text){
  const b = document.createElement('button'); b.className='btn-icon'; b.textContent='Copy';
  b.addEventListener('click', (e)=>{ e.stopPropagation(); copyToClipboard(text); });
  return b;
}
function explorerUrl(chain, addr){
  const a = (addr||'').toLowerCase(); if (!a.startsWith('0x') || a.length < 10) return null;
  const c = (chain||'').toLowerCase();
  // basic mapping; extend as needed
  if (c.includes('mainnet') || c.includes('hyperevm')) return `https://etherscan.io/address/${a}`;
  if (c.includes('sepolia')) return `https://sepolia.etherscan.io/address/${a}`;
  return null;
}
function renderIdInline(value, opts={}){
  const { chain, narrow=false } = opts;
  const wrap = document.createElement('span');
  const val = String(value||'');
  const short = truncateMiddle(val);
  const span = document.createElement('span'); span.className = `mono truncate ${narrow?'truncate-narrow':''}`; span.title = val; span.textContent = short;
  wrap.appendChild(span);
  if (val.startsWith('0x')) wrap.appendChild(makeCopyBtn(val));
  const url = explorerUrl(chain, val);
  if (url){ const a = document.createElement('a'); a.href=url; a.target='_blank'; a.rel='noopener'; a.className='btn-icon'; a.textContent='Open'; wrap.appendChild(a); }
  return wrap;
}
function routeBadge(type){
  const span = document.createElement('span');
  const t = (type||'').toLowerCase();
  const map = { router:'badge-route-router', amm:'badge-route-amm', rfq:'badge-route-rfq' };
  span.className = `badge ${map[t]||''}`; span.textContent = t || '-';
  return span;
}

function setCurrentStrategiesDisplay(text){
  try {
    const el = document.getElementById('current-strategies');
    if (el) el.textContent = text || '-';
  } catch {}
}

// ===== Backtest Results Rendering =====
function renderBacktestError(title, details){
  const div = document.getElementById('backtest-results'); if (!div) return;
  div.innerHTML = '';
  const alert = document.createElement('div'); alert.className = 'alert alert-error';
  const head = document.createElement('div'); head.className='alert-title'; head.textContent = title || 'Error';
  const body = document.createElement('div'); body.className='alert-body'; body.textContent = details || '';
  const actions = document.createElement('div'); actions.className='alert-actions';
  const retry = document.createElement('button'); retry.className='btn-sm'; retry.textContent='Retry'; retry.addEventListener('click', runBacktest);
  const toggle = document.createElement('button'); toggle.className='btn-sm'; toggle.textContent='Details';
  let shown = false; toggle.addEventListener('click', ()=>{ shown=!shown; body.style.display = shown?'block':'none'; }); body.style.display='none';
  actions.append(retry, toggle);
  alert.append(head, body, actions);
  div.appendChild(alert);
}

function makeStatCard(label, value, sub){
  const card = document.createElement('div'); card.className='card stat-card';
  const v = document.createElement('div'); v.className='stat-value'; v.textContent = value;
  const l = document.createElement('div'); l.className='stat-label'; l.textContent = label;
  card.append(v, l);
  if (sub){ const s=document.createElement('div'); s.className='stat-sub'; s.textContent=sub; card.appendChild(s); }
  return card;
}

function renderBacktestSummary(r){
  const div = document.getElementById('backtest-results'); if (!div) return; div.innerHTML='';
  const grid = document.createElement('div'); grid.className='card-grid';
  grid.append(
    makeStatCard('Window', `${r.window_minutes||0}m`),
    makeStatCard('Candidates', String(r.total_candidates||0)),
    makeStatCard('Selected', String(r.selected||0)),
    makeStatCard('Winrate', `${((Number(r.winrate||0))*100).toFixed(2)}%`),
    makeStatCard('Gross P&L', `$${Number(r.total_gross_profit||0).toFixed(2)}`),
    makeStatCard('Net P&L', `$${Number(r.total_net_profit||0).toFixed(2)}`),
    makeStatCard('Avg Spread', `${Number(r.avg_spread_bps||0).toFixed(2)} bps`),
    makeStatCard('Avg Liquidity', `$${Number(r.avg_liquidity_usd||0).toLocaleString()}`),
    makeStatCard('Avg Gas', `$${Number(r.avg_gas_usd||0).toFixed(4)}`),
    makeStatCard('Avg Profit/Gas', `${Number(r.avg_profit_per_gas||0).toFixed(4)}`),
    makeStatCard('Trades', String(r.trades_count||0)),
    makeStatCard('Max Drawdown', `$${Number(r.max_drawdown_usd||0).toFixed(2)}`),
    makeStatCard('Sharpe Proxy', r.sharpe_proxy==null?'inf':Number(r.sharpe_proxy).toFixed(4)),
    makeStatCard('Mean Trade Net', `$${Number(r.mean_trade_net_usd||0).toFixed(4)}`),
    makeStatCard('Std Trade Net', `$${Number(r.std_trade_net_usd||0).toFixed(4)}`),
  );
  div.appendChild(grid);
}
let oppPaused = false;
let oppSortKey = 'est_profit_usd';
let oppSortDir = 'desc';
let countdownTimer = null;
const pinnedKeys = new Set();

// Gas price cache (for net profit calculations)
let gasCache = { ts: 0, wei: null, usd: null };

// ===== Backtest/Sweep History =====
let backtestHistory = [];
let historyAutoId = 1;
function loadHistory(){
  try {
    const raw = localStorage.getItem('backtest_history');
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) { backtestHistory = arr; historyAutoId = (Math.max(0, ...arr.map(x=>x.id||0))+1)||1; }
    renderHistory();
  } catch {}
}
function saveHistory(){
  try { localStorage.setItem('backtest_history', JSON.stringify(backtestHistory.slice(-50))); } catch {}
}
function addHistory(rec){
  const id = historyAutoId++;
  const startedAt = rec.startedAt || new Date().toISOString();
  const entry = { id, type: rec.type, strategy: rec.strategy, note: rec.note||'', status: rec.status||'running', startedAt, finishedAt: null, summary: '' };
  backtestHistory.push(entry);
  renderHistory(); saveHistory();
  return id;
}
function updateHistory(id, patch){
  const idx = backtestHistory.findIndex(e=>e.id===id);
  if (idx>=0){ backtestHistory[idx] = { ...backtestHistory[idx], ...patch }; renderHistory(); saveHistory(); }
}
function renderHistory(){
  try {
    const ul = document.getElementById('backtest-history'); if (!ul) return;
    ul.innerHTML = '';
    const items = backtestHistory.slice(-10).slice().reverse();
    for (const e of items){
      const li = document.createElement('li');
      const st = e.status === 'success' ? '✅' : e.status === 'failed' ? '❌' : '⏳';
      const when = new Date(e.startedAt).toLocaleString();
      const done = e.finishedAt ? ` → ${new Date(e.finishedAt).toLocaleTimeString()}` : '';
      li.textContent = `${st} [${e.type}] ${e.strategy} ${e.note?'- '+e.note:''} @ ${when}${done} ${e.summary?'- '+e.summary:''}`;
      ul.appendChild(li);
    }
  } catch {}
}
const clearHistBtn = document.getElementById('clear-backtest-history');
if (clearHistBtn) clearHistBtn.addEventListener('click', ()=>{ backtestHistory = []; saveHistory(); renderHistory(); });
async function fetchGasIfStale(force=false){
  try {
    const now = Date.now();
    if (now - gasCache.ts < 10000 && gasCache.usd != null) return gasCache; // 10s cache
    // If we just saw a 404 recently, backoff to avoid spam
    if (now - last404At < 5000) return gasCache;
    if (!backendHealthy) { scheduleHealthCheck(); return gasCache; }
    // Prefer chain from UI selector if available; fallback to a sensible default
    const chainSel = document.getElementById('gas-chain');
    const chain = (chainSel?.value || 'hyperevm-mainnet').trim();
    const url = `${BACKEND_BASE}/api/market/gas-price?chain=${encodeURIComponent(chain)}`;
    const res = await fetch(url).catch(()=>( { ok:false, status:0, json: async()=>({}) }));
    if (!res.ok) {
      if (res.status === 404) { last404At = now; detectBackendBase(); scheduleHealthCheck(); }
      return gasCache;
    }
    const data = await res.json();
    gasCache = { ts: now, wei: Number(data.gas_price_wei||0), usd: Number(data.gas_price_usd||0) };
    backendHealthy = true; updateBackendStatusIndicator();
    try { localStorage.setItem('backend_base', BACKEND_BASE); } catch {}
  } catch { /* ignore */ }
  return gasCache;
}

function wsSetStatus(text, ok) {
  if (!wsStatus) return;
  wsStatus.textContent = `WS: ${text}`;
  wsStatus.style.background = ok ? '#d1fae5' : '#fee2e2';
  wsStatus.style.color = '#111827';
}

function wsConnect() {
  try {
    const wsUrl = BACKEND_BASE.replace('http', 'ws') + '/ws';
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { wsSetStatus('connected', true); reconnectDelayMs = 1000; };
    ws.onclose = () => {
      wsSetStatus('disconnected', false);
      if (wsTimer) clearTimeout(wsTimer);
      wsTimer = setTimeout(wsConnect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
    };
    ws.onerror = () => { wsSetStatus('error', false); };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateDashboard(data);
      } catch (e) { showError('WS parse error'); }
    };
  } catch (e) {
    showError('WS connect error');
  }
}
wsConnect();
loadHistory();

function updateDashboard(data) {
  const pnlEl = document.getElementById('daily-pnl');
  const pnl = Number(data.pnl || 0);
  pnlEl.innerHTML = `Daily P&L: <span class="${pnl > 0 ? 'status-green' : 'status-red'}">${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)}</span>`;

  // Engine + Config preview
  const eng = data.engine || {};
  const cfg = data.config || {};
  const chainName = cfg.chain_name || '-';
  const engStatus = eng.status || '-';
  const cfgDiv = document.getElementById('config-preview');
  const engDiv = document.getElementById('engine-status');
  const chainDiv = document.getElementById('chain-name');
  if (engDiv) engDiv.textContent = `Engine: ${engStatus}`;
  if (chainDiv) chainDiv.textContent = `Chain: ${chainName}`;
  if (cfgDiv) cfgDiv.textContent = JSON.stringify(cfg, null, 2);

  // Populate route types and asset overrides from live config (non-destructive)
  try {
    if (cfg.allowed_route_types) setAllowedRouteTypes(cfg.allowed_route_types);
    if (cfg.asset_overrides) maybePopulateAssetOverrides(cfg.asset_overrides);
  } catch {}

  // Opportunities incremental update
  const opps = Array.isArray(data.opportunities) ? data.opportunities : [];
  if (!oppPaused && opps.length) processOpps(opps);
}

const riskLevelEl = document.getElementById('risk-level');
if (riskLevelEl) {
  riskLevelEl.addEventListener('input', (e) => {
    const vEl = document.getElementById('risk-value');
    if (vEl) vEl.textContent = e.target.value;
  });
}

const startBotBtn = document.getElementById('start-bot');
if (startBotBtn) {
  startBotBtn.addEventListener('click', async () => {
    const payload = buildRunPayload();
    try {
      const useNumpyEl = document.getElementById('bt-use-numpy');
      const gasBudgetEl = document.getElementById('bt-gas-budget');
      if (useNumpyEl && useNumpyEl.checked) payload.use_numpy_eval = true;
      if (gasBudgetEl) {
        const gb = parseFloat(gasBudgetEl.value || '');
        if (!Number.isNaN(gb) && gb > 0) payload.gas_budget_usd = gb;
      }
      const res = await fetch(`${BACKEND_BASE}/api/bot/start`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      // start countdown (prefer end_ts from backend if provided)
      const endTs = data.end_ts ? Date.parse(data.end_ts) : Date.now() + (Number(payload.run_minutes||60)*60*1000);
      startCountdown(endTs);
      toast('Bot start requested');
    } catch (e) { showError('Failed to start bot'); }
  });
}

const emergStopBtn = document.getElementById('emergency-stop');
if (emergStopBtn) {
  emergStopBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to emergency stop the bot?')) {
      const res = await fetch(`${BACKEND_BASE}/api/bot/emergency-stop`, { method: 'POST' }).catch(e=>({ ok:false, json: async()=>({error:String(e)}) }));
      console.log(await res.json());
      stopCountdown();
    }
  });
}

const updateCfgBtn = document.getElementById('update-config');
if (updateCfgBtn) {
  updateCfgBtn.addEventListener('click', async () => {
    const cfg = buildConfig();
    try {
      const res = await fetch(`${BACKEND_BASE}/api/config/save`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(cfg) });
      const data = await res.json();
      toast('Config saved');
    } catch (e) { showError('Failed to save config'); }
  });
}

// ================= Strategies =================
async function fetchStrategies() {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/strategies`).catch(()=>({ ok:false, status:0, json: async()=>({}) }));
    if (!res.ok) {
      // Attempt backend auto-detect on 404 to reduce repeated errors
      if (res.status === 404) { last404At = Date.now(); detectBackendBase(); scheduleHealthCheck(); }
      if (!backendHealthy) scheduleHealthCheck();
      return {};
    }
    backendHealthy = true; updateBackendStatusIndicator();
    try { localStorage.setItem('backend_base', BACKEND_BASE); } catch {}
    return await res.json();
  } catch (e) {
    console.warn('fetchStrategies error', e);
    backendHealthy = false; scheduleHealthCheck();
    return {};
  }
}

function populateStrategySelects(strats) {
  const sel1 = document.getElementById('strategy-select');
  const sel2 = document.getElementById('backtest-strategy');
  if (!sel1 || !sel2) return;
  const names = Object.keys(strats || {});
  sel1.innerHTML = '';
  sel2.innerHTML = '';
  names.forEach((n) => {
    const o1 = document.createElement('option'); o1.value = n; o1.textContent = n; sel1.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = n; o2.textContent = n; sel2.appendChild(o2);
  });
}

async function initStrategiesUI() {
  const strats = await fetchStrategies();
  populateStrategySelects(strats);
  // Populate run-strategy select too
  const runSel = document.getElementById('run-strategy-select');
  if (runSel) {
    runSel.innerHTML = '';
    Object.keys(strats||{}).forEach((n)=>{
      const o=document.createElement('option'); o.value=n; o.textContent=n; runSel.appendChild(o);
    });
  }
}

const saveBtn = document.getElementById('save-strategy');
if (saveBtn) {
  saveBtn.addEventListener('click', async () => {
    const name = document.getElementById('strategy-name').value.trim() || 'baseline';
    let params = {};
    try {
      const raw = document.getElementById('strategy-params').value || '{}';
      params = JSON.parse(raw);
    } catch (e) {
      alert('Params must be valid JSON');
      return;
    }
    const res = await fetch(`${BACKEND_BASE}/api/strategies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, params })
    }).catch(()=>({ ok:false }));
    if (res.ok) {
      const data = await res.json();
      populateStrategySelects(data.strategies || {});
      alert('Strategy saved');
    } else {
      alert('Failed to save strategy');
    }
  });
}

const loadBtn = document.getElementById('load-strategy');
if (loadBtn) {
  loadBtn.addEventListener('click', async () => {
    const name = document.getElementById('strategy-select').value;
    const strats = await fetchStrategies();
    const params = strats[name] || {};
    document.getElementById('strategy-name').value = name;
    document.getElementById('strategy-params').value = JSON.stringify(params, null, 2);
  });
}

// ================= Backtesting =================
async function runBacktest() {
  const strategy = document.getElementById('backtest-strategy').value;
  const windowMin = Number(document.getElementById('backtest-window').value || 60);
  setCurrentStrategiesDisplay(strategy);
  const hId = addHistory({ type: 'backtest', strategy, note: `window=${windowMin}m` });
  // Optional filters
  const assetsStr = (document.getElementById('filter-assets').value || '').trim();
  const routesStr = (document.getElementById('filter-routes').value || '').trim();
  const chainsStr = (document.getElementById('filter-chains').value || '').trim();
  const minConfStr = (document.getElementById('filter-min-confidence')?.value || '').trim();
  const excludeContainsStr = (document.getElementById('filter-exclude-routes')?.value || '').trim();
  const filters = {};
  if (assetsStr) filters.assets = assetsStr.split(',').map(s=>s.trim()).filter(Boolean);
  if (routesStr) filters.routes = routesStr.split(',').map(s=>s.trim()).filter(Boolean);
  if (chainsStr) filters.chain_names = chainsStr.split(',').map(s=>s.trim()).filter(Boolean);
  if (minConfStr) { const mc = Number(minConfStr); if (!Number.isNaN(mc)) filters.min_confidence = mc; }
  if (excludeContainsStr) filters.exclude_routes_contains = excludeContainsStr.split(',').map(s=>s.trim()).filter(Boolean);

  // Param overrides
  let params = null;
  const useOverride = document.getElementById('override-params').checked;
  if (useOverride) {
    try {
      const raw = document.getElementById('override-json').value || '{}';
      params = JSON.parse(raw);
    } catch (e) {
      alert('Override params must be valid JSON');
      return;
    }
  }
  // Merge filters into params if present
  if (params) Object.assign(params, filters);

  const body = { strategy_name: strategy, window_minutes: windowMin };
  if (params) body.params = params; else if (Object.keys(filters).length) body.params = filters;
  // Merge HFT params if any
  const hft = readHftParams();
  if (hft) {
    body.params = { ...(body.params||{}), ...hft };
  }
  // Request top trades back from backend for populating Active Opps
  const topOpps = Math.max(1, Math.min(200, Number(document.getElementById('backtest-top-opps')?.value || 50)));
  body.include_trades = true;
  body.top_n_opps = topOpps;

  // Decide whether to fetch plots or plain metrics
  const plotsEnabled = !!document.getElementById('plots-enable')?.checked;
  let r;
  if (plotsEnabled) {
    const types = Array.from(document.querySelectorAll('.plot-type'))
      .filter((el)=> el.checked)
      .map((el)=> el.value);
    const topnEl = document.getElementById('plots-topn');
    const topn = Math.max(1, Math.min(10, Number(topnEl?.value || 10)));
    const bodyPlots = { ...body, plots: types, top_n: topn };
    const res = await fetch(`${BACKEND_BASE}/api/backtest/run_plots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyPlots)
    }).catch(()=>({ ok:false }));
    if (!res.ok) {
      renderBacktestError('Backtest (plots) failed', 'The backend returned a non-OK response while generating plots.');
      updateHistory(hId, { status:'failed', finishedAt: new Date().toISOString(), summary: 'HTTP error' });
      return;
    }
    const data = await res.json();
    r = data.metrics || {};
    lastBacktestTopTrades = Array.isArray(r.top_trades) ? r.top_trades : [];
    // Render images
    const imgDiv = document.getElementById('backtest-plots');
    if (imgDiv) {
      imgDiv.innerHTML = '';
      const imgs = data.images || {};
      Object.entries(imgs).forEach(([name, src])=>{
        const wrap = document.createElement('div');
        const title = document.createElement('div'); title.textContent = name; title.style.fontWeight = '600'; title.style.marginBottom = '4px';
        const img = document.createElement('img'); img.src = src; img.style.maxWidth='100%'; img.loading='lazy';
        wrap.appendChild(title); wrap.appendChild(img);
        imgDiv.appendChild(wrap);
      });
    }
  } else {
    const res = await fetch(`${BACKEND_BASE}/api/backtest/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).catch(()=>({ ok:false }));
    if (!res.ok) {
      renderBacktestError('Backtest failed', 'The backend returned a non-OK response. Try adjusting parameters and retry.');
      updateHistory(hId, { status:'failed', finishedAt: new Date().toISOString(), summary: 'HTTP error' });
      return;
    }
    r = await res.json();
    lastBacktestTopTrades = Array.isArray(r.top_trades) ? r.top_trades : [];
    const imgDiv = document.getElementById('backtest-plots'); if (imgDiv) imgDiv.innerHTML = '';
  }
  updateHistory(hId, { status:'success', finishedAt: new Date().toISOString(), summary: `net=$${Number(r.total_net_profit||0).toFixed(2)}, trades=${Number(r.trades_count||0)}` });
  renderBacktestSummary(r);
  // Also push latest backtest trades into Active Opportunities
  try { populateFromBacktest(); } catch {}

  // Render breakdowns if present
  try {
    const assetDiv = document.getElementById('breakdown-by-asset');
    const routeDiv = document.getElementById('breakdown-by-route');
    if (assetDiv) assetDiv.innerHTML = '';
    if (routeDiv) routeDiv.innerHTML = '';
    if (r.by_asset && typeof r.by_asset === 'object' && assetDiv) {
      const table = document.createElement('table'); table.className = 'grid';
      const thead = document.createElement('thead'); thead.innerHTML = `<tr><th>Asset</th><th>Count</th><th>Total Net ($)</th><th>Winrate</th></tr>`; table.appendChild(thead);
      const tbody = document.createElement('tbody');
      Object.entries(r.by_asset).forEach(([asset, m])=>{
        const tr = document.createElement('tr');
        const tdA = document.createElement('td'); tdA.textContent = asset;
        const tdC = document.createElement('td'); tdC.textContent = String(m.count||0);
        const tdN = document.createElement('td'); tdN.textContent = `$${Number(m.total_net_usd||0).toFixed(2)}`;
        const tdW = document.createElement('td'); tdW.textContent = `${(Number(m.winrate||0)*100).toFixed(2)}%`;
        tr.append(tdA, tdC, tdN, tdW); tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      const title = document.createElement('h4'); title.textContent = 'Breakdown by Asset';
      assetDiv.appendChild(title); assetDiv.appendChild(table);
    }
    if (r.by_route && typeof r.by_route === 'object' && routeDiv) {
      const table = document.createElement('table'); table.className = 'grid';
      const thead = document.createElement('thead'); thead.innerHTML = `<tr><th>Route</th><th>Count</th><th>Total Net ($)</th><th>Winrate</th></tr>`; table.appendChild(thead);
      const tbody = document.createElement('tbody');
      Object.entries(r.by_route).forEach(([route, m])=>{
        const tr = document.createElement('tr');
        const tdA = document.createElement('td'); tdA.textContent = route;
        const tdC = document.createElement('td'); tdC.textContent = String(m.count||0);
        const tdN = document.createElement('td'); tdN.textContent = `$${Number(m.total_net_usd||0).toFixed(2)}`;
        const tdW = document.createElement('td'); tdW.textContent = `${(Number(m.winrate||0)*100).toFixed(2)}%`;
        tr.append(tdA, tdC, tdN, tdW); tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      const title = document.createElement('h4'); title.textContent = 'Breakdown by Route';
      routeDiv.appendChild(title); routeDiv.appendChild(table);
    }
  } catch {}
}

// ================= Backtesting Sweep =================
function toast(msg){
  try {
    if (window.showToast) window.showToast(msg); else console.log(msg);
  } catch { console.log(msg); }
}
function readHftParams(){
  const getNum = (id) => {
    const el = document.getElementById(id); if (!el) return null; const v = el.value;
    if (v === '' || v == null) return null; const n = Number(v); return Number.isNaN(n) ? null : n;
  };
  const m = {};
  const map = [
    ['base_fee_gwei','hft-base-fee'],
    ['priority_tip_gwei','hft-tip'],
    ['gas_limit','hft-gas-limit'],
    ['native_usd','hft-native-usd'],
    ['max_gas_usd_per_trade','hft-max-gas'],
    ['decision_to_submit_ms','hft-lat-ms'],
    ['submit_to_inclusion_blocks','hft-lat-blocks'],
    ['seconds_per_block','hft-lat-spb'],
    ['k_vol','hft-kvol'],
    ['notional_beta','hft-beta'],
    ['fail_prob','hft-fail-prob'],
    ['lp_fees_bps','hft-lp-fees'],
    ['router_fees_bps','hft-router-fees'],
    ['extra_usd','hft-extra-usd'],
    ['fees_bps_extra','hft-fees-extra'],
    ['slip_cap_bps','hft-slip-cap'],
    ['notional_cap_usd','hft-notional-cap'],
  ];
  for (const [k,id] of map){ const n = getNum(id); if (n != null) m[k] = n; }
  return Object.keys(m).length ? m : null;
}
function parseNumList(str){
  return (str||'').split(',').map(s=>Number(s.trim())).filter(v=>!Number.isNaN(v));
}

function* product(arrays){
  if (!arrays.length) { yield []; return; }
  const [head, ...tail] = arrays;
  for (const h of head){
    for (const rest of product(tail)) yield [h, ...rest];
  }
}

let lastSweepBest = null;
let lastBacktestTopTrades = [];

async function runSweep(){
  const strategy = document.getElementById('backtest-strategy').value;
  const windowMin = Number(document.getElementById('backtest-window').value || 60);
  setCurrentStrategiesDisplay(`${strategy} (sweep)`);
  const hId = addHistory({ type:'sweep', strategy, note:`window=${windowMin}m` });
  const listMinSp = parseNumList(document.getElementById('sweep-min-spread').value);
  const listMinLiq = parseNumList(document.getElementById('sweep-min-liq').value);
  const listFees = parseNumList(document.getElementById('sweep-fees').value);
  const listSlip = parseNumList(document.getElementById('sweep-slippage').value);
  const listGas = parseNumList(document.getElementById('sweep-gas-mul').value);
  const listMinConf = parseNumList(document.getElementById('sweep-min-conf')?.value || '');
  const listFeesExtra = parseNumList(document.getElementById('sweep-fees-extra')?.value || '');
  const maxRuns = Number(document.getElementById('sweep-max').value || 30);

  const dims = [
    listMinSp.length?listMinSp:[null],
    listMinLiq.length?listMinLiq:[null],
    listFees.length?listFees:[null],
    listSlip.length?listSlip:[null],
    listGas.length?listGas:[null],
    listMinConf.length?listMinConf:[null],
    listFeesExtra.length?listFeesExtra:[null]
  ];
  const names = ['min_spread_bps','min_liquidity_usd','fees_bps','slippage_bps','gas_multiplier','min_confidence','fees_bps_extra'];

  const combos = [];
  for (const combo of product(dims)){
    const params = {};
    combo.forEach((v,i)=>{ if (v!=null) params[names[i]] = v; });
    combos.push(params);
  }
  if (!combos.length){ toast('No sweep parameters specified'); return; }

  const results = [];
  const runs = combos.slice(0, Math.max(1, Math.min(maxRuns, combos.length)));
  const cont = document.getElementById('sweep-results');
  cont.innerHTML = `Running ${runs.length} sweeps...`;
  let done = 0;
  const hft = readHftParams();
  const rankByEl = document.getElementById('sweep-rank-by');
  const rankBy = rankByEl ? rankByEl.value : 'total_net_profit';

  async function runOne(p){
    const body = { strategy_name: strategy, window_minutes: windowMin, params: (hft ? { ...hft, ...p } : p) };
    const res = await fetch(`${BACKEND_BASE}/api/backtest/run`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).catch(()=>({ ok:false }));
    if (!res.ok) return null;
    const data = await res.json();
    return { params: p, metrics: data };
  }
  async function worker(queue){
    while (queue.length){
      const p = queue.shift();
      const out = await runOne(p);
      if (out) results.push(out);
      done += 1;
      cont.innerHTML = `Running ${done}/${runs.length}...`;
    }
  }
  const queue = runs.slice();
  const concurrency = Math.min(4, queue.length);
  const workers = Array.from({length: concurrency}, () => worker(queue));
  await Promise.all(workers);

  // Rank by total_net_profit then winrate
  function metricScore(m){
    if (rankBy === 'winrate') return Number(m.winrate||0);
    if (rankBy === 'sharpe_proxy') return Number(m.sharpe_proxy||0);
    if (rankBy === 'avg_profit_per_gas') return Number(m.avg_profit_per_gas||0);
    if (rankBy === 'net_over_dd'){
      const net = Number(m.total_net_profit||0);
      const dd = Math.abs(Number(m.max_drawdown_usd||0));
      return net / (1 + dd);
    }
    return Number(m.total_net_profit||0);
  }
  results.sort((a,b)=>{
    const as = metricScore(a.metrics), bs = metricScore(b.metrics);
    if (as!==bs) return bs-as;
    // tie-breakers
    const an = Number(a.metrics.total_net_profit||0), bn = Number(b.metrics.total_net_profit||0);
    if (an!==bn) return bn-an;
    const aw = Number(a.metrics.winrate||0), bw = Number(b.metrics.winrate||0);
    return bw-aw;
  });

  renderSweepResults(results);
  try {
    const best = results[0]?.metrics || {};
    updateHistory(hId, { status:'success', finishedAt: new Date().toISOString(), summary: `best net=$${Number(best.total_net_profit||0).toFixed(2)} (runs=${results.length})` });
  } catch { updateHistory(hId, { status:'success', finishedAt: new Date().toISOString(), summary: `runs=${results.length}` }); }
}

function renderSweepResults(results){
  const cont = document.getElementById('sweep-results');
  cont.innerHTML = '';
  if (!results.length){ cont.textContent = 'No results'; lastSweepBest=null; return; }
  const table = document.createElement('table'); table.className='grid';
  const thead = document.createElement('thead'); thead.innerHTML = `<tr>
    <th>#</th><th>Params</th><th>Winrate</th><th>Total Net</th><th>Avg P/G</th><th>Avg Gas</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  results.forEach((r,i)=>{
    const tr = document.createElement('tr');
    const tdIdx = document.createElement('td'); tdIdx.textContent = String(i+1);
    const tdParams = document.createElement('td'); tdParams.textContent = JSON.stringify(r.params);
    const tdWr = document.createElement('td'); tdWr.textContent = `${(Number(r.metrics.winrate||0)*100).toFixed(2)}%`;
    const tdNet = document.createElement('td'); tdNet.textContent = `$${Number(r.metrics.total_net_profit||0).toFixed(2)}`;
    const tdPG = document.createElement('td'); tdPG.textContent = Number(r.metrics.avg_profit_per_gas||0).toFixed(4);
    const tdGas = document.createElement('td'); tdGas.textContent = `$${Number(r.metrics.avg_gas_usd||0).toFixed(4)}`;
    tr.append(tdIdx, tdParams, tdWr, tdNet, tdPG, tdGas);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  cont.appendChild(table);
  lastSweepBest = results[0]?.params || null;
}

function applyBestToConfig(){
  if (!lastSweepBest){ toast('No sweep result yet'); return; }
  // Apply to override JSON by default to avoid losing other fields
  try {
    const chk = document.getElementById('override-params'); if (chk) chk.checked = true;
    const ta = document.getElementById('override-json');
    let current = {};
    try { current = JSON.parse(ta.value||'{}'); } catch {}
    const merged = { ...current, ...lastSweepBest };
    ta.value = JSON.stringify(merged, null, 2);
    toast('Applied best sweep params to overrides');
  } catch {}
}

async function applyBestGlobal(){
  if (!lastSweepBest){ toast('No sweep result yet'); return; }
  const res = await fetch(`${BACKEND_BASE}/api/config/apply-params`, {
    method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ params: lastSweepBest })
  }).catch(()=>({ ok:false }));
  if (!res.ok){ toast('Apply Best (Global) failed'); return; }
  toast('Best sweep params applied to global config');
}

const runBtn = document.getElementById('run-backtest');
if (runBtn) {
  runBtn.addEventListener('click', runBacktest);
}

// Populate Active Opportunities from last backtest top trades
const popFromBt = document.getElementById('populate-opps-from-backtest');
if (popFromBt) {
  popFromBt.addEventListener('click', async ()=>{
    try {
      if (!Array.isArray(lastBacktestTopTrades) || lastBacktestTopTrades.length === 0) {
        toast('No backtest results yet. Run a backtest first.');
        return;
      }
      // Clear current table
      const tbody = document.getElementById('opp-tbody');
      oppsByKey.clear();
      if (tbody) tbody.innerHTML = '';
      // Insert respecting filters and deriving net/ppg
      await processOpps(lastBacktestTopTrades);
      sortAndReattach();
      toast(`Populated ${lastBacktestTopTrades.length} opportunities from backtest`);
    } catch (e) {
      showError('Failed to populate from backtest');
    }
  });
}

const runSweepBtn = document.getElementById('run-sweep');
if (runSweepBtn) runSweepBtn.addEventListener('click', runSweep);
const applyBestBtn = document.getElementById('apply-best-config');
if (applyBestBtn) applyBestBtn.addEventListener('click', applyBestToConfig);
const applyBestGlobalBtn = document.getElementById('apply-best-global');
if (applyBestGlobalBtn) applyBestGlobalBtn.addEventListener('click', applyBestGlobal);

// init
initStrategiesUI();
// Try to auto-detect backend on load and set initial status
updateBackendStatusIndicator();
detectBackendBase();
scheduleHealthCheck();

// Filters apply/clear
const fltApply = document.getElementById('flt-apply');
if (fltApply) fltApply.addEventListener('click', ()=>{ sortAndReattach(); });
const fltClear = document.getElementById('flt-clear');
if (fltClear) fltClear.addEventListener('click', ()=>{
  ['flt-assets','flt-routes','flt-chains','flt-min-spread','flt-min-liq','flt-min-net'].forEach(id=>{ const el=document.getElementById(id); if (el) el.value=''; });
  sortAndReattach();
});

const oppSortSel = document.getElementById('opp-sort');
if (oppSortSel) oppSortSel.addEventListener('change', (e)=>{ oppSortKey = e.target.value; oppSortDir = 'desc'; sortAndReattach(); });

// ===== Route type helpers =====
function getAllowedRouteTypes(){
  const boxes = document.querySelectorAll('.rt-chk');
  return Array.from(boxes).filter(b=>b.checked).map(b=>b.value);
}
function setAllowedRouteTypes(list){
  const set = new Set((list||[]).map(String));
  document.querySelectorAll('.rt-chk').forEach(b=>{ b.checked = set.has(b.value); });
}

// ===== Asset overrides table =====
function addAssetOverrideRow(rec){
  const tbody = document.getElementById('asset-ovr-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  const tdAsset = document.createElement('td'); const inpAsset = document.createElement('input'); inpAsset.type='text'; inpAsset.value = rec?.asset||''; tdAsset.appendChild(inpAsset);
  const tdMinSp = document.createElement('td'); const inpMinSp = document.createElement('input'); inpMinSp.type='number'; inpMinSp.step='0.1'; inpMinSp.value = rec?.min_spread_bps??''; tdMinSp.appendChild(inpMinSp);
  const tdMinLq = document.createElement('td'); const inpMinLq = document.createElement('input'); inpMinLq.type='number'; inpMinLq.step='1'; inpMinLq.value = rec?.min_liquidity_usd??''; tdMinLq.appendChild(inpMinLq);
  const tdMaxTr = document.createElement('td'); const inpMaxTr = document.createElement('input'); inpMaxTr.type='number'; inpMaxTr.step='1'; inpMaxTr.value = rec?.max_trade_usd??''; tdMaxTr.appendChild(inpMaxTr);
  const tdSlip = document.createElement('td'); const inpSlip = document.createElement('input'); inpSlip.type='number'; inpSlip.step='0.1'; inpSlip.value = rec?.slippage_bps??''; tdSlip.appendChild(inpSlip);
  const tdFees = document.createElement('td'); const inpFees = document.createElement('input'); inpFees.type='number'; inpFees.step='0.1'; inpFees.value = rec?.fees_bps??''; tdFees.appendChild(inpFees);
  const tdAct = document.createElement('td');
  const delBtn = document.createElement('button'); delBtn.className='btn-sm'; delBtn.textContent='Remove'; delBtn.addEventListener('click', ()=>{ tr.remove(); });
  tdAct.appendChild(delBtn);
  tr.append(tdAsset, tdMinSp, tdMinLq, tdMaxTr, tdSlip, tdFees, tdAct);
  tbody.appendChild(tr);
}

function readAssetOverrides(){
  const tbody = document.getElementById('asset-ovr-tbody');
  const out = {};
  if (!tbody) return out;
  Array.from(tbody.children).forEach(tr=>{
    const [tdA, tdMinSp, tdMinLq, tdMaxTr, tdSlip, tdFees] = tr.children;
    const asset = tdA.querySelector('input')?.value?.trim();
    if (!asset) return;
    const rec = {
      min_spread_bps: Number(tdMinSp.querySelector('input')?.value||0),
      min_liquidity_usd: Number(tdMinLq.querySelector('input')?.value||0),
      max_trade_usd: Number(tdMaxTr.querySelector('input')?.value||0),
      slippage_bps: Number(tdSlip.querySelector('input')?.value||0),
      fees_bps: Number(tdFees.querySelector('input')?.value||0),
    };
    out[asset] = rec;
  });
  return out;
}

function maybePopulateAssetOverrides(map){
  try {
    const tbody = document.getElementById('asset-ovr-tbody');
    if (!tbody) return;
    if (tbody.children.length) return; // do not clobber manual edits
    const entries = Object.entries(map||{});
    for (const [asset, rec] of entries) addAssetOverrideRow({ asset, ...rec });
  } catch {}
}

// Hook buttons
const addOvrBtn = document.getElementById('add-asset-ovr');
if (addOvrBtn) addOvrBtn.addEventListener('click', ()=> addAssetOverrideRow({}));
const clrOvrBtn = document.getElementById('clear-asset-ovr');
if (clrOvrBtn) clrOvrBtn.addEventListener('click', ()=>{ const tb=document.getElementById('asset-ovr-tbody'); if (tb) tb.innerHTML=''; });

// ================ AI Analyze ================
async function aiAnalyze() {
  const strategy = document.getElementById('backtest-strategy').value;
  const windowMin = Number(document.getElementById('backtest-window').value || 60);
  const res = await fetch(`${BACKEND_BASE}/api/backtest/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy_name: strategy, window_minutes: windowMin })
  }).catch(()=>({ ok:false }));
  const cont = document.getElementById('ai-analysis');
  if (!res.ok) {
    cont.textContent = 'AI analysis failed';
    return;
  }
  const data = await res.json();
  cont.innerHTML = '';
  // Show JSON output
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(data.analysis, null, 2);
  cont.appendChild(pre);

  // If candidates present, render quick-apply buttons
  if (data.analysis && Array.isArray(data.analysis.candidates)) {
    data.analysis.candidates.forEach((c, idx) => {
      const btn = document.createElement('button');
      btn.textContent = `Apply Candidate ${c.name || idx+1}`;
      btn.addEventListener('click', () => {
        try {
          document.getElementById('strategy-name').value = c.name || `candidate_${idx+1}`;
          document.getElementById('strategy-params').value = JSON.stringify(c.params || {}, null, 2);
        } catch {}
      });
      cont.appendChild(btn);
    });
  }
}

const aiBtn = document.getElementById('ai-analyze');
if (aiBtn) {
  aiBtn.addEventListener('click', aiAnalyze);
}

// ================ Preset Buttons =================
function setFilterAssets(arr){
  const el = document.getElementById('filter-assets');
  if (el) el.value = (arr||[]).join(',');
}
const presetHypeUeth = document.getElementById('preset-hype-ueth');
if (presetHypeUeth) presetHypeUeth.addEventListener('click', ()=>{ setFilterAssets(['HYPE','uETH']); toast('Preset applied: HYPE,uETH'); });
const presetHypeKhype = document.getElementById('preset-hype-khype');
if (presetHypeKhype) presetHypeKhype.addEventListener('click', ()=>{ setFilterAssets(['HYPE','KHYPE']); toast('Preset applied: HYPE,KHYPE'); });
const presetHypeWst = document.getElementById('preset-hype-wsthype');
if (presetHypeWst) presetHypeWst.addEventListener('click', ()=>{ setFilterAssets(['HYPE','wstHYPE']); toast('Preset applied: HYPE,wstHYPE'); });

// Clear Filters
const btnClear = document.getElementById('preset-clear-filters');
if (btnClear) btnClear.addEventListener('click', ()=>{
  const ids = ['filter-assets','filter-routes','filter-chains','filter-min-confidence','filter-exclude-routes'];
  ids.forEach(id=>{ const el=document.getElementById(id); if (el) el.value=''; });
  toast('Filters cleared');
});

// Route presets
const prRouter = document.getElementById('preset-route-router');
if (prRouter) prRouter.addEventListener('click', ()=>{ const el=document.getElementById('filter-routes'); if (el) el.value='router'; toast('Route filter: router'); });
const prAmm = document.getElementById('preset-route-amm');
if (prAmm) prAmm.addEventListener('click', ()=>{ const el=document.getElementById('filter-routes'); if (el) el.value='amm'; toast('Route filter: amm'); });
const prRfq = document.getElementById('preset-route-rfq');
if (prRfq) prRfq.addEventListener('click', ()=>{ const el=document.getElementById('filter-routes'); if (el) el.value='rfq'; toast('Route filter: rfq'); });
const prExCommon = document.getElementById('preset-exclude-common');
if (prExCommon) prExCommon.addEventListener('click', ()=>{ const el=document.getElementById('filter-exclude-routes'); if (el) el.value='bridge,wrap,uni'; toast('Exclude common routes set'); });

// Chain presets
const prChainMain = document.getElementById('preset-chain-mainnet');
if (prChainMain) prChainMain.addEventListener('click', ()=>{ const el=document.getElementById('filter-chains'); if (el) el.value='hyperevm-mainnet'; toast('Chain: hyperevm-mainnet'); });

// Confidence presets
const prC05 = document.getElementById('preset-conf-0-5');
if (prC05) prC05.addEventListener('click', ()=>{ const el=document.getElementById('filter-min-confidence'); if (el) el.value='0.5'; toast('Min confidence: 0.5'); });
const prC07 = document.getElementById('preset-conf-0-7');
if (prC07) prC07.addEventListener('click', ()=>{ const el=document.getElementById('filter-min-confidence'); if (el) el.value='0.7'; toast('Min confidence: 0.7'); });
const prC09 = document.getElementById('preset-conf-0-9');
if (prC09) prC09.addEventListener('click', ()=>{ const el=document.getElementById('filter-min-confidence'); if (el) el.value='0.9'; toast('Min confidence: 0.9'); });

// HFT presets
function setHftPreset(p){
  const setNum = (id,val)=>{ const el=document.getElementById(id); if (el!=null) el.value = String(val); };
  Object.entries(p).forEach(([id,val])=> setNum(id,val));
}
const pLow = document.getElementById('preset-hft-low');
if (pLow) pLow.addEventListener('click', ()=>{
  setHftPreset({
    'hft-base-fee': 1.0,
    'hft-tip': 0.05,
    'hft-gas-limit': 220000,
    'hft-native-usd': 1.0,
    'hft-max-gas': 50,
    'hft-lat-ms': 300,
    'hft-lat-blocks': 1,
    'hft-lat-spb': 1.0,
    'hft-kvol': 0.0,
    'hft-beta': 1.0,
    'hft-fail-prob': 0.02,
    'hft-lp-fees': 0,
    'hft-router-fees': 0,
    'hft-extra-usd': 0,
    'hft-fees-extra': 0,
    'hft-slip-cap': 30,
    'hft-notional-cap': 50000,
  });
  toast('HFT preset: Low Gas');
});
const pBal = document.getElementById('preset-hft-balanced');
if (pBal) pBal.addEventListener('click', ()=>{
  setHftPreset({
    'hft-base-fee': 2.0,
    'hft-tip': 0.1,
    'hft-gas-limit': 250000,
    'hft-native-usd': 1.0,
    'hft-max-gas': 100,
    'hft-lat-ms': 250,
    'hft-lat-blocks': 1,
    'hft-lat-spb': 1.0,
    'hft-kvol': 0.0,
    'hft-beta': 1.0,
    'hft-fail-prob': 0.03,
    'hft-lp-fees': 0,
    'hft-router-fees': 0,
    'hft-extra-usd': 0,
    'hft-fees-extra': 2,
    'hft-slip-cap': 30,
    'hft-notional-cap': 50000,
  });
  toast('HFT preset: Balanced');
});
const pAgg = document.getElementById('preset-hft-agg');
if (pAgg) pAgg.addEventListener('click', ()=>{
  setHftPreset({
    'hft-base-fee': 3.0,
    'hft-tip': 0.2,
    'hft-gas-limit': 280000,
    'hft-native-usd': 1.0,
    'hft-max-gas': 150,
    'hft-lat-ms': 200,
    'hft-lat-blocks': 1,
    'hft-lat-spb': 1.0,
    'hft-kvol': 0.0,
    'hft-beta': 1.0,
    'hft-fail-prob': 0.05,
    'hft-lp-fees': 0,
    'hft-router-fees': 0,
    'hft-extra-usd': 0,
    'hft-fees-extra': 5,
    'hft-slip-cap': 30,
    'hft-notional-cap': 50000,
  });
  toast('HFT preset: Aggressive');
});
// ================ Market Gas Price =================
const gasBtn = document.getElementById('btn-gas-price');
if (gasBtn && !gasBtn._wired){ gasBtn._wired=true; gasBtn.addEventListener('click', ()=>fetchGasIfStale(true)); }
const emaBtn = document.getElementById('btn-base-fee-ema');
if (emaBtn && !emaBtn._wired){ emaBtn._wired=true; emaBtn.addEventListener('click', fetchBaseFeeEma); }
const gskyBtn = document.getElementById('btn-goldsky-pool');
if (gskyBtn && !gskyBtn._wired){ gskyBtn._wired=true; gskyBtn.addEventListener('click', fetchGoldskyPool); }

// ================ Backend Apply & Refresh ================
const applyBtn = document.getElementById('backend-apply');
if (applyBtn) {
  applyBtn.addEventListener('click', () => {
    const val = (document.getElementById('backend-input').value || '').trim();
    if (!val) return;
    setBackendBase(val);
  });
}

const refreshStratsBtn = document.getElementById('refresh-strategies');
if (refreshStratsBtn) {
  refreshStratsBtn.addEventListener('click', initStrategiesUI);
}

// Manual detect button (optional)
const detectBtn = document.getElementById('backend-detect');
if (detectBtn) {
  detectBtn.addEventListener('click', () => { detectBackendBase(); scheduleHealthCheck(); });
}

// ================ Copy Live Config to Overrides ================
const copyCfgBtn = document.getElementById('copy-config-to-overrides');
if (copyCfgBtn) {
  copyCfgBtn.addEventListener('click', () => {
    try {
      const cfgText = document.getElementById('config-preview').textContent || '{}';
      const cfg = JSON.parse(cfgText);
      const overridesEl = document.getElementById('override-json');
      if (overridesEl) overridesEl.value = JSON.stringify(cfg, null, 2);
      const chk = document.getElementById('override-params');
      if (chk) chk.checked = true;
    } catch (e) {
      showError('Failed to copy config');
    }
  });
}

// ================ Errors helper ================
function showError(msg, details) {
  const box = document.getElementById('errors');
  if (!box) return;
  box.style.display = 'block';
  const line = document.createElement('div');
  const ts = new Date().toLocaleTimeString();
  let extra = '';
  try {
    if (details && typeof details === 'object') {
      extra = ' ' + JSON.stringify(details);
    } else if (details != null) {
      extra = ' ' + String(details);
    }
  } catch {}
  line.textContent = `[${ts}] ${msg}${extra}`;
  box.appendChild(line);
}

// ================ Opportunities Table (static rows) ================
function makeOppKey(o){
  const pair = (o.pair || o.route || '').toLowerCase();
  const route = (o.route || '').toLowerCase();
  const chain = (o.chain_name || '').toLowerCase();
  return `${chain}|${pair}|${route}`;
}

function applyFlash(cell, prev, next){
  if (prev === next) return;
  const up = Number(next) > Number(prev);
  cell.classList.remove('flash-up','flash-down');
  // force reflow for restart animation
  void cell.offsetWidth;
  cell.classList.add(up ? 'flash-up' : 'flash-down');
}

function upsertOppRow(o){
  const key = makeOppKey(o);
  const tbody = document.getElementById('opp-tbody');
  if (!tbody) return;
  const existing = oppsByKey.get(key);
  const spread = Number(o.spread_bps || 0);
  const liq = Number(o.liquidity_usd || 0);
  const profit = Number(o.est_profit_usd || 0);
  const profitNet = Number(o.profit_net_usd || (o.est_profit_usd||0));
  const profitPerGas = Number(o.profit_per_gas || 0);
  const ts = o.ts || '';
  const pair = o.pair || o.route || '';
  if (existing) {
    // update cells only
    const { cells, data } = existing;
    applyFlash(cells.spread, Number(data.spread_bps||0), spread);
    applyFlash(cells.liq, Number(data.liquidity_usd||0), liq);
    applyFlash(cells.profit, Number(data.est_profit_usd||0), profit);
    applyFlash(cells.net, Number(data.profit_net_usd||0), profitNet);
    applyFlash(cells.ppg, Number(data.profit_per_gas||0), profitPerGas);
    cells.spread.textContent = spread.toFixed(2);
    cells.liq.textContent = liq.toLocaleString(undefined, { maximumFractionDigits: 0 });
    cells.profit.textContent = profit.toFixed(2);
    cells.net.textContent = profitNet.toFixed(2);
    cells.ppg.textContent = profitPerGas.toFixed(4);
    cells.ts.textContent = ts;
    existing.data = o;
  } else {
    // create row
    const tr = document.createElement('tr');
    const tdPair = document.createElement('td');
    tdPair.className = 'cell-tight';
    tdPair.appendChild(renderIdInline(pair, { chain: o.chain_name, narrow:false }));
    const tdSpread = document.createElement('td'); tdSpread.textContent = Number(spread).toFixed(2);
    const tdLiq = document.createElement('td'); tdLiq.textContent = `$${Number(liq).toLocaleString()}`;
    const tdProfit = document.createElement('td'); tdProfit.textContent = `$${Number(profit).toFixed(2)}`;
    const tdNet = document.createElement('td'); tdNet.textContent = `$${Number(profitNet).toFixed(2)}`;
    const tdPPG = document.createElement('td'); tdPPG.textContent = Number(profitPerGas).toFixed(4);
    const tdConf = document.createElement('td'); tdConf.textContent = o.confidence==null ? '-' : Number(o.confidence).toFixed(3);
    const tdRoute = document.createElement('td');
    tdRoute.className = 'cell-tight';
    const rwrap = document.createElement('div'); rwrap.style.display='flex'; rwrap.style.gap='6px'; rwrap.style.alignItems='center';
    rwrap.appendChild(routeBadge(routeTypeFrom(o)));
    rwrap.appendChild(renderIdInline(o.route || '-', { chain: o.chain_name, narrow:true }));
    tdRoute.appendChild(rwrap);
    const tdChain = document.createElement('td'); tdChain.textContent = o.chain_name || '-';
    const tdTs = document.createElement('td'); tdTs.textContent = ts;
    const tdAct = document.createElement('td');
    const pinBtn = document.createElement('button'); pinBtn.className='btn-sm'; pinBtn.textContent='Pin';
    pinBtn.addEventListener('click', ()=>{
      const was = pinnedKeys.has(key);
      if (was) pinnedKeys.delete(key); else pinnedKeys.add(key);
      pinBtn.textContent = pinnedKeys.has(key) ? 'Unpin' : 'Pin';
      sortAndReattach();
    });
    const simBtn = document.createElement('button'); simBtn.className='btn-sm'; simBtn.textContent='Sim';
    simBtn.addEventListener('click', ()=>{ toast(`Sim route for ${pair} requested`); /* hook to backtest API later */ });
    tdAct.append(pinBtn, simBtn);
    tr.append(tdPair, tdSpread, tdLiq, tdProfit, tdNet, tdPPG, tdConf, tdRoute, tdChain, tdTs, tdAct);
    oppsByKey.set(key, { data: o, tr, cells: { spread: tdSpread, liq: tdLiq, profit: tdProfit, net: tdNet, ppg: tdPPG, ts: tdTs } });
    tbody.appendChild(tr);
    enforceOppLimit();
  }
}

// ===== Filters =====
function readFilters(){
  const assets = (document.getElementById('flt-assets')?.value||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const routes = (document.getElementById('flt-routes')?.value||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const chains = (document.getElementById('flt-chains')?.value||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const minSpread = Number(document.getElementById('flt-min-spread')?.value||0);
  const minLiq = Number(document.getElementById('flt-min-liq')?.value||0);
  const minNet = Number(document.getElementById('flt-min-net')?.value||0);
  return { assets, routes, chains, minSpread, minLiq, minNet };
}

function routeTypeFrom(o){
  const r = (o.route||'').toLowerCase();
  if (r.includes('router')) return 'router';
  if (r.includes('amm')) return 'amm';
  if (r.includes('rfq')) return 'rfq';
  return 'route';
}

function assetFromPair(o){
  const p = (o.pair||'').trim();
  if (!p) return '';
  const parts = p.split('/');
  return (parts[0]||p).toLowerCase();
}

async function processOpps(opps){
  const filters = readFilters();
  const gas = await fetchGasIfStale();
  for (const o of opps) {
    // derive metrics
    const gasUsd = o.gas_usd != null ? Number(o.gas_usd) : Number(gas.usd||0);
    const gross = Number(o.est_profit_usd || 0);
    const net = gross - Number(gasUsd||0);
    const ppg = gasUsd>0 ? (gross / gasUsd) : 0;
    o.profit_net_usd = net;
    o.profit_per_gas = ppg;
    o.confidence = o.confidence ?? null;

    // filters
    const asset = assetFromPair(o);
    const rtype = routeTypeFrom(o);
    const chain = (o.chain_name||'').toLowerCase();
    if (filters.assets.length && !filters.assets.includes(asset)) continue;
    if (filters.routes.length && !filters.routes.includes(rtype)) continue;
    if (filters.chains.length && !filters.chains.includes(chain)) continue;
    if (Number(o.spread_bps||0) < filters.minSpread) continue;
    if (Number(o.liquidity_usd||0) < filters.minLiq) continue;
    if (Number(o.profit_net_usd||0) < filters.minNet) continue;

    upsertOppRow(o);
  }
}

function enforceOppLimit(){
  const tbody = document.getElementById('opp-tbody');
  const limitVal = Number((document.getElementById('opp-limit')?.value) || 20);
  while (tbody.children.length > Math.max(1, limitVal)) {
    const tr = tbody.firstChild;
    tbody.removeChild(tr);
    // also remove from map by reverse lookup
    for (const [k,v] of oppsByKey.entries()) { if (v.tr === tr) { oppsByKey.delete(k); break; } }
  }
}

const oppPause = document.getElementById('opp-pause');
if (oppPause) oppPause.addEventListener('change', (e)=>{ oppPaused = e.target.checked; });
const oppClear = document.getElementById('opp-clear');
if (oppClear) oppClear.addEventListener('click', ()=>{
  const tbody = document.getElementById('opp-tbody');
  oppsByKey.clear();
  if (tbody) tbody.innerHTML = '';
});

const oppTable = document.getElementById('opp-table');
if (oppTable) {
  oppTable.addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th) return;
    const key = th.getAttribute('data-sort');
    if (!key) return;
    if (oppSortKey === key) { oppSortDir = oppSortDir === 'asc' ? 'desc' : 'asc'; } else { oppSortKey = key; oppSortDir = 'desc'; }
    sortAndReattach();
  });
}

function sortAndReattach(){
  const tbody = document.getElementById('opp-tbody');
  const entries = Array.from(oppsByKey.entries());
  entries.sort(([,a],[,b])=>{
    // Pins first
    const ap = pinnedKeys.has(makeOppKey(a.data)) ? 1 : 0;
    const bp = pinnedKeys.has(makeOppKey(b.data)) ? 1 : 0;
    if (ap !== bp) return bp - ap; // pinned desc
    const va = (a.data[oppSortKey] ?? 0); const vb = (b.data[oppSortKey] ?? 0);
    const na = typeof va === 'string' ? va : Number(va);
    const nb = typeof vb === 'string' ? vb : Number(vb);
    const cmp = na < nb ? -1 : na > nb ? 1 : 0; return oppSortDir === 'asc' ? cmp : -cmp;
  });
  const fr = document.createDocumentFragment();
  for (const [,v] of entries) fr.appendChild(v.tr);
  if (tbody) tbody.appendChild(fr);
}

// ================ Config builders & countdown ================
function buildConfig(){
  const assets = (document.getElementById('cfg-assets')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
  const run_minutes = Number(document.getElementById('cfg-run-minutes')?.value || 60);
  const profit_min = Number(document.getElementById('cfg-profit-min')?.value || 0);
  const profit_max = Number(document.getElementById('cfg-profit-max')?.value || 0);
  const allowed_route_types = getAllowedRouteTypes();
  const asset_overrides = readAssetOverrides();
  return { assets, run_duration_sec: Math.max(60, Math.floor(run_minutes*60)), target_profit_bps_min: profit_min*100, target_profit_bps_max: profit_max*100, allowed_route_types, asset_overrides };
}

function buildRunPayload(){
  const cfg = buildConfig();
  return { assets: cfg.assets, run_minutes: Math.floor((cfg.run_duration_sec||3600)/60), profit_bps_min: cfg.target_profit_bps_min, profit_bps_max: cfg.target_profit_bps_max, strategy_name: (document.getElementById('run-strategy-select')?.value||'') };
}

function startCountdown(endTs){
  stopCountdown();
  const el = document.getElementById('run-countdown');
  if (!el) return;
  function tick(){
    const now = Date.now();
    let ms = Math.max(0, endTs - now);
    const m = Math.floor(ms/60000); const s = Math.floor((ms%60000)/1000);
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (ms<=0) { stopCountdown(); }
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function stopCountdown(){ if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

// ================ Strategy upload & run ================
const uploadBtn = document.getElementById('upload-strategy');
if (uploadBtn) {
  uploadBtn.addEventListener('click', async ()=>{
    const fileInput = document.getElementById('strategy-file');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) { showError('No strategy file selected'); return; }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    try {
      const res = await fetch(`${BACKEND_BASE}/api/strategies/upload`, { method:'POST', body: fd });
      const data = await res.json();
      toast('Strategy uploaded');
      initStrategiesUI();
    } catch (e) { showError('Strategy upload failed'); }
  });
}

const runStratBtn = document.getElementById('run-strategy');
if (runStratBtn) {
  runStratBtn.addEventListener('click', async ()=>{
    const payload = buildRunPayload();
    try {
      const res = await fetch(`${BACKEND_BASE}/api/bot/start`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const data = await res.json();
      const endTs = data.end_ts ? Date.parse(data.end_ts) : Date.now() + (Number(payload.run_minutes||60)*60*1000);
      startCountdown(endTs);
      toast('Strategy run requested');
    } catch (e) { showError('Run strategy failed'); }
  });
}

// ================ Toast helper ================
function toast(msg){
  try {
    const box = document.getElementById('errors');
    if (!box) return;
    const line = document.createElement('div');
    const ts = new Date().toLocaleTimeString();
    line.style.color = '#065f46';
    line.textContent = `[${ts}] ${msg}`;
    box.appendChild(line);
    box.style.display = 'block';
  } catch {}
}
