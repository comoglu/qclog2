'use strict';

// ══════════════════════════════════════════════════════════
// CONFIGURATION DEFAULTS
// ══════════════════════════════════════════════════════════
const PARAMS = {
  availability:   { label: 'Avail',   unit: '%',  fmt: v => v == null ? '—' : v.toFixed(1)+'%',  lowerWorse: true  },
  delay:          { label: 'Delay',   unit: 's',  fmt: v => v == null ? '—' : fmtSec(v),          lowerWorse: false },
  latency:        { label: 'Latency', unit: 's',  fmt: v => v == null ? '—' : fmtSec(v),          lowerWorse: false },
  timing_quality: { label: 'Timing',  unit: '%',  fmt: v => v == null ? '—' : v.toFixed(0)+'%',   lowerWorse: true  },
  rms:            { label: 'RMS',     unit: 'cts',fmt: v => v == null ? '—' : v.toFixed(1),        lowerWorse: null  },
  offset:         { label: 'Offset',  unit: 'cts',fmt: v => v == null ? '—' : v.toFixed(1),        lowerWorse: null  },
  gaps_count:     { label: 'Gaps',    unit: '',   fmt: v => v == null ? '—' : v.toFixed(0),        lowerWorse: false },
  overlaps_count: { label: 'Ovlps',  unit: '',   fmt: v => v == null ? '—' : v.toFixed(0),        lowerWorse: false },
  spikes_count:   { label: 'Spikes', unit: '',   fmt: v => v == null ? '—' : v.toFixed(0),        lowerWorse: false },
};

const PRESETS = [
  { label: 'Last 1 h',   ms: 3_600_000 },
  { label: 'Last 6 h',   ms: 6 * 3_600_000 },
  { label: 'Last 12 h',  ms: 12 * 3_600_000 },
  { label: 'Last 24 h',  ms: 24 * 3_600_000 },
  { label: 'Last 36 h',  ms: 36 * 3_600_000 },
  { label: 'Last 3 d',   ms: 3 * 86_400_000 },
  { label: 'Last 7 d',   ms: 7 * 86_400_000 },
  { label: 'Last 14 d',  ms: 14 * 86_400_000 },
  { label: 'Last 30 d',  ms: 30 * 86_400_000 },
  { label: 'Custom…',    ms: null },
];

const DEFAULTS = {
  dataUrl:   'qc_current.json',
  histUrl:   'qc_24h.json',
  apiUrl:    '/api/qc',
  fdsnws:    '',
  refreshMs: 60_000,
  theme:     'light',
  thresholds: {
    availability:   { warn: 80,  alert: 50,  lowerWorse: true  },
    delay:          { warn: 60,  alert: 300, lowerWorse: false },
    latency:        { warn: 60,  alert: 300, lowerWorse: false },
    timing_quality: { warn: 80,  alert: 50,  lowerWorse: true  },
    gaps_count:     { warn: 1,   alert: 5,   lowerWorse: false },
    overlaps_count: { warn: 1,   alert: 5,   lowerWorse: false },
    spikes_count:   { warn: 1,   alert: 5,   lowerWorse: false },
  },
};

// ══════════════════════════════════════════════════════════
// APPLICATION STATE
// ══════════════════════════════════════════════════════════
const S = {
  data:         null,   // parsed qc_current.json
  histData:     null,   // parsed qc_24h.json or qc_7d.json
  histRange:    '24h',
  coordinates:  {},
  lastUpdateMs: null,

  prefs: {
    dataUrl:    DEFAULTS.dataUrl,
    histUrl:    DEFAULTS.histUrl,
    apiUrl:     DEFAULTS.apiUrl,
    fdsnws:     DEFAULTS.fdsnws,
    refreshMs:  DEFAULTS.refreshMs,
    theme:      DEFAULTS.theme,
    thresholds: JSON.parse(JSON.stringify(DEFAULTS.thresholds)),
    watchlist:  [],
  },

  view:       'table',
  filter:     { net: '', param: '', status: '', search: '' },
  sort:       { key: 'stream', asc: true },
  detailStream: null,
  detailParam:  null,
  watchlist:  new Set(),
  theme:      'light',
  refreshMs:  60_000,

  mainTimer:  null,
  cdTimer:    null,
  cdSecs:     0,
  uplot:      null,
  visibleParams: [],   // params actually seen in data

  // Heatmap view
  hmCanvas:   null,
  hmStreams:  [],
  hmBins:     [],
  hmCellW:    0,
  hmCellH:    16,
  hmLabelW:   130,

  // Events
  events:      [],     // [{ ts, stream, from, to, resolvedTs }]
  prevStatus:  {},     // { stream: status } from last cycle

  // Map view
  mapColor:   '',          // '' = overall status, else a threshold parameter
  mapHide:    new Set(),   // statuses hidden on the map

  // Prefs (add to existing prefs object at loadPrefs time)
  notifEnabled:  false,
  watchlistOnly: false,
};

// ══════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function posTooltip(tt, cx, cy) {
  const tw = tt.offsetWidth || 180, th = tt.offsetHeight || 60;
  tt.style.left = (cx + 14 + tw > window.innerWidth  ? cx - tw - 10 : cx + 14) + 'px';
  tt.style.top  = (cy + 14 + th > window.innerHeight ? cy - th - 10 : cy + 14) + 'px';
}

function fmtSec(s) {
  if (s == null) return '—';
  if (s < 0) return '−' + fmtSec(-s);   // future timestamp: keep it visible
  if (s < 60)    return `${s.toFixed(1)}s`;
  if (s < 3600)  return `${(s/60).toFixed(1)}m`;
  if (s < 86400) return `${(s/3600).toFixed(1)}h`;
  return `${(s/86400).toFixed(1)}d`;
}

// Status colours are defined in style.css only. Canvas and Plotly need real
// colour values, so they read the variables here.
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}
function cssAlpha(name, a) {
  let h = cssVar(name).replace('#', '');
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h, 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

const fmtTime = ms => ms ? new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC' : '—';

// DD/MM at midnight, HH:MM otherwise — used for all uPlot x-axes
const fmtXAxis = (u, vals) => vals.map(v => {
  if (v == null) return '';
  const d = new Date(v * 1000);
  const HH = String(d.getUTCHours()).padStart(2,'0');
  const MM = String(d.getUTCMinutes()).padStart(2,'0');
  if (HH === '00' && MM === '00')
    return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  return `${HH}:${MM}`;
});

// ── Time picker ───────────────────────────────────────────────────────────────

function utcInputVal(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

function fmtRangeLabel(from_ms, to_ms) {
  const span = to_ms - from_ms;
  const preset = PRESETS.find(p => p.ms === span);
  if (preset && preset.ms) return preset.label;
  return `${utcInputVal(from_ms).replace('T',' ')} → ${utcInputVal(to_ms).replace('T',' ')} UTC`;
}

function timePickerHtml(defaultMs = 86_400_000) {
  const opts = PRESETS.map(p =>
    `<option value="${p.ms ?? 'custom'}"${p.ms === defaultMs ? ' selected' : ''}>${p.label}</option>`
  ).join('');
  const now    = Date.now();
  const fromStr = utcInputVal(now - defaultMs);
  const toStr   = utcInputVal(now);
  return `<div class="tpick">` +
    `<select class="tpick-sel">${opts}</select>` +
    `<span class="tpick-abs" style="display:none">` +
      `<input class="tpick-from" type="datetime-local" step="60" value="${fromStr}" title="Start (UTC)">` +
      `<span class="tpick-arrow">→</span>` +
      `<input class="tpick-to"   type="datetime-local" step="60" value="${toStr}"   title="End (UTC)">` +
      `<span class="tpick-tz">UTC</span>` +
      `<button class="tpick-apply btn-primary">Apply</button>` +
    `</span>` +
  `</div>`;
}

function pickerRange(pickerEl) {
  const sel = pickerEl.querySelector('.tpick-sel');
  if (sel.value !== 'custom') {
    const to   = Date.now();
    const from = to - Number(sel.value);
    return { from, to };
  }
  const from = new Date(pickerEl.querySelector('.tpick-from').value + ':00Z').getTime();
  const to   = new Date(pickerEl.querySelector('.tpick-to').value   + ':00Z').getTime();
  return { from, to };
}

function initPicker(pickerEl, onApply) {
  const sel = pickerEl.querySelector('.tpick-sel');
  const abs = pickerEl.querySelector('.tpick-abs');
  sel.addEventListener('change', () => {
    const custom = sel.value === 'custom';
    abs.style.display = custom ? '' : 'none';
    if (custom) {
      const now = Date.now();
      pickerEl.querySelector('.tpick-from').value = utcInputVal(now - 86_400_000);
      pickerEl.querySelector('.tpick-to').value   = utcInputVal(now);
    } else {
      onApply(pickerRange(pickerEl));
    }
  });
  pickerEl.querySelector('.tpick-apply').addEventListener('click', () => {
    const { from, to } = pickerRange(pickerEl);
    if (!from || !to || to <= from) return;
    onApply({ from, to });
  });
}

async function fetchJSON(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now());
  if (!r.ok) throw new Error(r.status);
  const data = await r.json();
  return DEMO ? demoShift(data) : data;
}

async function fetchQCRange(from_ms, to_ms, param = null) {
  if (DEMO) {
    // No backend API in demo mode: serve custom ranges from the static files.
    const age  = Date.now() - from_ms;
    const file = age <= 24 * 3_600_000 ? 'qc_24h.json'
               : age <=  3 * 86_400_000 ? 'qc_3d.json' : 'qc_30d.json';
    return trimRange(await fetchJSON(DEMO_DIR + file), from_ms, to_ms, param);
  }
  let url = `${S.prefs.apiUrl}?from=${from_ms}&to=${to_ms}`;
  if (param) url += `&param=${encodeURIComponent(param)}`;
  return fetchJSON(url);
}

function urlForSpan(spanMs) {
  const dir = DEMO ? DEMO_DIR : '';
  if (spanMs <= 24 * 3_600_000) return dir + 'qc_24h.json';
  if (spanMs <= 3 * 86_400_000) return dir + 'qc_3d.json';
  if (spanMs <= 7 * 86_400_000) return dir + 'qc_7d.json';
  return dir + 'qc_30d.json';
}

// Trim to exact window; drop other params to reduce memory
function trimRange(data, from, to, param) {
  for (const sd of Object.values(data.streams || {})) {
    for (const p of Object.keys(sd)) {
      if (param && p !== param) { delete sd[p]; continue; }
      sd[p] = sd[p].filter(([t]) => t >= from && t <= to);
    }
  }
  data.from = from;
  data.to   = to;
  return data;
}

async function fetchRange(pickerEl, param = null) {
  const sel = pickerEl.querySelector('.tpick-sel');
  const { from, to } = pickerRange(pickerEl);
  if (sel.value === 'custom') {
    return fetchQCRange(from, to, param);
  }
  const data = await fetchJSON(urlForSpan(Number(sel.value)));
  return trimRange(data, from, to, param);
}

// ══════════════════════════════════════════════════════════
// DEMO MODE  — synthetic data from demo/, no backend needed.
// On by default on GitHub Pages, or anywhere with ?demo=1.
// ══════════════════════════════════════════════════════════
const DEMO = (() => {
  const q = new URLSearchParams(location.search);
  if (q.has('demo')) return q.get('demo') !== '0';
  return location.hostname.endsWith('github.io');
})();
const DEMO_DIR = 'demo/';

// Demo files are a snapshot. Move every timestamp forward so the snapshot's
// 'generated' time becomes now. The shift is a whole number of 10-minute bins
// so bin alignment is preserved.
function demoShift(data) {
  if (!data?.generated) return data;
  const BIN = 600_000;
  const d   = Math.floor((Date.now() - data.generated) / BIN) * BIN;
  // Values keep their (<10 min) age; only the snapshot time reads as "now"
  data.generated = Date.now();
  if (d <= 0) return data;
  for (const sd of Object.values(data.streams || {})) {
    for (const entry of Object.values(sd)) {
      if (Array.isArray(entry)) { for (const pt of entry) pt[0] += d; continue; }
      if (entry.t != null) entry.t += d;
      if (entry.spark) for (const pt of entry.spark) pt[0] += d;
    }
  }
  for (const ev of data.events || []) {
    ev.ts += d;
    if (ev.resolvedTs != null) ev.resolvedTs += d;
  }
  return data;
}

async function loadDemoEvents() {
  try {
    const data   = await fetchJSON(DEMO_DIR + 'events.json');
    S.events     = data.events || [];
    S.prevStatus = {};
  } catch(_) {}
}

// A negative delay or latency means the data is timestamped in the future:
// the station clock is ahead (timing/GPS fault). Allow a little jitter.
const FUTURE_TOL_S = 2;
const isFuture = (param, value) =>
  (param === 'delay' || param === 'latency') && value != null && value < -FUTURE_TOL_S;

function cellStatus(param, value) {
  if (value == null) return 'nodata';
  if (isFuture(param, value)) return 'warn';   // whatever the thresholds say
  const thr = S.prefs.thresholds[param];
  if (!thr) return 'info';   // no threshold = informational only
  const { warn, alert, lowerWorse } = thr;
  if (lowerWorse) {
    if (value <= alert) return 'alert';
    if (value <= warn)  return 'warn';
  } else {
    if (value >= alert) return 'alert';
    if (value >= warn)  return 'warn';
  }
  return 'ok';
}

const STATUS_RANK = { nodata: 4, alert: 3, warn: 2, ok: 1, info: 0 };   // higher = worse

function streamStatus(streamData) {
  // worst status across all threshold-bearing params
  let worst = 'ok';
  for (const [param, entry] of Object.entries(streamData)) {
    const st = cellStatus(param, entry?.v ?? null);
    if ((STATUS_RANK[st] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = st;
  }
  return worst;
}

// ══════════════════════════════════════════════════════════
// DATA FETCH
// ══════════════════════════════════════════════════════════
let _seq = 0;

function fetchData() {
  setBadge('connecting');
  const seq = ++_seq;
  const url = DEMO ? DEMO_DIR + 'qc_current.json' : S.prefs.dataUrl;

  fetchJSON(url)
    .then(data => {
      if (seq !== _seq) return;
      S.data         = data;
      S.lastUpdateMs = Date.now();

      detectEvents(data);
      savePrefs();

      // Determine which params are actually present in this data
      const seen = new Set();
      for (const params of Object.values(data.streams || {}))
        for (const k of Object.keys(params)) seen.add(k);
      S.visibleParams = (data.params || Object.keys(PARAMS))
        .filter(p => seen.has(p) && PARAMS[p]);

      render();
      if (!_urlStateApplied) { _urlStateApplied = true; applyUrlState(); }
      const ageMs = data.generated ? Date.now() - data.generated : null;
      setBadge(ageMs !== null && ageMs > 5 * 60_000 ? 'stale' : 'live');
      scheduleMain();
    })
    .catch(() => {
      if (seq !== _seq) return;
      setBadge('error');
      scheduleMain();
    });
}

// Deep links, applied once after the first data load:
//   ?view=grid|map|history|overlay|heatmap|events
//   ?view=history&stream=NET.STA.LOC.CHA&param=latency   (auto-loads the chart)
//   ?view=overlay&param=delay    ?view=heatmap&param=latency
//   ?chart=NET.STA.LOC.CHA,latency                       (opens the side panel)
//   &range=6h|24h|3d|7d|30d   preset for all time pickers
//   &search=!MIRN,BHZ         overlay stream filter
let _urlStateApplied = false;

function applyUrlState() {
  const q     = new URLSearchParams(location.search);
  const view  = q.get('view');
  const param = q.get('param');
  const setSel = (id, val) => {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (el && val && [...el.options].some(o => o.value === val)) el.value = val;
  };
  if (param) { setSel('hist-param', param); setSel('cmp-param', param); setSel('hm-param', param); }
  const rm = /^(\d+)([hd])$/.exec(q.get('range') || '');
  if (rm) {
    const ms = String(rm[1] * (rm[2] === 'h' ? 3_600_000 : 86_400_000));
    document.querySelectorAll('.tpick-sel').forEach(sel => setSel(sel, ms));
  }
  if (q.get('search')) document.getElementById('cmp-search').value = q.get('search');
  if (view === 'map' && param && S.prefs.thresholds[param]) S.mapColor = param;
  if (view === 'history' && q.get('stream')) {
    populateHistStream();
    setSel('hist-stream', q.get('stream'));
  }
  if (view && document.getElementById('view-' + view)) switchView(view);
  if (view === 'history' && q.get('stream')) loadHistoryChart();
  const chart = q.get('chart');
  if (chart && chart.includes(',')) {
    const [stream, p] = chart.split(',');
    if (S.data?.streams?.[stream]) openChart(stream, p);
  }
}

function scheduleMain() {
  clearTimeout(S.mainTimer);
  clearInterval(S.cdTimer);
  S.cdSecs = S.refreshMs / 1000;
  updateCountdown();
  S.cdTimer   = setInterval(() => { S.cdSecs--; updateCountdown(); }, 1000);
  S.mainTimer = setTimeout(() => { clearInterval(S.cdTimer); fetchData(); }, S.refreshMs);
}

const updateCountdown = () => {
  const el = document.getElementById('footer-countdown');
  if (el) el.textContent = `Next refresh in ${S.cdSecs}s`;
};

// ══════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════
function render() {
  if (!S.data) return;
  renderStatusBar();
  renderNetFilter();
  populateHistStream();
  if (S.view === 'table') renderTable();
  if (S.view === 'grid')  renderGrid();
  if (S.view === 'map' && _map) refreshMapMarkers();
  updateEventsBadge();
  const totalStreams = Object.keys(S.data.streams || {}).length;
  document.getElementById('footer-info').textContent =
    `${totalStreams} streams · ${S.visibleParams.length} parameters`;
  const lu = document.getElementById('last-update-text');
  if (lu) lu.textContent = S.lastUpdateMs ? `Updated ${fmtTime(S.lastUpdateMs)}` : '';
}

// ══════════════════════════════════════════════════════════
// VIEW SWITCHING
// ══════════════════════════════════════════════════════════
function switchView(v) {
  S.view = v;
  document.querySelectorAll('.view').forEach(s =>
    s.classList.toggle('active', s.id === 'view-' + v));
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === v));
  if (v === 'map' || v === 'history' || v === 'overlay' || v === 'heatmap' || v === 'events') closeChart();
  if (v !== 'history' && _histPlot) { _histPlot.destroy(); _histPlot = null; }
  if (v === 'map')              { initMap(); if (S.data) refreshMapMarkers(); }
  if (v === 'grid'    && S.data) renderGrid();
  if (v === 'table'   && S.data) renderTable();
  if (v === 'overlay')  loadOverlay();
  if (v === 'heatmap')  loadHeatmap();
  if (v === 'events')   renderEvents();
}

// ── Status bar ──────────────────────────────────────────────
function renderStatusBar() {
  const streams = Object.values(S.data.streams || {});
  const counts = { ok: 0, warn: 0, alert: 0, nodata: 0 };
  const nets = {};

  for (const [sid, sdata] of Object.entries(S.data.streams || {})) {
    const st  = streamStatus(sdata);
    counts[st] = (counts[st] || 0) + 1;
    const net = sid.split('.')[0];
    if (!nets[net]) nets[net] = { total: 0, ok: 0 };
    nets[net].total++;
    if (st === 'ok') nets[net].ok++;
  }

  document.getElementById('status-counts').innerHTML =
    Object.entries({ alert: counts.alert, warn: counts.warn, ok: counts.ok, nodata: counts.nodata })
      .filter(([,n]) => n > 0)
      .map(([st,n]) =>
        `<span class="scount qc-${st}${S.filter.status === st ? ' active-filter' : ''}" data-filter="${st}">${n} ${st}</span>`
      ).join('');

  document.getElementById('net-breakdown').innerHTML =
    Object.entries(nets).sort(([a],[b]) => a.localeCompare(b)).map(([net,d]) => {
      const pct = Math.round(d.ok / d.total * 100);
      const col = pct >= 80 ? 'var(--s-ok)' : pct >= 50 ? 'var(--s-warn)' : 'var(--s-alert)';
      return `<div class="net-pill" title="${net}: ${d.ok}/${d.total} ok">
        <strong>${esc(net)}</strong>
        <div class="net-health-bar"><div class="net-health-fill" style="width:${pct}%;background:${col}"></div></div>
        <span class="pill-dim">${d.ok}/${d.total}</span>
      </div>`;
    }).join('');
}

function renderNetFilter() {
  const nets = [...new Set(Object.keys(S.data.streams || {}).map(s => s.split('.')[0]))].sort();
  const sel  = document.getElementById('filter-net');
  const cur  = S.filter.net || sel.value;
  sel.innerHTML = `<option value="">All Networks</option>` +
    nets.map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

// ── QC Grid Table ───────────────────────────────────────────
function buildRows() {
  const { net, param, status, search } = S.filter;
  const q = search.toLowerCase();

  return Object.entries(S.data.streams || {})
    .filter(([sid, sdata]) => {
      if (S.watchlistOnly && !S.watchlist.has(sid)) return false;
      if (net    && sid.split('.')[0] !== net) return false;
      if (search && !sid.toLowerCase().includes(q)) return false;
      if (param) {
        // show only streams that have this parameter
        if (!sdata[param]) return false;
      }
      if (status) {
        const st = streamStatus(sdata);
        if (st !== status) return false;
      }
      return true;
    })
    .sort(([a], [b]) => {
      if (S.sort.key === 'stream') return S.sort.asc ? a.localeCompare(b) : b.localeCompare(a);
      const ap = S.data.streams[a][S.sort.key]?.v ?? null;
      const bp = S.data.streams[b][S.sort.key]?.v ?? null;
      if (ap === null && bp === null) return 0;
      if (ap === null) return 1;
      if (bp === null) return -1;
      return S.sort.asc ? ap - bp : bp - ap;
    });
}

function renderTable() {
  const params = S.visibleParams;
  if (!params.length) return;

  // Build header
  const thead = document.getElementById('qc-thead');
  thead.innerHTML = `<tr>
    <th class="col-stream sortable${S.sort.key === 'stream' ? ' sort-active' : ''}" data-sort="stream">
      Stream${S.sort.key === 'stream' ? (S.sort.asc ? ' ▲' : ' ▼') : ''}
    </th>
    ${params.map(p => {
      const active = S.sort.key === p;
      return `<th class="col-param sortable${active ? ' sort-active' : ''}" data-sort="${p}"
                title="${p.replace(/_/g,' ')} (${PARAMS[p].unit})">
        ${PARAMS[p].label}${active ? (S.sort.asc ? ' ▲' : ' ▼') : ''}
      </th>`;
    }).join('')}
  </tr>`;

  const rows = buildRows();
  const tbody = document.getElementById('qc-tbody');
  const empty = document.getElementById('tbl-empty');

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  // Group by network
  let lastNet = null;
  tbody.innerHTML = rows.map(([sid, sdata]) => {
    const parts = sid.split('.');
    const net   = parts[0];
    const netRow = (net !== lastNet)
      ? `<tr class="net-group-row"><td colspan="${params.length + 1}" class="net-group-cell">${esc(net)}</td></tr>`
      : '';
    lastNet = net;
    const stSta = `${parts[1]}${parts[2] ? '.'+parts[2] : ''}`;
    const cha   = parts[3] || '';
    const watched = S.watchlist.has(sid);
    const overallSt = streamStatus(sdata);

    const cells = params.map(p => {
      const entry = sdata[p];
      const val   = entry?.v ?? null;
      const age   = entry?.t ? Date.now() - entry.t : null;
      const st    = cellStatus(p, val);
      const stale = age !== null && age > 30 * 60_000;  // value older than 30 min
      const spark = entry?.spark ? buildSparkline(entry.spark) : '';
      return `<td class="qc-cell qc-${st}${stale ? ' qc-stale' : ''}"
                  data-stream="${esc(sid)}" data-param="${esc(p)}"
                  title="${esc(p.replace(/_/g,' '))}: ${PARAMS[p].fmt(val)}${isFuture(p, val) ? ' (timestamp in the future: station clock ahead?)' : ''}${stale ? ' (stale)' : ''}">
        <div class="cell-inner">
          <span class="cell-val">${PARAMS[p].fmt(val)}</span>
          ${spark}
        </div>
      </td>`;
    }).join('');

    return `${netRow}
    <tr class="stream-row qc-row-${overallSt}${watched ? ' watched' : ''}" data-stream="${esc(sid)}">
      <td class="col-stream-cell">
        <button class="watch-btn${watched?' watched':''}" data-stream="${esc(sid)}">${watched?'★':'☆'}</button>
        <span class="stream-sta">${esc(stSta)}</span>
        <span class="stream-cha">${esc(cha)}</span>
      </td>
      ${cells}
    </tr>`;
  }).join('');

  // Update visible count
  document.getElementById('tab-stats') &&
    (document.getElementById('tab-stats').textContent =
      rows.length < Object.keys(S.data.streams||{}).length
        ? `Showing ${rows.length} / ${Object.keys(S.data.streams).length}`
        : `${rows.length} streams`);
}

function buildSparkline(points) {
  if (!points || points.length < 2) return '';
  const vals = points.map(p => p[1]);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const range = mx - mn || 1;
  const W = 40, H = 12;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - mn) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  </svg>`;
}

// ══════════════════════════════════════════════════════════
// CHART PANEL  (uPlot)
// ══════════════════════════════════════════════════════════
function openChart(stream, param) {
  S.detailStream = stream;
  S.detailParam  = param;

  document.getElementById('chart-title').textContent = stream;
  document.getElementById('chart-param-label').textContent = PARAMS[param]?.label ?? param;
  document.getElementById('chart-panel').classList.remove('panel-closed');

  // Mark active cell
  document.querySelectorAll('.qc-cell.cell-active').forEach(c => c.classList.remove('cell-active'));
  document.querySelectorAll(`.qc-cell[data-stream="${CSS.escape(stream)}"][data-param="${CSS.escape(param)}"]`)
    .forEach(c => c.classList.add('cell-active'));

  loadChartData();
  if (_map && S.view === 'map') setTimeout(() => _map.invalidateSize(), 250);
}

function closeChart() {
  S.detailStream = null;
  document.getElementById('chart-panel').classList.add('panel-closed');
  if (_map && S.view === 'map') setTimeout(() => _map.invalidateSize(), 250);
  document.querySelectorAll('.qc-cell.cell-active').forEach(c => c.classList.remove('cell-active'));
  if (S.uplot) { S.uplot.destroy(); S.uplot = null; }
}

async function loadChartData() {
  const picker = document.querySelector('#chart-panel .tpick');
  if (!picker) return;
  document.getElementById('chart-wrap').innerHTML = '<div class="chart-loading">Loading…</div>';
  try {
    S.histData = await fetchRange(picker, S.detailParam);
    drawChart();
  } catch(_) {
    document.getElementById('chart-wrap').innerHTML = '<div class="chart-loading">Failed to load history.</div>';
  }
}

function drawChart() {
  if (!S.detailStream || !S.detailParam || !S.histData) return;

  const raw      = S.histData.streams?.[S.detailStream]?.[S.detailParam] ?? [];
  const filtered = raw; // API already scopes to requested range

  const wrap = document.getElementById('chart-wrap');
  wrap.innerHTML = '';

  if (!filtered.length) {
    wrap.innerHTML = '<div class="chart-loading">No data for this time range.</div>';
    return;
  }

  // uPlot expects timestamps in SECONDS
  const xs = filtered.map(([t]) => t / 1000);
  const ys = filtered.map(([,v]) => v);

  const param = S.detailParam;
  const pInfo = PARAMS[param] ?? { label: param, unit: '' };
  const thr   = S.prefs.thresholds[param];

  const isDark = document.body.classList.contains('dark');
  const textCol  = isDark ? '#94a3b8' : '#475569';
  const gridCol  = isDark ? '#1e293b' : '#e2e8f0';
  const lineCol  = '#2563eb';

  const opts = {
    width:  wrap.clientWidth || 500,
    height: 220,
    cursor: { show: true },
    series: [
      {},
      {
        label:  pInfo.label,
        stroke: lineCol,
        width:  2,
        fill:   'rgba(37,99,235,0.08)',
        value:  (u, v) => v == null ? '—' : pInfo.fmt(v),
      },
    ],
    axes: [
      { stroke: textCol, grid: { stroke: gridCol }, ticks: { stroke: gridCol }, values: fmtXAxis },
      {
        label:  pInfo.unit,
        stroke: textCol,
        grid:   { stroke: gridCol },
        ticks:  { stroke: gridCol },
        values: (u, vals) => vals.map(v => v == null ? '' : pInfo.fmt(v)),
      },
    ],
    scales: { x: { time: true } },
    padding: [10, 12, 0, 10],
  };

  // Draw threshold bands if defined
  if (thr) {
    opts.hooks = {
      draw: [u => {
        const ctx  = u.ctx;
        const { left, top, width, height } = u.bbox;
        ctx.save();
        // warn band
        const warnY  = u.valToPos(thr.warn,  'y', true);
        const alertY = u.valToPos(thr.alert, 'y', true);
        if (thr.lowerWorse) {
          ctx.fillStyle = cssAlpha('--s-warn', 0.1);
          ctx.fillRect(left, alertY, width, warnY - alertY);
          ctx.fillStyle = cssAlpha('--s-alert', 0.1);
          ctx.fillRect(left, top, width, alertY - top);
        } else {
          ctx.fillStyle = cssAlpha('--s-warn', 0.1);
          ctx.fillRect(left, warnY, width, alertY - warnY);
          ctx.fillStyle = cssAlpha('--s-alert', 0.1);
          ctx.fillRect(left, alertY, width, top + height - alertY);
        }
        ctx.restore();
      }],
    };
  }

  // Cursor tooltip
  if (!opts.hooks) opts.hooks = {};
  opts.hooks.setCursor = [u => {
    const tt = document.getElementById('chart-tooltip');
    const { idx } = u.cursor;
    if (idx == null || u.cursor.left < 0) { tt.style.display = 'none'; return; }
    const rect = u.over.getBoundingClientRect();
    const cx = rect.left + u.cursor.left, cy = rect.top + u.cursor.top;
    const ts = new Date(xs[idx] * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const v  = ys[idx];
    const st = cellStatus(S.detailParam, v);
    tt.innerHTML = `<div class="ct-time">${ts}</div>` +
      `<div class="ct-row"><span class="ct-dot" style="background:#2563eb"></span>` +
      `<span class="ct-lbl">${esc(pInfo.label)}</span>` +
      `<span class="ct-val qc-${st}">${pInfo.fmt(v)}</span></div>`;
    tt.style.display = 'block';
    posTooltip(tt, cx, cy);
  }];

  if (S.uplot) { S.uplot.destroy(); S.uplot = null; }
  S.uplot = new uPlot(opts, [xs, ys], wrap);
  S.uplot.over.addEventListener('mouseleave', () => {
    document.getElementById('chart-tooltip').style.display = 'none';
  });

  // Stats bar
  const nonNull = ys.filter(v => v != null);
  if (nonNull.length) {
    const mn = Math.min(...nonNull), mx = Math.max(...nonNull);
    const avg = nonNull.reduce((s,v) => s+v, 0) / nonNull.length;
    document.getElementById('chart-stats').innerHTML =
      `<span>min <strong>${pInfo.fmt(mn)}</strong></span>` +
      `<span>avg <strong>${pInfo.fmt(avg)}</strong></span>` +
      `<span>max <strong>${pInfo.fmt(mx)}</strong></span>` +
      `<span class="chart-pts">${nonNull.length} points</span>`;
  } else {
    document.getElementById('chart-stats').innerHTML = '<span class="chart-pts">No data points</span>';
  }
}

// ══════════════════════════════════════════════════════════
// GRID VIEW
// ══════════════════════════════════════════════════════════
function aggregateStation(streamMap) {
  const merged = {};
  for (const sdata of Object.values(streamMap)) {
    for (const [param, entry] of Object.entries(sdata)) {
      if (!merged[param]) { merged[param] = { ...entry }; continue; }
      if (entry.v == null) continue;
      if (merged[param].v == null) { merged[param] = { ...entry }; continue; }
      const thr = S.prefs.thresholds[param];
      if (!thr) { merged[param] = { ...entry }; continue; }
      const isWorse = thr.lowerWorse ? entry.v < merged[param].v : entry.v > merged[param].v;
      if (isWorse) merged[param] = { ...entry };
    }
  }
  return merged;
}

function renderGrid() {
  const wrap = document.getElementById('grid-wrap');
  if (!wrap || !S.data) return;
  const { net, search, param: pf, status: sf } = S.filter;
  const q = (search || '').toLowerCase();

  const stations = {};
  for (const [sid, sdata] of Object.entries(S.data.streams || {})) {
    const parts = sid.split('.');
    const stid = parts[0] + '.' + parts[1];
    if (!stations[stid]) stations[stid] = { net: parts[0], streams: {} };
    stations[stid].streams[sid] = sdata;
  }

  const nets = {};
  for (const [stid, stData] of Object.entries(stations)) {
    if (net    && stData.net !== net) continue;
    if (search && !stid.toLowerCase().includes(q)) continue;
    const merged = aggregateStation(stData.streams);
    if (pf && !merged[pf]) continue;
    const st = streamStatus(merged);
    if (sf && st !== sf) continue;
    if (!nets[stData.net]) nets[stData.net] = [];
    nets[stData.net].push([stid, stData, merged, st]);
  }

  if (!Object.keys(nets).length) {
    wrap.innerHTML = '<div class="empty-state">No stations match the current filters.</div>';
    return;
  }

  let html = '';
  for (const [nc, stList] of Object.entries(nets).sort()) {
    const okCount = stList.filter(([,,,st]) => st === 'ok').length;
    html += `<div class="net-section">
      <div class="net-header">
        <span class="net-code">${esc(nc)}</span>
        <span class="net-count">(${stList.length})</span>
        <span class="net-ok-ratio">${okCount}/${stList.length} ok</span>
      </div>
      <div class="sta-grid">`;
    for (const [stid, stData, merged, st] of stList.sort(([a],[b]) => a.localeCompare(b)))
      html += buildGridCard(stid, merged, st, Object.keys(stData.streams).length);
    html += `</div></div>`;
  }
  wrap.innerHTML = html;
}

function buildGridCard(stid, merged, worstSt, streamCount) {
  const sta = stid.split('.')[1];

  // Find the param driving the worst status to display its value
  const badParam = S.visibleParams.find(p => cellStatus(p, merged[p]?.v ?? null) === worstSt)
    ?? S.visibleParams[0];
  const val = badParam ? PARAMS[badParam]?.fmt(merged[badParam]?.v ?? null) : '—';
  const lbl = badParam ? PARAMS[badParam]?.label : '';

  // Rich tooltip: all visible QC values
  const tip = [stid, streamCount + ' stream' + (streamCount !== 1 ? 's' : ''),
    ...S.visibleParams.map(p => `${PARAMS[p].label}: ${PARAMS[p].fmt(merged[p]?.v ?? null)}`)
  ].join('\n');

  return `<div class="sta-card qc-${worstSt}" data-stid="${esc(stid)}" title="${esc(tip)}">
    <span class="card-code">${esc(sta)}</span>
    <span class="card-val">${esc(val)}</span>
    <span class="card-lbl">${esc(lbl)}</span>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// MAP VIEW
// ══════════════════════════════════════════════════════════
// Operational map: every station is drawn (no clustering, so a bad station is
// never hidden inside a cluster), problems on top of healthy ones, with a
// "needs attention" list next to the map. Colour by overall status or by one
// threshold parameter.
let _map = null, _markerLayer = null, _pulseLayer = null;
let _mapMarkers  = {};       // station key → circleMarker
let _mapPopupKey = null;     // station whose popup is open (kept across refreshes)
let _mapFitted   = false;
const MAP_LABEL_ZOOM = 7;    // permanent station labels from this zoom
const MAP_RECENT_MS  = 15 * 60_000;   // pulse stations that changed this recently
const STALE_MS       = 30 * 60_000;   // same rule as the table's stale cells
// Colours live in style.css only (one source, follows the theme)
const STATUS_COLOR   = { ok: 'var(--s-ok)', warn: 'var(--s-warn)', alert: 'var(--s-alert)', nodata: 'var(--s-nodata)' };
const STATUS_LABEL   = { alert: 'Alert', nodata: 'No data', warn: 'Warning', ok: 'OK' };

function initMap() {
  if (_map) return;
  const container = document.getElementById('map');
  if (!container) return;
  // No worldCopyJump: it would jump the view back into -180..180 and leave
  // behind stations moved past 180° by lonShiftFor()
  _map = L.map(container, { preferCanvas: true }).setView([20, 10], 2);
  _pulseLayer  = L.layerGroup().addTo(_map);
  _markerLayer = L.layerGroup().addTo(_map);
  const saved = mapPrefs();
  setBaseMap(saved.base || DEFAULT_BASE);
  if (saved.plates) togglePlates(true);
  document.getElementById('map-base').value = BASE_MAPS[saved.base] ? saved.base : DEFAULT_BASE;
  document.getElementById('map-plates').checked = !!saved.plates;
  if (saved?.c && saved?.z != null && !DEMO) { _map.setView(saved.c, saved.z); _mapFitted = true; }
  _map.on('moveend', () => {
    const c = _map.getCenter();
    mapPrefs({ c: [c.lat, c.lng], z: _map.getZoom() });
  });
  let lastLabels = null;
  _map.on('zoomend', () => {
    const labels = _map.getZoom() >= MAP_LABEL_ZOOM;
    if (labels !== lastLabels) { lastLabels = labels; refreshMapMarkers(); }
  });
  _map.on('popupclose', () => { _mapPopupKey = null; });
  setTimeout(() => _map.invalidateSize(), 150);
  if (S.prefs.fdsnws || DEMO) fetchCoordinates().then(() => refreshMapMarkers());
}

// Map view settings in localStorage: centre, zoom, base map, overlays
function mapPrefs(update) {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('qclog2-map') || '{}') || {}; } catch(_) {}
  if (update) {
    p = { ...p, ...update };
    try { localStorage.setItem('qclog2-map', JSON.stringify(p)); } catch(_) {}
  }
  return p;
}

// Base maps: keyless tile services only (no API key or account to set up).
// Check each provider's terms for your use: OSM asks heavy users to run their
// own tile server; Esri tiles are free to view but Esri's terms ask for an
// ArcGIS account for production use. NASA GIBS and USGS are public.
const OSM_ATTR  = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_ATTR = 'Tiles © Esri';
const NASA_ATTR = 'Imagery © NASA EOSDIS GIBS';
const USGS_ATTR = 'Tiles courtesy of the U.S. Geological Survey';
const esriUrl   = s => `https://server.arcgisonline.com/ArcGIS/rest/services/${s}/MapServer/tile/{z}/{y}/{x}`;
const gibsUrl   = (layer, ext) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.${ext}`;
const BASE_MAPS = {
  osm:        { label: 'OpenStreetMap',            darkFilter: true,  layers: [['https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: OSM_ATTR }]] },
  openTopo:   { label: 'OpenTopoMap',              darkFilter: true,  layers: [['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { attribution: '© OpenTopoMap (CC-BY-SA), ' + OSM_ATTR, maxNativeZoom: 17 }]] },
  blueMarble: { label: 'Blue Marble relief (NASA)', layers: [[gibsUrl('BlueMarble_ShadedRelief_Bathymetry', 'jpeg'), { attribution: NASA_ATTR, maxNativeZoom: 8 }]] },
  nightLights:{ label: 'Earth at night (NASA)',    layers: [[gibsUrl('VIIRS_CityLights_2012', 'jpg'), { attribution: NASA_ATTR, maxNativeZoom: 8 }]] },
  usgsTopo:   { label: 'USGS Topo (US)',           layers: [['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', { attribution: USGS_ATTR, maxNativeZoom: 16 }]] },
  esriDark:   { label: 'Dark gray (Esri)',         layers: [[esriUrl('Canvas/World_Dark_Gray_Base'), { attribution: ESRI_ATTR }], [esriUrl('Canvas/World_Dark_Gray_Reference'), {}]] },
  esriLight:  { label: 'Light gray (Esri)',        layers: [[esriUrl('Canvas/World_Light_Gray_Base'), { attribution: ESRI_ATTR }], [esriUrl('Canvas/World_Light_Gray_Reference'), {}]] },
  esriOcean:  { label: 'Ocean (Esri)',             layers: [[esriUrl('Ocean/World_Ocean_Base'), { attribution: ESRI_ATTR + ', GEBCO, NOAA' }], [esriUrl('Ocean/World_Ocean_Reference'), {}]] },
  esriRelief: { label: 'Shaded relief (Esri)',     layers: [[esriUrl('World_Shaded_Relief'), { attribution: ESRI_ATTR, maxNativeZoom: 13 }]] },
  esriImagery:{ label: 'Satellite (Esri)',         layers: [[esriUrl('World_Imagery'), { attribution: ESRI_ATTR }]] },
  outline:    { label: 'Outline (offline)',        layers: [] },   // bundled Natural Earth, see outlineLayer()
};
const DEFAULT_BASE = 'outline';
let _baseLayer = null, _platesLayer = null, _outline = null;

function setBaseMap(key) {
  if (!BASE_MAPS[key]) key = DEFAULT_BASE;
  const def = BASE_MAPS[key];
  if (_baseLayer) _map.removeLayer(_baseLayer);
  _baseLayer = L.layerGroup(def.layers.map(([url, opts]) =>
    L.tileLayer(url, { maxZoom: 18, subdomains: 'abc', ...opts }))).addTo(_map);
  const el = document.getElementById('map');
  // Darken light street maps in the dark theme; the other base maps are left as they are
  el.classList.toggle('tiles-darken', !!def.darkFilter);
  el.classList.toggle('map-outline', key === 'outline');
  const grp = _baseLayer;   // ignore the load if the base map changed meanwhile
  if (key === 'outline') outlineLayer().then(l => { if (l && _baseLayer === grp) grp.addLayer(l); });
}

// Offline base map: Natural Earth 1:50m land and borders (public domain),
// shipped in geo/. Works without internet access. Colours come from CSS so
// the theme switch restyles it.
async function outlineLayer() {
  if (_outline) return _outline;
  if (!_map.getPane('outline')) _map.createPane('outline').style.zIndex = 150;
  try {
    const [land, borders] = await Promise.all([
      fetchJSON('geo/ne_50m_land.json'), fetchJSON('geo/ne_50m_borders.json')]);
    const opts = { pane: 'outline', interactive: false, renderer: L.svg({ pane: 'outline' }) };
    _outline = L.layerGroup([
      wrappedGeoJSON(land,    { ...opts, attribution: 'Outline: Natural Earth', style: { className: 'ol-land', weight: 0.8 } }),
      wrappedGeoJSON(borders, { ...opts, style: { className: 'ol-border', weight: 0.6, dashArray: '3 3' } }),
    ]);
  } catch(_) { return null; }
  return _outline;
}

// ── Antimeridian ─────────────────────────────────────────────────────────────
// A network across 180° (Aleutians, Fiji, Tonga, Kermadecs) would be split
// over both edges of the map, and fitting to it would zoom out to the whole
// world. If the widest longitude gap between stations is more than 180° and
// not the one across 180°, the stations on one side of it are moved by 360°
// so the network is drawn in one piece. The outline and plate layers get a
// copy shifted the same way, so the land under the moved stations is there.
let _lonShift = null;      // { cut, by }: see lonShiftFor()
const _geoWrap = [];       // geo layers that get a shifted copy, see wrappedGeoJSON()

// lons: station longitudes in -180..180. Returns null (no shift needed) or
// { cut, by }: by = +360 moves lon < cut, by = -360 moves lon > cut. The side
// is chosen so the network's centre stays within -180..180.
function lonShiftFor(lons) {
  if (lons.length < 2) return null;
  const s = [...lons].sort((a, b) => a - b);
  let gap = s[0] + 360 - s[s.length - 1], i0 = -1;     // start with the gap across 180°
  for (let i = 1; i < s.length; i++)
    if (s[i] - s[i - 1] > gap) { gap = s[i] - s[i - 1]; i0 = i; }
  if (i0 < 0 || gap <= 180) return null;                // already compact, or spread worldwide
  const cut = (s[i0] + s[i0 - 1]) / 2;
  const mid = (s[i0] + s[i0 - 1] + 360) / 2;           // centre if the west side moves east
  return mid <= 180 ? { cut, by: 360 } : { cut, by: -360 };
}

function shiftLon(lon) {
  const s = _lonShift;
  if (!s) return lon;
  return s.by > 0 ? (lon < s.cut ? lon + 360 : lon) : (lon > s.cut ? lon - 360 : lon);
}

// A geoJSON layer that also gets a copy of the features on the moved side,
// shifted by 360°, once _lonShift is known (the geo files and the station
// coordinates load in either order).
function wrappedGeoJSON(data, opts) {
  const e = { group: L.featureGroup([L.geoJSON(data, opts)]), data, opts, done: false };
  _geoWrap.push(e);
  addWrapCopy(e);
  return e.group;
}

function addWrapCopy(e) {
  const s = _lonShift;
  if (!s || e.done) return;
  e.done = true;
  const moved = s.by > 0 ? lon => lon < s.cut : lon => lon > s.cut;
  const anyLon = c => Array.isArray(c) && (typeof c[0] === 'number' ? moved(c[0]) : c.some(anyLon));
  e.group.addLayer(L.geoJSON(e.data, { ...e.opts, attribution: undefined,
    filter: f => anyLon(f.geometry?.coordinates),
    coordsToLatLng: c => L.latLng(c[1], c[0] + s.by) }));
}

async function togglePlates(on) {
  if (!on) { if (_platesLayer) _map.removeLayer(_platesLayer); return; }
  if (!_platesLayer) {
    try {
      const gj = await fetchJSON('geo/PB2002_boundaries.json');
      _platesLayer = wrappedGeoJSON(gj, { interactive: false,
        style: { color: '#e11d48', weight: 1.5, opacity: 0.6 },
        attribution: 'Plate boundaries: Bird (2003), PB2002' });
    } catch(_) { return; }
  }
  _platesLayer.addTo(_map);
  _platesLayer.bringToBack();
}

function fitMapToStations(keys) {
  const pts = keys.map(k => S.coordinates[k]).filter(Boolean);
  if (pts.length) _map.fitBounds(pts, { padding: [30, 30], maxZoom: 8 });
}

// Group streams into stations and work out what is wrong with each one.
// colorBy '' = overall status (worst over all parameters and streams),
// otherwise the status of that one parameter.
function mapStations(colorBy) {
  const stations = {};
  for (const [sid, sdata] of Object.entries(S.data?.streams || {})) {
    const p = sid.split('.');
    const key = p[0] + '.' + p[1];
    (stations[key] ||= { key, net: p[0], sta: p[1], streams: {} }).streams[sid] = sdata;
  }
  const now = Date.now();
  for (const st of Object.values(stations)) {
    let status = 'ok', culprits = [], newest = 0;
    for (const [sid, sdata] of Object.entries(st.streams)) {
      for (const [param, entry] of Object.entries(sdata)) {
        if (entry?.t > newest) newest = entry.t;
        if (colorBy && param !== colorBy) continue;
        if (!PARAMS[param]) continue;
        let cs = cellStatus(param, entry?.v ?? null);
        if (cs === 'info') cs = 'ok';
        if (STATUS_RANK[cs] > STATUS_RANK[status]) { status = cs; culprits = []; }
        if (cs === status && cs !== 'ok') culprits.push({ sid, param, v: entry?.v ?? null });
      }
    }
    if (colorBy && !Object.values(st.streams).some(s => s[colorBy])) status = 'nodata';
    // Report culprits in the order the table shows parameters
    const order = S.visibleParams;
    culprits.sort((a, b) => order.indexOf(a.param) - order.indexOf(b.param));
    const seen = new Set();
    st.reasons = culprits.filter(c => !seen.has(c.param) && seen.add(c.param))
      .map(c => c.v == null ? PARAMS[c.param].label
        : `${PARAMS[c.param].label} ${PARAMS[c.param].fmt(c.v)}${isFuture(c.param, c.v) ? ' (in the future)' : ''}`);
    st.status = status;
    st.newest = newest || null;
    st.stale  = newest > 0 && now - newest > STALE_MS;
    st.watched = Object.keys(st.streams).some(s => S.watchlist.has(s));
    // When did the current status start? Most recent matching event (S.events is newest first)
    st.since = null;
    if (status !== 'ok') {
      const ev = S.events.find(e => e.to === status && st.streams[e.stream]);
      if (ev) st.since = ev.ts;
    }
  }
  return stations;
}

function mapStationVisible(st) {
  const { net, search, param, status } = S.filter;
  if (net && st.net !== net) return false;
  if (search && !st.key.toLowerCase().includes(search.toLowerCase())) return false;
  if (param && !Object.values(st.streams).some(s => s[param])) return false;
  if (status && st.status !== status) return false;
  if (S.watchlistOnly && !st.watched) return false;
  return true;
}

function mapReason(st) {
  if (st.status === 'ok') return st.stale ? 'No recent values' : 'OK';
  return st.reasons.length ? st.reasons.join(' · ') : STATUS_LABEL[st.status];
}

function mapPopupHtml(st) {
  const params = S.visibleParams;
  const rows = Object.entries(st.streams).sort().map(([sid, sdata]) => {
    const p = sid.split('.');
    const chips = params.filter(pr => sdata[pr]).map(pr => {
      const v = sdata[pr].v ?? null;
      const cs = cellStatus(pr, v);
      return `<span class="mp-chip qc-${cs}" title="${esc(pr.replace(/_/g, ' '))}">${PARAMS[pr].label} <b>${esc(PARAMS[pr].fmt(v))}</b></span>`;
    }).join('');
    const worst = params.find(pr => sdata[pr] && cellStatus(pr, sdata[pr].v ?? null) === streamStatus(sdata)) || params.find(pr => sdata[pr]);
    return `<div class="mp-stream">
      <div class="mp-stream-head"><span class="mp-cha">${esc((p[2] ? p[2] + '.' : '') + (p[3] || ''))}</span>
        <button class="mp-btn" data-act="chart" data-stream="${esc(sid)}" data-param="${esc(worst || '')}">Chart</button>
        <button class="mp-btn" data-act="history" data-stream="${esc(sid)}" data-param="${esc(worst || '')}">History</button></div>
      <div class="mp-chips">${chips}</div></div>`;
  }).join('');
  const since = st.since ? ` · for ${fmtSec((Date.now() - st.since) / 1000)}` : '';
  const age = st.newest ? fmtSec((Date.now() - st.newest) / 1000) + ' ago' : '—';
  return `<div class="mp">
    <div class="mp-head"><span class="mp-code">${esc(st.key)}</span>
      <span class="mp-status qc-${st.status}">${STATUS_LABEL[st.status]}</span></div>
    <div class="mp-reason">${esc(mapReason(st))}${since}</div>
    ${rows}
    <div class="mp-foot">Last value ${esc(age)}${st.stale ? ' <span class="mp-stale">stale</span>' : ''}
      <button class="mp-btn" data-act="table" data-stid="${esc(st.key)}">Table</button></div>
  </div>`;
}

function renderMapSide(all, visible, colorBy) {
  // Colour-by selector: overall status + every threshold parameter in the data
  const sel = document.getElementById('map-color');
  const opts = [['', 'Overall status'],
    ...S.visibleParams.filter(p => S.prefs.thresholds[p]).map(p => [p, PARAMS[p].label])];
  const optHtml = opts.map(([v, l]) => `<option value="${v}"${v === colorBy ? ' selected' : ''}>${esc(l)}</option>`).join('');
  if (sel.innerHTML !== optHtml) sel.innerHTML = optHtml;

  const counts = { alert: 0, nodata: 0, warn: 0, ok: 0 };
  for (const st of visible) counts[st.status]++;
  document.getElementById('map-counts').innerHTML = Object.entries(counts).map(([s, n]) =>
    `<button class="map-count qc-${s}${S.mapHide.has(s) ? ' off' : ''}" data-status="${s}"
       title="Show/hide ${STATUS_LABEL[s].toLowerCase()} stations on the map">
       <span class="map-dot" style="background:${STATUS_COLOR[s]}"></span>${n} <span>${STATUS_LABEL[s]}</span></button>`).join('');

  const problems = visible.filter(st => st.status !== 'ok')
    .sort((a, b) => (STATUS_RANK[b.status] - STATUS_RANK[a.status])
                 || ((b.since ?? 0) - (a.since ?? 0)) || a.key.localeCompare(b.key));
  document.getElementById('map-problems-count').textContent = problems.length ? `(${problems.length})` : '';
  document.getElementById('map-problems').innerHTML = problems.length
    ? problems.map(st => {
        const dur = st.since ? fmtSec((Date.now() - st.since) / 1000) : '';
        const recent = st.since && Date.now() - st.since < MAP_RECENT_MS;
        return `<div class="map-prob${st.key === _mapPopupKey ? ' sel' : ''}" data-stid="${esc(st.key)}">
          <span class="map-dot" style="background:${STATUS_COLOR[st.status]}"></span>
          <span class="map-prob-code">${esc(st.key)}${st.watched ? ' ★' : ''}</span>
          <span class="map-prob-dur${recent ? ' recent' : ''}" title="${st.since ? 'Since ' + fmtTime(st.since) : 'Start unknown'}">${recent ? 'new' : esc(dur)}</span>
          <span class="map-prob-why">${esc(mapReason(st))}${S.coordinates[st.key] ? '' : ' · <em>no coordinates</em>'}</span>
        </div>`;
      }).join('')
    : '<div class="map-allok">All stations OK</div>';

  const noCoords = all.filter(st => !S.coordinates[st.key]).length;
  const hasCoords = Object.keys(S.coordinates).length > 0;
  document.getElementById('map-foot').textContent = !hasCoords
    ? (S.prefs.fdsnws || DEMO ? 'Loading station coordinates…' : 'Set an FDSNWS URL in Settings to place stations on the map.')
    : `${all.length - noCoords} of ${all.length} stations on the map` + (noCoords ? ` · ${noCoords} without coordinates` : '');
}

async function fetchCoordinates() {
  if (Object.keys(S.coordinates).length) return;
  if (!S.prefs.fdsnws && !DEMO) return;
  try {
    // Demo: a static file in FDSNWS station text format
    const url = DEMO ? DEMO_DIR + 'stations.txt'
      : S.prefs.fdsnws.replace(/\/$/, '') + '/station/1/query?level=station&format=text&nodata=404';
    const r = await fetch(url);
    if (!r.ok) return;
    const text = await r.text();
    const coords = {};
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue;
      const p = line.split('|');
      if (p.length < 4) continue;
      const lat = parseFloat(p[2]), lon = parseFloat(p[3]);
      if (!isNaN(lat) && !isNaN(lon))
        coords[p[0].trim() + '.' + p[1].trim()] = [lat, ((lon + 540) % 360) - 180];
    }
    // Decide the antimeridian shift on the stations that have QC data (the
    // inventory may hold far-away stations that are not monitored)
    const qc = new Set(Object.keys(S.data?.streams || {}).map(sid => sid.split('.').slice(0, 2).join('.')));
    let lons = Object.entries(coords).filter(([k]) => qc.has(k)).map(([, ll]) => ll[1]);
    if (!lons.length) lons = Object.values(coords).map(ll => ll[1]);
    _lonShift = lonShiftFor(lons);
    for (const [k, [lat, lon]] of Object.entries(coords)) S.coordinates[k] = [lat, shiftLon(lon)];
    _geoWrap.forEach(addWrapCopy);
  } catch(_) {}
}

function refreshMapMarkers() {
  if (!_map || !_markerLayer || !S.data) return;
  const colorBy  = S.mapColor && S.prefs.thresholds[S.mapColor] ? S.mapColor : '';
  const all      = Object.values(mapStations(colorBy));
  const visible  = all.filter(mapStationVisible);
  renderMapSide(all, visible, colorBy);

  const openKey = _mapPopupKey;
  _markerLayer.clearLayers();
  _pulseLayer.clearLayers();
  _mapMarkers = {};
  const labels = _map.getZoom() >= MAP_LABEL_ZOOM;
  const now = Date.now();
  // Draw healthy first so problems are painted on top
  const drawOrder = visible.filter(st => S.coordinates[st.key] && !S.mapHide.has(st.status))
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  for (const st of drawOrder) {
    const ll  = S.coordinates[st.key];
    const col = STATUS_COLOR[st.status];
    const bad = st.status === 'alert' || st.status === 'nodata';
    const size = bad ? 20 : st.status === 'warn' ? 17 : 14;
    const m = L.marker(ll, {
      icon: stationIcon(col, size, st.stale, st.watched, st.status === 'ok'),
      zIndexOffset: STATUS_RANK[st.status] * 1000,   // problems above healthy stations
      riseOnHover: true,
    });
    m.bindPopup(() => mapPopupHtml(st), { maxWidth: 360, minWidth: 240 });
    m.on('popupopen', e => {
      _mapPopupKey = st.key;
      highlightMapProblem(st.key);
      // Leaflet stops click propagation in popups, so bind the buttons here
      e.popup.getElement()?.querySelectorAll('.mp-btn').forEach(b =>
        b.addEventListener('click', () => mapPopupAction(b.dataset)));
    });
    if (labels)
      m.bindTooltip(esc(st.sta), { permanent: true, direction: 'right', offset: [size / 2, 0], className: 'map-label' });
    else
      m.bindTooltip(`<b>${esc(st.key)}</b><br>${esc(mapReason(st))}`, { direction: 'top', offset: [0, -size / 2] });
    m.addTo(_markerLayer);
    _mapMarkers[st.key] = m;
    if (st.status !== 'ok' && st.since && now - st.since < MAP_RECENT_MS)
      L.marker(ll, { interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'map-pulse', html: `<span style="--c:${col}"></span>`, iconSize: [36, 36] }) })
        .addTo(_pulseLayer);
  }
  if (openKey && _mapMarkers[openKey]) _mapMarkers[openKey].openPopup();

  if (!_mapFitted && Object.keys(S.coordinates).length) {
    _mapFitted = true;
    fitMapToStations(all.map(st => st.key));
  }
}

// Inverted triangle, the usual seismic station symbol. The point is the station.
// Stale = faded and dashed; watchlisted = blue outline. Problems get a white
// edge and a shadow; OK stations a thin dark edge and no shadow (quiet, but
// still visible on white land or light tiles). col is a CSS colour, so it is
// set with style (SVG presentation attributes do not resolve var()).
function stationIcon(col, size, stale, watched, quiet) {
  const w = size, h = Math.round(size * 0.9);
  const stroke = watched ? '#2563eb' : quiet ? 'var(--s-ok-edge)' : '#fff';
  const sw = watched ? 2.5 : quiet ? 1.2 : 1.5;
  const tri = 'M1.5 1.5 H18.5 L10 16.5 Z';
  // OK: a light halo under the dark edge, so it shows on dark imagery as well as on white
  const halo = quiet && !watched
    ? `<path d="${tri}" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="3.2" stroke-linejoin="round"/>` : '';
  const svg = `<svg width="${w}" height="${h}" viewBox="0 0 20 18">${halo}
    <path d="${tri}" style="fill:${col};stroke:${stroke}" fill-opacity="${stale ? 0.35 : 1}"
      stroke-width="${sw}" stroke-linejoin="round"${stale ? ' stroke-dasharray="3 2"' : ''}/></svg>`;
  return L.divIcon({ className: 'sta-tri' + (quiet ? ' quiet' : ''), html: svg, iconSize: [w, h],
    iconAnchor: [w / 2, h / 2], popupAnchor: [0, -h / 2], tooltipAnchor: [0, 0] });
}

function highlightMapProblem(key) {
  document.querySelectorAll('.map-prob').forEach(el => el.classList.toggle('sel', el.dataset.stid === key));
}

function focusMapStation(key) {
  const ll = S.coordinates[key];
  if (!ll) return;
  _map.setView(ll, Math.max(_map.getZoom(), MAP_LABEL_ZOOM));   // may redraw (labels)
  if (!_mapMarkers[key]) { S.mapHide.clear(); refreshMapMarkers(); }   // its status was hidden
  _mapMarkers[key]?.openPopup();
}

function mapPopupAction({ act, stream, param, stid }) {
  if (act === 'table') return showStationInTable(stid);
  if (!param) return;
  if (act === 'chart') return openChart(stream, param);
  populateHistStream();
  document.getElementById('hist-stream').value = stream;
  const hp = document.getElementById('hist-param');
  if ([...hp.options].some(o => o.value === param)) hp.value = param;
  switchView('history');
  loadHistoryChart();
}

function showStationInTable(stid) {
  const sta = stid.split('.')[1] || stid;
  S.filter.search = sta;
  document.getElementById('search').value = sta;
  switchView('table');
}

// ══════════════════════════════════════════════════════════
// HISTORY VIEW
// ══════════════════════════════════════════════════════════
function populateHistStream() {
  const sel = document.getElementById('hist-stream');
  if (!sel || !S.data) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select stream…</option>' +
    Object.keys(S.data.streams || {}).sort()
      .map(sid => `<option${sid === cur ? ' selected' : ''}>${esc(sid)}</option>`)
      .join('');
}

async function loadHistoryChart() {
  const stream = document.getElementById('hist-stream')?.value;
  const param  = document.getElementById('hist-param')?.value;
  const wrap   = document.getElementById('history-chart-wrap');
  if (!stream) {
    wrap.innerHTML = '<div class="chart-loading">Select a stream first.</div>';
    return;
  }
  const picker  = document.querySelector('#view-history .tpick');
  if (!picker) return;
  wrap.innerHTML = '<div class="chart-loading">Loading…</div>';
  document.getElementById('history-stats').innerHTML = '';
  document.getElementById('history-table-wrap').innerHTML = '';
  try {
    const data = await fetchRange(picker, param);
    drawHistoryChart(data, stream, param, data.from, data.to);
  } catch(_) {
    wrap.innerHTML = '<div class="chart-loading">Failed to load history data.</div>';
  }
}

let _histPlot    = null;
let _histSeries  = null;   // { stream, param, from_ms, to_ms, points }
let _histAllData = null;   // full JSON from last fetchRange (all streams)

function drawHistoryChart(histData, stream, param, from_ms, to_ms) {
  const raw      = histData.streams?.[stream]?.[param] ?? [];
  const filtered = raw; // API already scopes to requested range
  const wrap     = document.getElementById('history-chart-wrap');
  wrap.innerHTML = '';
  _histSeries  = null;
  _histAllData = histData;   // always store full data for bulk exports
  const exportBtn    = document.getElementById('hist-export-btn');
  const exportAllBtn = document.getElementById('hist-export-all-btn');
  const exportSumBtn = document.getElementById('hist-export-sum-btn');
  if (exportBtn)    exportBtn.disabled    = true;
  if (exportAllBtn) exportAllBtn.disabled = true;
  if (exportSumBtn) exportSumBtn.disabled = true;

  if (!filtered.length) {
    wrap.innerHTML = '<div class="chart-loading">No data in this time range.</div>';
    return;
  }

  const xs     = filtered.map(([t]) => t / 1000);
  const ys     = filtered.map(([,v]) => v);
  const pInfo  = PARAMS[param] ?? { label: param, unit: '' };
  const thr    = S.prefs.thresholds[param];
  const isDark = document.body.classList.contains('dark');
  const textCol = isDark ? '#94a3b8' : '#475569';
  const gridCol = isDark ? '#1e293b' : '#e2e8f0';

  const opts = {
    width:  wrap.clientWidth || 700,
    height: 260,
    cursor: { show: true },
    series: [
      {},
      { label: pInfo.label, stroke: '#2563eb', width: 2, fill: 'rgba(37,99,235,0.08)',
        value: (u, v) => v == null ? '—' : pInfo.fmt(v) },
    ],
    axes: [
      { stroke: textCol, grid: { stroke: gridCol }, ticks: { stroke: gridCol }, values: fmtXAxis },
      { label: pInfo.unit, stroke: textCol, grid: { stroke: gridCol }, ticks: { stroke: gridCol },
        values: (u, vals) => vals.map(v => v == null ? '' : pInfo.fmt(v)) },
    ],
    scales: { x: { time: true } },
    padding: [10, 12, 0, 10],
  };

  if (thr) {
    opts.hooks = { draw: [u => {
      const ctx = u.ctx;
      const { left, top, width, height } = u.bbox;
      ctx.save();
      const warnY  = u.valToPos(thr.warn,  'y', true);
      const alertY = u.valToPos(thr.alert, 'y', true);
      if (thr.lowerWorse) {
        ctx.fillStyle = cssAlpha('--s-warn', 0.1); ctx.fillRect(left, alertY, width, warnY - alertY);
        ctx.fillStyle = cssAlpha('--s-alert', 0.1);  ctx.fillRect(left, top, width, alertY - top);
      } else {
        ctx.fillStyle = cssAlpha('--s-warn', 0.1); ctx.fillRect(left, warnY, width, alertY - warnY);
        ctx.fillStyle = cssAlpha('--s-alert', 0.1);  ctx.fillRect(left, alertY, width, top + height - alertY);
      }
      ctx.restore();
    }]};
  }

  // Cursor tooltip
  if (!opts.hooks) opts.hooks = {};
  opts.hooks.setCursor = [u => {
    const tt = document.getElementById('chart-tooltip');
    const { idx } = u.cursor;
    if (idx == null || u.cursor.left < 0) { tt.style.display = 'none'; return; }
    const rect = u.over.getBoundingClientRect();
    const cx = rect.left + u.cursor.left, cy = rect.top + u.cursor.top;
    const ts = new Date(xs[idx] * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const v  = ys[idx];
    const st = cellStatus(param, v);
    tt.innerHTML = `<div class="ct-time">${ts}</div>` +
      `<div class="ct-row"><span class="ct-dot" style="background:#2563eb"></span>` +
      `<span class="ct-lbl">${esc(pInfo.label)}</span>` +
      `<span class="ct-val qc-${st}">${pInfo.fmt(v)}</span></div>`;
    tt.style.display = 'block';
    posTooltip(tt, cx, cy);
  }];

  if (_histPlot) { _histPlot.destroy(); _histPlot = null; }
  _histPlot = new uPlot(opts, [xs, ys], wrap);
  _histPlot.over.addEventListener('mouseleave', () => {
    document.getElementById('chart-tooltip').style.display = 'none';
  });

  const nonNull = ys.filter(v => v != null);
  let statsHtml = '';
  if (nonNull.length) {
    const mn = Math.min(...nonNull), mx = Math.max(...nonNull);
    const avg = nonNull.reduce((a, v) => a + v, 0) / nonNull.length;
    statsHtml += `<div class="hist-stats-bar">
      <span>min <strong>${pInfo.fmt(mn)}</strong></span>
      <span>avg <strong>${pInfo.fmt(avg)}</strong></span>
      <span>max <strong>${pInfo.fmt(mx)}</strong></span>
      <span class="hist-pts">${nonNull.length} pts · ${fmtRangeLabel(from_ms, to_ms)}</span>
    </div>`;
  }

  // Period status breakdown — % time OK / warn / alert / no data
  if (thr && filtered.length) {
    const { counts, total } = periodCounts(param, filtered, from_ms, to_ms, histData.bin_ms);
    const pct   = st => Math.round(counts[st] / total * 100);
    const bars  = ['ok', 'warn', 'alert', 'nodata'].filter(st => counts[st] > 0);
    statsHtml += `<div class="hist-period-summary">
      <span class="hist-period-label">Period status</span>
      <div class="hist-period-bar">
        ${bars.map(st =>
          `<div class="hpb-seg qc-${st}" style="flex:${counts[st]}"
            title="${st}: ${pct(st)}% (${counts[st]} of ${total} pts)"></div>`
        ).join('')}
      </div>
      <div class="hist-period-legend">
        ${bars.map(st =>
          `<span class="hpl-item"><span class="hpl-dot qc-${st}"></span>${st} ${pct(st)}%</span>`
        ).join('')}
      </div>
    </div>`;
  }
  document.getElementById('history-stats').innerHTML = statsHtml;

  const recent = filtered.slice(-24).reverse();
  document.getElementById('history-table-wrap').innerHTML =
    `<table class="hist-data-table">
      <thead><tr><th>Time (UTC)</th><th>${esc(pInfo.label)}</th><th>Status</th></tr></thead>
      <tbody>${recent.map(([t, v]) => {
        const st = cellStatus(param, v);
        return `<tr><td>${fmtTime(t)}</td><td class="qc-${st}">${pInfo.fmt(v)}</td><td>${st}</td></tr>`;
      }).join('')}</tbody>
    </table>`;

  // Enable all export buttons
  _histSeries = { stream, param, from_ms, to_ms, points: filtered };
  if (exportBtn)    exportBtn.disabled    = false;
  if (exportAllBtn) exportAllBtn.disabled = false;
  if (exportSumBtn) exportSumBtn.disabled = false;
}

// Status counts over a period, in time bins. Bins with no data point at all
// (e.g. a station outage) count as 'nodata', so percentages reflect time,
// not just the points that happened to arrive.
function periodCounts(param, points, from_ms, to_ms, bin_ms) {
  const counts = { ok: 0, warn: 0, alert: 0, nodata: 0, info: 0 };
  for (const [, v] of points) counts[cellStatus(param, v)]++;
  const step     = bin_ms || 600_000;
  const expected = Math.max(0, Math.floor(to_ms / step) - Math.ceil(from_ms / step) + 1);
  counts.nodata += Math.max(0, expected - points.length);
  const total = Math.max(expected, points.length) || 1;
  return { counts, total };
}

function exportHistoryCSV() {
  if (!_histSeries) return;
  const { stream, param, from_ms, to_ms, points } = _histSeries;
  const pInfo = PARAMS[param] ?? { label: param, unit: '' };
  const col   = pInfo.label + (pInfo.unit ? '_' + pInfo.unit : '');
  const header = ['Time_UTC', 'Timestamp_ms', col, 'Status'];
  const rows   = [header, ...points.map(([t, v]) => [
    new Date(t).toISOString().replace('T', ' ').slice(0, 19),
    t,
    v ?? '',
    cellStatus(param, v),
  ])];
  const safe = stream.replace(/\./g, '_');
  const name = `qclog2_${safe}_${param}_${new Date(from_ms).toISOString().slice(0,10)}_to_${new Date(to_ms).toISOString().slice(0,10)}.csv`;
  downloadCSV(rows, name);
}

function exportAllHistoryCSV() {
  if (!_histAllData || !_histSeries) return;
  const { param, from_ms, to_ms } = _histSeries;
  const pInfo    = PARAMS[param] ?? { label: param, unit: '' };
  const col      = pInfo.label + (pInfo.unit ? '_' + pInfo.unit : '');
  const netFilter = S.filter.net;

  const header = ['Stream', 'Network', 'Station', 'Location', 'Channel',
                  'Time_UTC', 'Timestamp_ms', col, 'Status'];
  const rows = [header];

  for (const [sid, paramMap] of Object.entries(_histAllData.streams || {}).sort()) {
    if (netFilter && sid.split('.')[0] !== netFilter) continue;
    const points = paramMap[param];
    if (!points?.length) continue;
    const [net, sta, loc, cha] = sid.split('.');
    for (const [t, v] of points) {
      rows.push([
        sid, net, sta, loc ?? '', cha ?? '',
        new Date(t).toISOString().replace('T', ' ').slice(0, 19),
        t,
        v ?? '',
        cellStatus(param, v),
      ]);
    }
  }

  const streamCount = new Set(rows.slice(1).map(r => r[0])).size;
  const netPart = netFilter ? `_${netFilter}` : '';
  const name = `qclog2_all${netPart}_${param}_${new Date(from_ms).toISOString().slice(0,10)}_to_${new Date(to_ms).toISOString().slice(0,10)}.csv`;
  downloadCSV(rows, name);
  console.log(`[qclog2] Exported ${rows.length - 1} rows for ${streamCount} streams`);
}

function exportPeriodSummaryCSV() {
  if (!_histAllData || !_histSeries) return;
  const { param, from_ms, to_ms } = _histSeries;
  const pInfo     = PARAMS[param] ?? { label: param, unit: '' };
  const col       = pInfo.label + (pInfo.unit ? '_' + pInfo.unit : '');
  const netFilter = S.filter.net;
  const binMs     = _histAllData.bin_ms;

  const header = ['Stream', 'Network', 'Station', 'Location', 'Channel', 'Parameter',
                  'From_UTC', 'To_UTC', 'Time_bins', 'Data_points',
                  'Min_' + col, 'Avg_' + col, 'Max_' + col,
                  'OK_pct', 'Warn_pct', 'Alert_pct', 'NoData_pct'];
  const rows = [header];

  for (const [sid, paramMap] of Object.entries(_histAllData.streams || {}).sort()) {
    if (netFilter && sid.split('.')[0] !== netFilter) continue;
    const points = paramMap[param];
    if (!points?.length) continue;
    const [net, sta, loc, cha] = sid.split('.');
    const vals    = points.map(([,v]) => v);
    const nonNull = vals.filter(v => v != null);

    const { counts, total } = periodCounts(param, points, from_ms, to_ms, binMs);
    const pct   = st => (counts[st] / total * 100).toFixed(1);

    const mn  = nonNull.length ? Math.min(...nonNull) : '';
    const mx  = nonNull.length ? Math.max(...nonNull) : '';
    const avg = nonNull.length ? nonNull.reduce((a, v) => a + v, 0) / nonNull.length : '';

    rows.push([
      sid, net, sta, loc ?? '', cha ?? '', param,
      new Date(from_ms).toISOString().replace('T', ' ').slice(0, 16),
      new Date(to_ms).toISOString().replace('T', ' ').slice(0, 16),
      total, points.length,
      mn !== '' ? mn.toFixed(4) : '',
      avg !== '' ? avg.toFixed(4) : '',
      mx !== '' ? mx.toFixed(4) : '',
      pct('ok'), pct('warn'), pct('alert'), pct('nodata'),
    ]);
  }

  const netPart = netFilter ? `_${netFilter}` : '';
  const name = `qclog2_summary${netPart}_${param}_${new Date(from_ms).toISOString().slice(0,10)}_to_${new Date(to_ms).toISOString().slice(0,10)}.csv`;
  downloadCSV(rows, name);
}

function downloadCSV(rows, filename) {
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════════
// WATCHLIST
// ══════════════════════════════════════════════════════════
function toggleWatchlist(stream) {
  S.watchlist.has(stream) ? S.watchlist.delete(stream) : S.watchlist.add(stream);
  savePrefs();
  document.querySelectorAll(`.watch-btn[data-stream="${CSS.escape(stream)}"]`).forEach(btn => {
    btn.textContent = S.watchlist.has(stream) ? '★' : '☆';
    btn.classList.toggle('watched', S.watchlist.has(stream));
  });
  document.querySelectorAll(`tr[data-stream="${CSS.escape(stream)}"]`).forEach(row =>
    row.classList.toggle('watched', S.watchlist.has(stream))
  );
}

// ══════════════════════════════════════════════════════════
// CONNECTION BADGE
// ══════════════════════════════════════════════════════════
function setBadge(state) {
  const el = document.getElementById('conn-badge');
  el.className   = `badge badge-${state}`;
  const labels   = { live: DEMO ? 'Demo' : 'Live', error: 'Error', stale: 'Stale data', connecting: 'Loading…' };
  el.textContent = labels[state] ?? 'Loading…';
  if (DEMO && state === 'live') el.title = 'Demo mode — synthetic data, timestamps shifted to now';
  if (state === 'stale' && S.data?.generated) {
    const ageMin = Math.round((Date.now() - S.data.generated) / 60_000);
    el.title = `qc_current.json is ${ageMin}min old — check backend.py is running`;
  }
}

// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
function openSettings() {
  const getEl = id => document.getElementById(id);
  const thr = S.prefs.thresholds;
  getEl('cfg-url').value    = S.prefs.dataUrl;
  getEl('cfg-api').value    = S.prefs.apiUrl;
  getEl('cfg-fdsnws').value = S.prefs.fdsnws;
  getEl('thr-avail-warn').value    = thr.availability?.warn    ?? '';
  getEl('thr-avail-alert').value   = thr.availability?.alert   ?? '';
  getEl('thr-delay-warn').value    = thr.delay?.warn            ?? '';
  getEl('thr-delay-alert').value   = thr.delay?.alert           ?? '';
  getEl('thr-latency-warn').value  = thr.latency?.warn          ?? '';
  getEl('thr-latency-alert').value = thr.latency?.alert         ?? '';
  getEl('thr-timing-warn').value   = thr.timing_quality?.warn   ?? '';
  getEl('thr-timing-alert').value  = thr.timing_quality?.alert  ?? '';
  getEl('thr-gaps-warn').value     = thr.gaps_count?.warn       ?? '';
  getEl('thr-gaps-alert').value    = thr.gaps_count?.alert      ?? '';
  getEl('thr-overlaps-warn').value     = thr.overlaps_count?.warn  ?? '';
  getEl('thr-overlaps-alert').value    = thr.overlaps_count?.alert ?? '';
  getEl('thr-spikes-warn').value       = thr.spikes_count?.warn    ?? '';
  getEl('thr-spikes-alert').value      = thr.spikes_count?.alert   ?? '';
  document.getElementById('settings-modal').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

function applySettings() {
  const v = id => { const el = document.getElementById(id); return el?.value?.trim(); };
  const n = id => { const val = parseFloat(v(id)); return isNaN(val) ? null : val; };

  const newUrl = v('cfg-url') || DEFAULTS.dataUrl;
  const changed = newUrl !== S.prefs.dataUrl;

  S.prefs.dataUrl = newUrl;
  S.prefs.apiUrl  = v('cfg-api')    || DEFAULTS.apiUrl;
  S.prefs.fdsnws  = v('cfg-fdsnws') || '';
  S.prefs.thresholds = {
    availability:   { warn: n('thr-avail-warn'),    alert: n('thr-avail-alert'),    lowerWorse: true  },
    delay:          { warn: n('thr-delay-warn'),     alert: n('thr-delay-alert'),    lowerWorse: false },
    latency:        { warn: n('thr-latency-warn'),   alert: n('thr-latency-alert'),  lowerWorse: false },
    timing_quality: { warn: n('thr-timing-warn'),    alert: n('thr-timing-alert'),   lowerWorse: true  },
    gaps_count:     { warn: n('thr-gaps-warn'),      alert: n('thr-gaps-alert'),     lowerWorse: false },
    overlaps_count: { warn: n('thr-overlaps-warn'),  alert: n('thr-overlaps-alert'), lowerWorse: false },
    spikes_count:   { warn: n('thr-spikes-warn'),    alert: n('thr-spikes-alert'),   lowerWorse: false },
  };
  savePrefs();
  closeSettings();
  if (changed) { S.data = null; fetchData(); } else if (S.data) render();
}

function resetSettings() {
  S.prefs.thresholds = JSON.parse(JSON.stringify(DEFAULTS.thresholds));
  openSettings();
}

// ══════════════════════════════════════════════════════════
// PERSISTENCE
// ══════════════════════════════════════════════════════════
function savePrefs() {
  try {
    localStorage.setItem('qclog2', JSON.stringify({
      dataUrl:       S.prefs.dataUrl,
      apiUrl:        S.prefs.apiUrl,
      fdsnws:        S.prefs.fdsnws,
      refreshMs:     S.refreshMs,
      theme:         S.theme,
      thresholds:    S.prefs.thresholds,
      watchlist:     [...S.watchlist],
      notifEnabled:  S.notifEnabled,
      watchlistOnly: S.watchlistOnly,
      events:        S.events.slice(0, 500),
      prevStatus:    S.prevStatus,
    }));
  } catch(_) {}
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('qclog2') || '{}');
    if (p.dataUrl)    S.prefs.dataUrl    = p.dataUrl;
    if (p.apiUrl)     S.prefs.apiUrl     = p.apiUrl;
    if (p.fdsnws)     S.prefs.fdsnws     = p.fdsnws;
    if (p.refreshMs)  S.refreshMs        = p.refreshMs;
    if (p.theme)      S.theme            = p.theme;
    if (p.thresholds) S.prefs.thresholds = { ...S.prefs.thresholds, ...p.thresholds };
    if (p.watchlist)     S.watchlist        = new Set(p.watchlist);
    if (p.notifEnabled)  S.notifEnabled     = p.notifEnabled;
    if (p.watchlistOnly) S.watchlistOnly    = p.watchlistOnly;
    if (Array.isArray(p.events))  S.events     = p.events;
    if (p.prevStatus && typeof p.prevStatus === 'object') S.prevStatus = p.prevStatus;
  } catch(_) {}
}

async function loadDeploymentConfig() {
  try {
    const resp = await fetch('config.json');
    if (!resp.ok) return;
    const cfg  = await resp.json();
    const saved = JSON.parse(localStorage.getItem('qclog2') || '{}');
    if (!saved.dataUrl && cfg.qc_url)  S.prefs.dataUrl = cfg.qc_url;
    if (!saved.fdsnws  && cfg.fdsnws)  S.prefs.fdsnws  = cfg.fdsnws;
    if (!saved.apiUrl  && cfg.api_url) S.prefs.apiUrl  = cfg.api_url;
  } catch(_) {}
}

// ══════════════════════════════════════════════════════════
// EXPORT CSV
// ══════════════════════════════════════════════════════════
function exportCSV() {
  const params = S.visibleParams;
  const header = ['Stream', 'Network', 'Station', 'Location', 'Channel', 'Overall',
    ...params.map(p => PARAMS[p]?.label ?? p),
    ...params.map(p => (PARAMS[p]?.label ?? p) + '_time')];
  const rows   = [header];
  for (const [sid, sdata] of Object.entries(S.data?.streams || {})) {
    const [net,sta,loc,cha] = sid.split('.');
    rows.push([
      sid, net, sta, loc||'', cha, streamStatus(sdata),
      ...params.map(p => sdata[p]?.v ?? ''),
      ...params.map(p => sdata[p]?.t ? new Date(sdata[p].t).toISOString() : ''),
    ]);
  }
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `qclog2_${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════════
// EVENT WIRING
// ══════════════════════════════════════════════════════════
// Re-render whichever filtered view is showing
function renderFiltered() {
  if (S.view === 'table') renderTable();
  if (S.view === 'grid')  renderGrid();
  if (S.view === 'map')   refreshMapMarkers();
}

function initEvents() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => switchView(tab.dataset.view))
  );

  document.getElementById('search').addEventListener('input', e => {
    S.filter.search = e.target.value.trim();
    renderFiltered();
  });
  document.getElementById('filter-net').addEventListener('change', e => {
    S.filter.net = e.target.value;
    renderFiltered();
  });
  document.getElementById('filter-param').addEventListener('change', e => {
    S.filter.param = e.target.value;
    renderFiltered();
  });
  document.getElementById('filter-status').addEventListener('change', e => {
    S.filter.status = e.target.value;
    renderFiltered();
  });
  document.getElementById('status-counts').addEventListener('click', e => {
    const sc = e.target.closest('.scount');
    if (!sc) return;
    S.filter.status = S.filter.status === sc.dataset.filter ? '' : sc.dataset.filter;
    document.getElementById('filter-status').value = S.filter.status;
    renderFiltered();
  });

  // History load + export buttons
  document.getElementById('hist-load-btn')
    ?.addEventListener('click', loadHistoryChart);
  document.getElementById('hist-export-btn')
    ?.addEventListener('click', exportHistoryCSV);
  document.getElementById('hist-export-all-btn')
    ?.addEventListener('click', exportAllHistoryCSV);
  document.getElementById('hist-export-sum-btn')
    ?.addEventListener('click', exportPeriodSummaryCSV);
  document.getElementById('refresh-sel').addEventListener('change', e => {
    S.refreshMs = +e.target.value; savePrefs();
  });
  document.getElementById('refresh-now').addEventListener('click', () => {
    clearTimeout(S.mainTimer); clearInterval(S.cdTimer); fetchData();
  });
  document.getElementById('export-csv').addEventListener('click', exportCSV);
  document.getElementById('settings-btn').addEventListener('click',   openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-apply').addEventListener('click', applySettings);
  document.getElementById('settings-reset').addEventListener('click', resetSettings);
  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById('theme-toggle').addEventListener('click', () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    document.body.classList.toggle('dark', S.theme === 'dark');
    savePrefs();
    if (S.uplot && S.detailStream) drawChart();
    if (S.view === 'overlay' && _overlayTraces.length) loadOverlay();
  });
  document.getElementById('panel-close').addEventListener('click', closeChart);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChart(); });

  // Sort by column header click
  document.getElementById('qc-thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    S.sort = { key, asc: S.sort.key === key ? !S.sort.asc : true };
    renderTable();
  });

  // Cell click → open chart
  document.getElementById('qc-tbody').addEventListener('click', e => {
    const watchBtn = e.target.closest('.watch-btn');
    const cell     = e.target.closest('.qc-cell[data-param]');
    if (watchBtn) {
      e.stopPropagation();
      toggleWatchlist(watchBtn.dataset.stream);
      return;
    }
    if (cell) {
      openChart(cell.dataset.stream, cell.dataset.param);
      return;
    }
  });

  // Grid card click → jump to Table view filtered to that station
  document.getElementById('grid-wrap').addEventListener('click', e => {
    const card = e.target.closest('.sta-card');
    if (!card) return;
    if (card.dataset.stid) showStationInTable(card.dataset.stid);
  });

  // Map view
  document.getElementById('map-color').addEventListener('change', e => {
    S.mapColor = e.target.value; refreshMapMarkers();
  });
  const baseSel = document.getElementById('map-base');
  baseSel.innerHTML = Object.entries(BASE_MAPS).map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join('');
  baseSel.addEventListener('change', e => {
    mapPrefs({ base: e.target.value });
    if (_map) setBaseMap(e.target.value);
  });
  document.getElementById('map-plates').addEventListener('change', e => {
    mapPrefs({ plates: e.target.checked });
    if (_map) togglePlates(e.target.checked);
  });
  document.getElementById('map-fit').addEventListener('click', () => {
    if (!_map || !S.data) return;
    const keys = Object.values(mapStations(S.mapColor)).filter(mapStationVisible)
      .filter(st => !S.mapHide.has(st.status)).map(st => st.key);
    fitMapToStations(keys);
  });
  document.getElementById('map-counts').addEventListener('click', e => {
    const b = e.target.closest('.map-count');
    if (!b) return;
    const s = b.dataset.status;
    S.mapHide.has(s) ? S.mapHide.delete(s) : S.mapHide.add(s);
    refreshMapMarkers();
  });
  document.getElementById('map-problems').addEventListener('click', e => {
    const row = e.target.closest('.map-prob');
    if (row) focusMapStation(row.dataset.stid);
  });

  // Time pickers — inject HTML then wire each one
  document.getElementById('tpick-panel').innerHTML   = timePickerHtml(86_400_000);
  document.getElementById('tpick-history').innerHTML = timePickerHtml(86_400_000);
  document.getElementById('tpick-overlay').innerHTML = timePickerHtml(86_400_000);
  document.getElementById('tpick-heatmap').innerHTML = timePickerHtml(86_400_000);

  initPicker(document.querySelector('#chart-panel   .tpick'), () => { if (S.detailStream) loadChartData(); });
  initPicker(document.querySelector('#view-history  .tpick'), () => { /* load triggered by Load btn */ });
  initPicker(document.querySelector('#view-overlay  .tpick'), () => { if (S.view === 'overlay') loadOverlay(); });
  initPicker(document.querySelector('#view-heatmap  .tpick'), () => { if (S.view === 'heatmap') loadHeatmap(); });

  // Watchlist-only toggle
  document.getElementById('watchlist-only-btn').addEventListener('click', () => {
    S.watchlistOnly = !S.watchlistOnly;
    document.getElementById('watchlist-only-btn').classList.toggle('active', S.watchlistOnly);
    savePrefs();
    renderFiltered();
  });

  // Notification toggle
  document.getElementById('notif-toggle').addEventListener('click', toggleNotifications);

  // Overlay view — auto-loads on param change; search filters without reload
  document.getElementById('cmp-param').addEventListener('change', () => { if (S.view === 'overlay') loadOverlay(); });
  document.getElementById('cmp-search').addEventListener('input', e => filterOverlay(e.target.value));
  document.getElementById('overlay-legend-btn').addEventListener('click', e => {
    const btn  = e.currentTarget;
    const show = btn.classList.toggle('active');
    const wrap = document.getElementById('overlay-chart-wrap');
    if (wrap.classList.contains('js-plotly-plot')) Plotly.relayout(wrap, { showlegend: show });
  });
  // Heatmap view — param change or Load btn triggers reload
  document.getElementById('hm-param').addEventListener('change', () => { if (S.view === 'heatmap') loadHeatmap(); });
  document.getElementById('hm-load-btn').addEventListener('click', loadHeatmap);

  // Events view
  document.getElementById('events-clear-btn').addEventListener('click', () => {
    S.events = [];
    renderEvents();
    updateEventsBadge();
  });

  // Resize the side chart with the window, and when the panel has finished
  // sliding open: data that loads faster than the transition (cached or local)
  // would otherwise leave the chart at the half-open width
  const resizeSideChart = () => {
    if (S.uplot && S.detailStream) {
      const wrap = document.getElementById('chart-wrap');
      S.uplot.setSize({ width: wrap.clientWidth, height: 220 });
    }
  };
  window.addEventListener('resize', resizeSideChart);
  document.getElementById('chart-panel').addEventListener('transitionend', e => {
    if (e.target === e.currentTarget && e.propertyName === 'width') resizeSideChart();
  });
}

// ══════════════════════════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════════════════════════
async function init() {
  loadPrefs();
  if (DEMO) {
    await loadDemoEvents();
    document.getElementById('demo-banner').hidden = false;
  } else {
    await loadDeploymentConfig();
  }

  document.body.classList.toggle('dark', S.theme === 'dark');
  document.getElementById('refresh-sel').value = String(S.refreshMs);
  document.getElementById('watchlist-only-btn').classList.toggle('active', S.watchlistOnly);
  updateNotifButton();

  initEvents();
  setBadge('connecting');
  fetchData();
}

// ══════════════════════════════════════════════════════════
// EVENTS / OUTAGE LOG
// ══════════════════════════════════════════════════════════
function detectEvents(data) {
  const now = Date.now();
  for (const [stream, sdata] of Object.entries(data.streams || {})) {
    const newSt = streamStatus(sdata);
    const oldSt = S.prevStatus[stream];
    if (oldSt !== undefined && oldSt !== newSt) {
      // Mark any open event for this stream as resolved
      for (let i = 0; i < S.events.length; i++) {
        if (S.events[i].stream === stream && S.events[i].resolvedTs === null) {
          S.events[i].resolvedTs = now;
          break;
        }
      }
      S.events.unshift({ ts: now, stream, from: oldSt, to: newSt, resolvedTs: null });
      if (S.events.length > 500) S.events.length = 500;
      maybeNotify(stream, oldSt, newSt);
    }
    S.prevStatus[stream] = newSt;
  }
  if (S.view === 'events') renderEvents();
}

function updateEventsBadge() {
  const badge = document.getElementById('events-badge');
  const alertCount = S.events.filter(e => e.to === 'alert' || e.to === 'nodata').length;
  if (alertCount > 0) {
    badge.textContent = alertCount;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function renderEvents() {
  const tbody  = document.getElementById('events-tbody');
  const empty  = document.getElementById('events-empty');
  const info   = document.getElementById('events-info');
  const oldest = S.events.length ? fmtTime(S.events[S.events.length - 1].ts) : '';
  info.textContent = S.events.length
    ? `${S.events.length} event${S.events.length !== 1 ? 's' : ''} · since ${oldest}`
    : '';
  if (!S.events.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = S.events.map(ev => {
    // A change *to* ok is a recovery, not an open condition — it has no duration
    const dur = ev.resolvedTs
      ? fmtSec((ev.resolvedTs - ev.ts) / 1000)
      : ev.to === 'ok'
        ? `<span style="color:var(--text3)">—</span>`
        : `<em style="color:var(--text3)">active</em>`;
    return `<tr>
      <td>${fmtTime(ev.ts)}</td>
      <td class="ev-stream">${esc(ev.stream)}</td>
      <td><span class="ev-from qc-${ev.from}">${ev.from}</span></td>
      <td><span class="ev-to qc-${ev.to}">${ev.to}</span></td>
      <td>${dur}</td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════
// BROWSER NOTIFICATIONS
// ══════════════════════════════════════════════════════════
function updateNotifButton() {
  const btn = document.getElementById('notif-toggle');
  btn.classList.toggle('active', S.notifEnabled);
  btn.title = S.notifEnabled ? 'Notifications on — click to disable' : 'Enable browser notifications';
}

async function toggleNotifications() {
  if (!('Notification' in window)) {
    alert('Browser notifications are not supported in this browser.');
    return;
  }
  if (!S.notifEnabled) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notification permission denied.'); return; }
    S.notifEnabled = true;
  } else {
    S.notifEnabled = false;
  }
  updateNotifButton();
  savePrefs();
}

function maybeNotify(stream, from, to) {
  if (!S.notifEnabled || Notification.permission !== 'granted') return;
  if (to === 'alert' || to === 'nodata') {
    new Notification(`QC ${to.toUpperCase()}: ${stream}`, {
      body: `Status changed ${from} → ${to}`,
      tag:  stream,
    });
  } else if (from === 'alert' && to === 'ok') {
    new Notification(`QC Recovered: ${stream}`, {
      body: 'Status returned to OK',
      tag:  stream,
    });
  }
}

// ══════════════════════════════════════════════════════════
// OVERLAY VIEW  (Plotly multi-stream chart, color by network)
// ══════════════════════════════════════════════════════════

const NET_COLORS = {
  AU: '#1f77b4', '2O': '#ff7f0e', M8: '#2ca02c',
  YW: '#d62728', '3B': '#9467bd', IU: '#8c564b',
  II: '#e377c2', GE: '#17becf', G:  '#bcbd22',
};
const NET_COLOR_FALLBACK = '#7f7f7f';

// Networks not listed above get a stable colour from their code, so
// different networks stay distinguishable instead of all turning grey.
const NET_PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
                     '#8c564b', '#e377c2', '#17becf', '#bcbd22'];

function netColor(stream) {
  const net = stream.split('.')[0];
  if (NET_COLORS[net]) return NET_COLORS[net];
  if (!net) return NET_COLOR_FALLBACK;
  let h = 0;
  for (const ch of net) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NET_PALETTE[h % NET_PALETTE.length];
}

let _overlayTraces = [];      // [{ name, color }] — kept for theme-reload check
let _allOverlayTraces = [];   // full trace array saved for Plotly.react on filter
let _overlayLayout   = null;
let _overlayConfig   = null;
let _searchDebounce  = null;

async function loadOverlay() {
  const param  = document.getElementById('cmp-param')?.value;
  const picker = document.querySelector('#view-overlay .tpick');
  if (!param || !picker) return;

  const wrap = document.getElementById('overlay-chart-wrap');
  Plotly.purge(wrap);
  wrap.innerHTML = '<div class="chart-loading">Loading…</div>';
  document.getElementById('cmp-stats').textContent = '';
  document.getElementById('cmp-stream-count').textContent = '';
  _overlayTraces = [];

  try {
    const data = await fetchRange(picker, param);
    wrap.innerHTML = '';
    drawOverlayChart(data, param, data.from, data.to);
  } catch(_) {
    wrap.innerHTML = '<div class="chart-loading">Failed to load data.</div>';
  }
}

function drawOverlayChart(histData, param, from_ms, to_ms) {
  const pInfo  = PARAMS[param] ?? { label: param, unit: '', fmt: v => String(v) };
  const isDark = document.body.classList.contains('dark');
  const wrap   = document.getElementById('overlay-chart-wrap');

  const streams = Object.keys(histData.streams || {}).sort();
  if (!streams.length) {
    wrap.innerHTML = '<div class="chart-loading">No data for this parameter / time range.</div>';
    return;
  }

  // Threshold shapes
  const thr    = S.prefs.thresholds[param];
  const shapes = [];
  if (thr?.warn  != null) shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: thr.warn,  y1: thr.warn,  line: { color: cssVar('--s-warn'), width: 1, dash: 'dash' } });
  if (thr?.alert != null) shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: thr.alert, y1: thr.alert, line: { color: cssVar('--s-alert'), width: 1, dash: 'dot'  } });

  const traces = streams.map(s => {
    const pts   = histData.streams[s]?.[param] ?? [];
    const color = netColor(s);
    return {
      name: s,
      x:    pts.map(([t]) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')),
      y:    pts.map(([,v]) => v),
      type: 'scatter',
      mode: 'lines',
      line: { color, width: 1 },
      hovertemplate: `<b>${s}</b><br>%{x|%Y-%m-%d %H:%M} UTC<br>${pInfo.label}: %{y:.3f} ${pInfo.unit}<extra></extra>`,
    };
  });

  _overlayTraces = traces.map(t => ({ name: t.name, color: t.line.color }));

  const gridCol = isDark ? '#334155' : '#e2e8f0';
  const layout  = {
    margin: { t: 16, r: 24, b: 48, l: 60 },
    paper_bgcolor: isDark ? '#1e293b' : '#ffffff',
    plot_bgcolor:  isDark ? '#1e293b' : '#ffffff',
    font:   { color: isDark ? '#94a3b8' : '#475569', size: 11 },
    xaxis:  { type: 'date', gridcolor: gridCol, linecolor: gridCol, zeroline: false },
    yaxis:  { title: { text: pInfo.unit, standoff: 8 }, gridcolor: gridCol, linecolor: gridCol, zeroline: false },
    showlegend: document.getElementById('overlay-legend-btn')?.classList.contains('active') ?? false,
    legend: {
      font:            { size: 10 },
      bgcolor:         isDark ? 'rgba(30,41,59,0.85)' : 'rgba(255,255,255,0.85)',
      bordercolor:     gridCol,
      borderwidth:     1,
      tracegroupgap:   0,
      itemclick:       'toggle',
      itemdoubleclick: 'toggleothers',
    },
    hovermode:  'closest',
    shapes,
    height: Math.max(340, window.innerHeight - 240),
  };
  const config = {
    responsive:    true,
    displaylogo:   false,
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
  };

  _allOverlayTraces = traces;
  _overlayLayout    = layout;
  _overlayConfig    = config;
  Plotly.newPlot(wrap, traces, layout, config);

  document.getElementById('cmp-stream-count').textContent = `${streams.length} streams`;
  document.getElementById('cmp-stats').textContent =
    `${streams.length} streams · ${pInfo.label} · ${fmtRangeLabel(from_ms, to_ms)}`;

  // Re-apply search filter if box has content
  const q = document.getElementById('cmp-search').value;
  if (q) filterOverlay(q);
}

function filterOverlay(query) {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    if (!_allOverlayTraces.length) return;
    const wrap = document.getElementById('overlay-chart-wrap');
    const q     = query.toLowerCase().trim();
    const terms   = q ? q.split(',').map(t => t.trim()).filter(Boolean) : [];
    const include = terms.filter(t => !t.startsWith('!'));
    const exclude = terms.filter(t =>  t.startsWith('!')).map(t => t.slice(1));
    const subset  = terms.length
      ? _allOverlayTraces.filter(t => {
          const name = (t.name || '').toLowerCase();
          const pass = include.length === 0 || include.some(term => name.includes(term));
          const block = exclude.some(term => name.includes(term));
          return pass && !block;
        })
      : _allOverlayTraces;
    const yax = { ..._overlayLayout.yaxis };
    if (terms.length) {
      // Threshold shapes force the axis to 0-300 etc; compute range from data only
      const allY = subset.flatMap(t => (t.y || []).filter(v => v != null && isFinite(v)));
      if (allY.length) {
        const lo = Math.min(...allY), hi = Math.max(...allY);
        const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1;
        yax.autorange = false;
        yax.range = [lo - pad, hi + pad];
      }
    } else {
      yax.autorange = true;
      delete yax.range;
    }
    const layout = {
      ..._overlayLayout,
      xaxis: { ..._overlayLayout.xaxis, autorange: true, range: undefined },
      yaxis: yax,
    };
    Plotly.react(wrap, subset, layout, _overlayConfig);
    const n = subset.length, total = _allOverlayTraces.length;
    document.getElementById('cmp-stream-count').textContent =
      q ? `${n} / ${total}` : `${total} streams`;
  }, 200);
}


// ══════════════════════════════════════════════════════════
// HEATMAP VIEW
// ══════════════════════════════════════════════════════════
async function loadHeatmap() {
  const param  = document.getElementById('hm-param').value;
  const picker = document.querySelector('#view-heatmap .tpick');
  if (!picker) return;
  document.getElementById('heatmap-labels').innerHTML = '<div class="hm-label" style="color:var(--text3)">Loading…</div>';
  document.getElementById('heatmap-canvas-wrap').innerHTML = '';

  try {
    const data = await fetchRange(picker, param);
    renderHeatmap(data, param, data.from, data.to, data.bin_ms ?? 600_000);
  } catch(_) {
    document.getElementById('heatmap-labels').innerHTML =
      '<div class="hm-label" style="color:var(--s-alert-fg)">Failed to load.</div>';
  }
}

function renderHeatmap(histData, param, from_ms, to_ms, bin_ms) {
  const streams = Object.keys(histData.streams || {}).sort();
  if (!streams.length) {
    document.getElementById('heatmap-labels').innerHTML =
      '<div class="hm-label" style="color:var(--text3)">No data.</div>';
    return;
  }

  // Build ordered bin list from the exact requested range
  const firstBin = Math.ceil(from_ms / bin_ms) * bin_ms;
  const bins = [];
  for (let t = firstBin; t <= to_ms; t += bin_ms) bins.push(t);

  const isLong  = (to_ms - from_ms) >= 48 * 3600e3;
  const CELL_W  = isLong ? 6 : 5;
  const CELL_H  = 20;
  const LABEL_W = 160;
  const canvasW = bins.length * CELL_W;
  const canvasH = streams.length * CELL_H;

  // Status colours from style.css. No data is a mid grey, darker than the
  // light OK green, so the two do not blur together.
  const isDark  = document.body.classList.contains('dark');
  const colMap  = {
    ok:     cssVar('--s-ok'),
    warn:   cssVar('--s-warn'),
    alert:  cssVar('--s-alert'),
    nodata: cssVar('--text3'),
    info:   isDark ? '#263347' : '#f1f5f9',
  };

  // Build canvas
  const wrap = document.getElementById('heatmap-canvas-wrap');
  wrap.innerHTML = '';
  const xaxis = document.createElement('div');
  xaxis.id = 'heatmap-xaxis';
  xaxis.style.cssText = `width:${canvasW}px;height:20px;position:sticky;top:0;z-index:2;background:var(--surface2);border-bottom:1px solid var(--border);box-sizing:border-box;`;

  // X-axis labels (show ~8 labels)
  const labelEvery = Math.max(1, Math.floor(bins.length / 8));
  bins.forEach((t, i) => {
    if (i % labelEvery !== 0) return;
    const lbl = document.createElement('span');
    const d = new Date(t);
    lbl.textContent = isLong
      ? `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}h`
      : `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    lbl.style.cssText = `position:absolute;left:${i * CELL_W}px;font-size:9px;color:var(--text3);white-space:nowrap;`;
    xaxis.appendChild(lbl);
  });
  wrap.appendChild(xaxis);

  const canvas  = document.createElement('canvas');
  canvas.id     = 'heatmap-canvas';
  canvas.width  = canvasW;
  canvas.height = canvasH;
  canvas.style.cssText = 'display:block;cursor:crosshair;';
  wrap.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  // Draw cells
  streams.forEach((stream, si) => {
    const raw     = histData.streams?.[stream]?.[param] ?? [];
    const lookup  = new Map(raw.map(([t, v]) => [Math.round(t / bin_ms) * bin_ms, v]));
    bins.forEach((bin, bi) => {
      const v  = lookup.get(bin) ?? null;
      const st = cellStatus(param, v);
      ctx.fillStyle = colMap[st] ?? colMap.nodata;
      ctx.fillRect(bi * CELL_W, si * CELL_H, CELL_W - 1, CELL_H - 1);
    });
  });

  // Stream labels
  const labelsDiv = document.getElementById('heatmap-labels');
  labelsDiv.style.cssText = `width:${LABEL_W}px;padding-top:20px;height:${canvasH + 20}px;`;
  labelsDiv.innerHTML = streams.map(s => {
    const parts = s.split('.');
    const net  = parts[0] ?? '';
    const sta  = parts[1] ?? '';
    const chan = parts[3] ?? '';
    return `<div class="hm-label" style="height:${CELL_H}px;width:${LABEL_W}px;" title="${esc(s)}">` +
      `<span class="hm-net">${esc(net)}</span>` +
      `<span class="hm-dot">.</span>` +
      `<span class="hm-sta">${esc(sta)}</span>` +
      `<span class="hm-dot">.</span>` +
      `<span class="hm-chan">${esc(chan)}</span>` +
      `</div>`;
  }).join('');

  // Legend
  document.getElementById('heatmap-legend').innerHTML =
    ['ok','warn','alert','nodata'].map(st =>
      `<span class="hm-legend-swatch" style="background:${colMap[st]}"></span><span>${st}</span>`
    ).join('') + `<span style="margin-left:8px;color:var(--text3)">${streams.length} streams · ${bins.length} bins</span>`;

  // Tooltip on hover
  const tooltip = document.getElementById('heatmap-tooltip');
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const bi = Math.floor(mx / CELL_W);
    const si = Math.floor(my / CELL_H);
    if (bi < 0 || bi >= bins.length || si < 0 || si >= streams.length) {
      tooltip.style.display = 'none'; return;
    }
    const stream = streams[si];
    const raw    = histData.streams?.[stream]?.[param] ?? [];
    const lookup = new Map(raw.map(([t,v]) => [Math.round(t / bin_ms) * bin_ms, v]));
    const v      = lookup.get(bins[bi]) ?? null;
    const pInfo  = PARAMS[param] ?? { fmt: v => v == null ? '—' : String(v) };
    const d      = new Date(bins[bi]);
    tooltip.innerHTML =
      `<strong>${esc(stream)}</strong><br>` +
      `${d.toUTCString().slice(5,22)} UTC<br>` +
      `${param.replace(/_/g,' ')}: <strong>${pInfo.fmt(v)}</strong>`;
    tooltip.style.display = 'block';
    const tw = tooltip.offsetWidth  || 180;
    const th = tooltip.offsetHeight || 70;
    tooltip.style.left = (e.clientX + 14 + tw > window.innerWidth  ? e.clientX - tw - 10 : e.clientX + 14) + 'px';
    tooltip.style.top  = (e.clientY + 14 + th > window.innerHeight ? e.clientY - th - 10 : e.clientY + 14) + 'px';
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

document.addEventListener('DOMContentLoaded', init);
