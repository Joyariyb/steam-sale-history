// ==UserScript==
// @name         Steam Inventory Sale History
// @namespace    joey.steam-tools
// @version      2.2.1
// @description  Sale history above the inventory grid: a sparkline strip that expands to a chart, sales-by-price bars, price chips, a draggable asking price and one-click listing. Sparkline on hover over grid tiles.
// @author       Joey
// @homepageURL  https://github.com/Joyariyb/steam-sale-history
// @supportURL   https://github.com/Joyariyb/steam-sale-history/issues
// @downloadURL  https://raw.githubusercontent.com/Joyariyb/steam-sale-history/main/steam-sale-history.user.js
// @updateURL    https://raw.githubusercontent.com/Joyariyb/steam-sale-history/main/steam-sale-history.user.js
// @match        https://steamcommunity.com/id/*/inventory*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // --- pure helpers ---
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const DAY = 86400000;

  // Steam's price history stamps look like "Nov 07 2026 05: +0": UTC, one point
  // per hour for roughly the last month, one per day before that.
  function parseSteamDate(s) {
    const m = /^([A-Z][a-z]{2}) (\d{2}) (\d{4}) (\d{2}): \+0$/.exec(String(s));
    if (!m || !(m[1] in MONTHS)) return NaN;
    return Date.UTC(+m[3], MONTHS[m[1]], +m[2], +m[4]);
  }

  // [[stamp, median price, "volume"], ...] -> [{t, p, v}, ...], bad rows dropped.
  function toPoints(prices) {
    const out = [];
    for (const row of prices || []) {
      const t = parseSteamDate(row[0]);
      const p = Number(row[1]);
      const v = parseInt(row[2], 10) || 0;
      if (!isNaN(t) && isFinite(p)) out.push({ t, p, v });
    }
    return out;
  }

  function inRange(points, days, now) {
    if (!days) return points;
    const from = now - days * DAY;
    return points.filter(x => x.t >= from);
  }

  function median(values) {
    if (!values.length) return null;
    const a = values.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Everything the panel says about one window of the history. days = 0 means all.
  function periodStats(points, days, now) {
    const view = inRange(points, days, now);
    if (!view.length) return { view, sold: 0, perDay: 0, median: null, low: null, high: null, trend: null };
    let low = Infinity, high = -Infinity, sold = 0;
    for (const p of view) {
      if (p.p < low) low = p.p;
      if (p.p > high) high = p.p;
      sold += p.v;
    }
    const spanDays = days || Math.max(1, (view[view.length - 1].t - view[0].t) / DAY);
    const med = median(view.map(p => p.p));
    let trend = null;
    if (days) {
      const prev = points.filter(p => p.t >= now - 2 * days * DAY && p.t < now - days * DAY);
      const pm = median(prev.map(p => p.p));
      if (pm) trend = (med - pm) / pm;
    }
    return { view, sold, perDay: sold / spanDays, median: med, low, high, trend };
  }

  function niceBinWidth(lo, hi, maxBins) {
    const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
    for (const w of steps) if (Math.ceil((hi - lo) / w) + 1 <= maxBins) return w;
    return steps[steps.length - 1];
  }

  // Units sold per price band, bands chosen so there are at most maxBins of them.
  function priceBins(points, maxBins) {
    if (!points.length) return [];
    let lo = Infinity, hi = -Infinity;
    for (const p of points) {
      if (p.p < lo) lo = p.p;
      if (p.p > hi) hi = p.p;
    }
    const w = niceBinWidth(lo, hi, maxBins);
    const start = Math.floor(lo / w + 1e-9) * w;
    const n = Math.floor((hi - start) / w + 1e-9) + 1;
    const bins = [];
    for (let i = 0; i < n; i++) bins.push({ from: start + i * w, to: start + (i + 1) * w, v: 0 });
    for (const p of points) {
      let i = Math.floor((p.p - start) / w + 1e-9);
      if (i >= n) i = n - 1;
      if (i < 0) i = 0;
      bins[i].v += p.v;
    }
    return bins;
  }

  // Share of units sold at or above a price, 0..1, or null with no sales.
  function shareAtOrAbove(points, price) {
    let total = 0, above = 0;
    for (const p of points) {
      total += p.v;
      if (p.p >= price - 1e-9) above += p.v;
    }
    return total ? above / total : null;
  }

  // "A$ 0.07", "0,07€", "1.234,56 pуб." -> number.
  function parseMoney(text) {
    const m = /(\d[\d.,\s]*)/.exec(text || '');
    if (!m) return null;
    let s = m[1].replace(/\s/g, '');
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  // Steam's own "Starting at: A$ 0.07" line in the item panel.
  function parseStartingAt(text) {
    const m = /Starting at:\s*([^\n]*)/i.exec(text || '');
    return m ? parseMoney(m[1]) : null;
  }

  // Steam's fee arithmetic. w = {pct, min, base, pub}; amounts in cents.
  function amountToSend(received, w) {
    const steam = Math.floor(Math.max(received * w.pct, w.min)) + w.base;
    const pub = w.pub > 0 ? Math.floor(Math.max(received * w.pub, 1)) : 0;
    return received + steam + pub;
  }

  // What the seller gets when the buyer pays `cents`.
  function receivedForBuyerPays(cents, w) {
    let r = Math.max(1, Math.floor(cents / (1 + w.pct + w.pub)));
    while (r > 1 && amountToSend(r, w) > cents) r--;
    while (amountToSend(r + 1, w) <= cents) r++;
    return r;
  }

  function money(prefix, suffix, n) {
    return (prefix || '').trim() + n.toFixed(2) + (suffix || '').trim();
  }

  function fmtRate(perDay) {
    if (perDay >= 10) return String(Math.round(perDay));
    if (perDay >= 1) return perDay.toFixed(1);
    return perDay.toFixed(2);
  }

  function fmtTrend(t) {
    if (t == null || !isFinite(t)) return '';
    const pct = Math.round(t * 100);
    return (pct >= 0 ? '+' : '') + pct + '%';
  }

  // Index of the point nearest to time t, on a time-sorted array.
  function nearestIndex(points, t) {
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && t - points[lo - 1].t < points[lo].t - t) lo--;
    return lo;
  }
  // --- end helpers ---

  const RANGES = [['7d', 7], ['30d', 30], ['1y', 365], ['All', 0]];
  const CACHE_TTL = 15 * 60 * 1000;
  const PAD = { L: 46, R: 16, T: 8, B: 18 };
  const HEIGHT = 170;
  const MIN_ASK = 3;
  const BLUE = '#66c0f4', AMBER = '#e9b84a', GREY = '#8f98a0', LIGHT = '#c6d4df';

  const STYLE = `
    .ssh-box { box-sizing: border-box; width: 100%; margin: 0 0 8px; padding: 6px 8px; background: rgba(0,0,0,.25);
               border: 1px solid #2c2c2d; border-radius: 3px; font: 11px "Motiva Sans", Arial, sans-serif; color: ${GREY}; }
    .ssh-box a { text-decoration: none; }
    .ssh-strip { display: flex; align-items: center; gap: 10px; min-height: 28px; }
    .ssh-box.open .ssh-strip { display: none; }
    .ssh-box:not(.open) .ssh-full { display: none; }
    .ssh-spark { width: 140px; height: 28px; flex: none; }
    .ssh-s-name { color: ${LIGHT}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ssh-s-med { color: ${LIGHT}; white-space: nowrap; }
    .ssh-up { color: #75b022; } .ssh-down { color: #e06b5c; }
    .ssh-toggle { color: ${BLUE}; cursor: pointer; margin-left: auto; white-space: nowrap; }
    .ssh-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
    .ssh-head .ssh-toggle { margin-left: 0; color: ${LIGHT}; font-weight: bold; }
    .ssh-head .ssh-name { color: ${LIGHT}; margin-left: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .ssh-range { white-space: nowrap; }
    .ssh-range a { color: ${GREY}; margin-left: 3px; cursor: pointer; padding: 1px 7px; border-radius: 9px; }
    .ssh-range a.active { background: #2a475e; color: ${BLUE}; }
    .ssh-tip { min-height: 14px; line-height: 14px; color: ${LIGHT}; }
    .ssh-charts { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 8px; }
    .ssh-canvas, .ssh-hist { display: block; width: 100%; height: ${HEIGHT}px; }
    .ssh-canvas { cursor: crosshair; }
    .ssh-chips { margin: 6px 0 2px; }
    .ssh-chip { display: inline-block; padding: 3px 8px; border-radius: 3px; border: 1px solid #2a3f5a; margin: 0 4px 4px 0;
                color: ${LIGHT}; cursor: pointer; }
    .ssh-chip:hover { border-color: ${BLUE}; }
    .ssh-chip.active { border-color: ${AMBER}; color: ${AMBER}; background: rgba(233,184,74,.08); }
    .ssh-chip.empty { cursor: default; color: ${GREY}; }
    .ssh-chip i { font-style: normal; color: ${GREY}; margin-left: 4px; }
    .ssh-chip.active i { color: ${AMBER}; }
    .ssh-act { display: flex; align-items: center; gap: 6px; margin: 4px 0 8px; }
    .ssh-price { width: 56px; height: 24px; padding: 0 6px; background: #0f1a26; border: 1px solid #2a3f5a; border-radius: 2px;
                 color: ${LIGHT}; font: 11px Arial, sans-serif; }
    .ssh-list { display: inline-block; padding: 0 14px; height: 28px; line-height: 28px; border-radius: 2px; background: #75b022;
                color: #1b2838; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .ssh-list:hover { background: #8ed13a; }
    .ssh-list.busy { opacity: .6; pointer-events: none; }
    .ssh-market { margin-left: auto; color: ${BLUE}; white-space: nowrap; }
    .ssh-stats { border-top: 1px solid #2a3f5a; padding-top: 6px; }
    .ssh-stats b { color: ${LIGHT}; font-weight: normal; }
    .ssh-hover { position: absolute; z-index: 1000; background: #16202d; border: 1px solid #2a3f5a; border-radius: 3px;
                 padding: 6px 8px; display: flex; align-items: center; gap: 8px; font: 11px "Motiva Sans", Arial, sans-serif;
                 color: ${GREY}; pointer-events: none; white-space: nowrap; }
    .ssh-hover canvas { width: 90px; height: 24px; }
    .ssh-hover b { color: ${LIGHT}; font-weight: normal; }
  `;

  function addStyle() {
    if (document.getElementById('ssh-style')) return;
    const el = document.createElement('style');
    el.id = 'ssh-style';
    el.textContent = STYLE;
    document.head.appendChild(el);
  }

  function pref(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function setPref(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* storage blocked */ }
  }

  function getRange() {
    const r = +pref('ssh.range', '30');
    return RANGES.some(x => x[1] === r) ? r : 30;
  }

  function cacheGet(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return Date.now() - c.t > CACHE_TTL ? null : c.d;
    } catch (e) { return null; }
  }

  function cacheSet(key, d) {
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch (e) { /* quota */ }
  }

  const inflight = new Map();

  function fetchHistory(appid, hash, signal) {
    const key = `ssh:${appid}:${hash}`;
    const cached = cacheGet(key);
    if (cached) return Promise.resolve(cached);
    if (inflight.has(key)) return inflight.get(key);
    const url = `${location.origin}/market/pricehistory/?appid=${encodeURIComponent(appid)}` +
                `&market_hash_name=${encodeURIComponent(hash)}`;
    const p = (async () => {
      const res = await fetch(url, { credentials: 'same-origin', signal });
      if (res.status === 429) throw new Error('Steam is rate-limiting history requests. Try again in a minute.');
      if (res.status === 400) throw new Error('No sale history for this item, or not signed in.');
      if (!res.ok) throw new Error(`Steam answered ${res.status}.`);
      let data;
      try { data = await res.json(); } catch (e) { throw new Error('Sign in to Steam to see sale history.'); }
      if (!data || data.success !== true) throw new Error('No sale history for this item.');
      const out = { prefix: data.price_prefix || '', suffix: data.price_suffix || '', prices: data.prices || [] };
      cacheSet(key, out);
      return out;
    })();
    inflight.set(key, p);
    p.then(() => inflight.delete(key), () => inflight.delete(key));
    return p;
  }

  function panelName(panel) {
    const el = panel.querySelector('[id$="_item_name"]');
    return el ? (el.textContent || '').trim() : '';
  }

  function globalSelected() {
    const inv = window.g_ActiveInventory;
    const it = inv && inv.selectedItem;
    return it && it.description ? it : null;
  }

  // Which item a panel shows. Steam's own "View in Community Market" link is
  // authoritative, but Steam clears it on every click and only rebuilds it once
  // its price lookup answers (never, once that lookup is rate-limited), so fall
  // back on the inventory's selected item when its name matches the panel.
  function panelItem(panel) {
    const a = panel.querySelector('a[href*="/market/listings/"]:not(.ssh-market)');
    if (a) {
      const href = a.getAttribute('href') || '';
      const m = /\/market\/listings\/(\d+)\/([^?#]+)/.exec(href);
      if (m) {
        try { return { appid: m[1], hash: decodeURIComponent(m[2]), url: href, name: panelName(panel) }; } catch (e) { /* fall through */ }
      }
    }
    const it = globalSelected();
    const d = it && it.description;
    if (!d || !d.marketable || !d.market_hash_name) return null;
    const name = panelName(panel);
    if (name && name !== (d.name || '').trim() && name !== (d.market_name || '').trim()) return null;
    const appid = String(it.appid || d.appid);
    return { appid, hash: d.market_hash_name, name: name || d.name || '',
             url: `${location.origin}/market/listings/${appid}/${encodeURIComponent(d.market_hash_name)}` };
  }

  // Is this the item the inventory currently has selected? A panel keeps
  // mutating for a moment after the selection has moved on.
  function isCurrent(item) {
    const it = globalSelected();
    return !it || !it.description.market_hash_name || it.description.market_hash_name === item.hash;
  }

  function panelLowest(panel) {
    const el = panel && panel.querySelector('[id$="_item_market_actions"]');
    return el ? parseStartingAt(el.innerText || el.textContent) : null;
  }

  // One shared panel, mounted above the grid.
  const S = { key: null, item: null, panel: null, data: null, points: [], lowest: null, ask: MIN_ASK, askAuto: true,
              hover: -1, drag: false, scale: null, view: [], controller: null, suppressClick: false };
  let box = null;

  function mountBox(el) {
    const left = document.querySelector('.inventory_page_left');
    const grid = document.getElementById('inventories');
    const panel = document.getElementById('iteminfo0');
    if (left) left.insertBefore(el, left.firstChild);
    else if (grid && grid.parentElement) grid.parentElement.insertBefore(el, grid);
    else if (panel && panel.parentElement) panel.parentElement.insertBefore(el, panel);
    else document.body.appendChild(el);
  }

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'ssh-box' + (pref('ssh.open', '1') === '1' ? ' open' : '');
    box.style.display = 'none';
    box.innerHTML =
      '<div class="ssh-strip"><canvas class="ssh-spark"></canvas><span class="ssh-s-name"></span><span class="ssh-s-med"></span>' +
      '<span class="ssh-s-trend"></span><span class="ssh-s-day"></span><a class="ssh-toggle">Sale history ▾</a></div>' +
      '<div class="ssh-full">' +
      '<div class="ssh-head"><a class="ssh-toggle">Sale history ▴</a><span class="ssh-name"></span><span class="ssh-range"></span></div>' +
      '<div class="ssh-tip">&nbsp;</div>' +
      '<div class="ssh-charts"><canvas class="ssh-canvas"></canvas><canvas class="ssh-hist"></canvas></div>' +
      '<div class="ssh-chips"></div>' +
      '<div class="ssh-act"><input class="ssh-price" type="number" step="0.01" min="0.03">' +
      '<a class="ssh-list">List</a><a class="ssh-market" target="_blank" rel="noopener">Market ↗</a></div>' +
      '<div class="ssh-stats"></div></div>';

    for (const t of box.querySelectorAll('.ssh-toggle')) {
      t.addEventListener('click', e => {
        e.preventDefault();
        const open = !box.classList.contains('open');
        box.classList.toggle('open', open);
        setPref('ssh.open', open ? '1' : '0');
        if (open) redrawPrice();
      });
    }
    const ranges = box.querySelector('.ssh-range');
    for (const [label, days] of RANGES) {
      const a = document.createElement('a');
      a.textContent = label;
      a.dataset.days = String(days);
      a.addEventListener('click', e => { e.preventDefault(); setPref('ssh.range', days); render(); });
      ranges.appendChild(a);
    }
    const input = box.querySelector('.ssh-price');
    input.addEventListener('change', () => {
      const v = Math.round(parseFloat(input.value) * 100);
      if (isFinite(v)) setAsk(v, false);
      else input.value = (S.ask / 100).toFixed(2);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    box.querySelector('.ssh-list').addEventListener('click', e => { e.preventDefault(); listItem(); });

    const canvas = box.querySelector('.ssh-canvas');
    canvas.addEventListener('mousemove', onChartMove);
    canvas.addEventListener('mouseleave', onChartLeave);
    canvas.addEventListener('mousedown', onChartDown);
    canvas.addEventListener('click', onChartClick);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { if (canvas.clientWidth) redrawPrice(); }).observe(canvas);
    }
    mountBox(box);
    return box;
  }

  function setTip(text) {
    const tip = box && box.querySelector('.ssh-tip');
    if (tip) { if (text) tip.textContent = text; else tip.innerHTML = '&nbsp;'; }
  }

  function showMessage(text) {
    setTip(text);
    box.querySelector('.ssh-charts').style.display = 'none';
    box.querySelector('.ssh-chips').textContent = '';
    box.querySelector('.ssh-act').style.display = 'none';
    box.querySelector('.ssh-stats').textContent = '';
    box.querySelector('.ssh-s-med').textContent = text;
    box.querySelector('.ssh-s-trend').textContent = '';
    box.querySelector('.ssh-s-day').textContent = '';
    const spark = box.querySelector('.ssh-spark');
    spark.getContext('2d').clearRect(0, 0, spark.width, spark.height);
  }

  function setName(name) {
    for (const el of box.querySelectorAll('.ssh-name, .ssh-s-name')) el.textContent = name || '';
  }

  async function update(panel) {
    ensureBox();
    const item = panelItem(panel);
    if (!item) {
      // The panel shows nothing marketable. Hide only if it is the live selection.
      const it = globalSelected();
      if (!it || !it.description.marketable || !panelName(panel) || panelName(panel) === (it.description.name || '').trim()) {
        box.style.display = 'none';
        S.key = null; S.item = null; S.panel = null; S.data = null; S.points = []; S.view = [];
      }
      return;
    }
    if (!isCurrent(item)) return;
    box.style.display = '';
    const key = item.appid + '/' + item.hash;
    if (S.key === key) { S.panel = panel; refreshLowest(); return; }
    S.key = key;
    S.item = item;
    S.panel = panel;
    S.data = null;
    S.points = [];
    S.view = [];
    S.hover = -1;
    S.drag = false;
    S.askAuto = true;
    S.lowest = panelLowest(panel);
    setName(item.name);
    box.querySelector('.ssh-market').href = item.url;
    box.querySelector('.ssh-list').classList.remove('busy');
    if (S.controller) S.controller.abort();
    S.controller = new AbortController();
    showMessage('Loading sale history…');
    try {
      const data = await fetchHistory(item.appid, item.hash, S.controller.signal);
      if (S.key !== key) return;
      S.data = data;
      S.points = toPoints(data.prices);
      S.ask = defaultAsk();
      render();
    } catch (e) {
      if (e.name === 'AbortError' || S.key !== key) return;
      showMessage(e.message);
    }
  }

  function defaultAsk() {
    if (S.lowest != null) return Math.max(MIN_ASK, Math.round(S.lowest * 100));
    const s30 = periodStats(S.points, 30, Date.now());
    if (s30.median != null) return Math.max(MIN_ASK, Math.round(s30.median * 100));
    if (S.points.length) return Math.max(MIN_ASK, Math.round(S.points[S.points.length - 1].p * 100));
    return MIN_ASK;
  }

  // Steam fills "Starting at" a moment after the panel opens; pick it up when it lands.
  function refreshLowest() {
    const v = panelLowest(S.panel);
    if (v === S.lowest) return;
    S.lowest = v;
    if (!S.data) return;
    if (S.askAuto) S.ask = defaultAsk();
    renderChips();
    redrawPrice();
  }

  function render() {
    if (!S.data || !box) return;
    const now = Date.now();
    const days = getRange();
    for (const a of box.querySelectorAll('.ssh-range a')) a.classList.toggle('active', +a.dataset.days === days);

    if (!S.points.length) { showMessage('No sales recorded.'); return; }

    renderStrip(now);

    const s = periodStats(S.points, days, now);
    S.view = s.view;
    S.hover = -1;
    const m = n => money(S.data.prefix, S.data.suffix, n);
    const label = days ? `${days}d` : 'all time';
    box.querySelector('.ssh-chips').style.display = '';
    box.querySelector('.ssh-act').style.display = '';
    const stats = box.querySelector('.ssh-stats');
    if (!s.view.length) {
      box.querySelector('.ssh-charts').style.display = 'none';
      setTip(`No sales in the last ${label}.`);
      stats.textContent = '';
    } else {
      box.querySelector('.ssh-charts').style.display = '';
      setTip('');
      const trend = s.trend == null ? '' :
        ` · <span class="${s.trend >= 0 ? 'ssh-up' : 'ssh-down'}">${fmtTrend(s.trend)}</span> on the ${label} before`;
      stats.innerHTML =
        `Sold <b>${s.sold}</b> in ${label} · <b>${fmtRate(s.perDay)} / day</b>${trend} · low <b>${m(s.low)}</b>`;
    }
    renderChips();
    redrawPrice();
  }

  function renderStrip(now) {
    const s = periodStats(S.points, 30, now);
    const pts = s.view.length >= 2 ? s.view : S.points;
    drawSpark(box.querySelector('.ssh-spark'), pts);
    const m = n => money(S.data.prefix, S.data.suffix, n);
    box.querySelector('.ssh-s-med').textContent = s.median != null ? `${m(s.median)} med` : 'No sales in 30d';
    const tr = box.querySelector('.ssh-s-trend');
    tr.textContent = fmtTrend(s.trend);
    tr.className = 'ssh-s-trend ' + (s.trend != null && s.trend < 0 ? 'ssh-down' : 'ssh-up');
    box.querySelector('.ssh-s-day').textContent = s.view.length ? `${fmtRate(s.perDay)} / day` : '';
  }

  function renderChips() {
    const wrap = box && box.querySelector('.ssh-chips');
    if (!wrap || !S.data) return;
    wrap.textContent = '';
    const now = Date.now();
    const s7 = periodStats(S.points, 7, now), s30 = periodStats(S.points, 30, now);
    const defs = [['Lowest listing', S.lowest], ['7d median', s7.median], ['30d median', s30.median], ['30d high', s30.high]];
    for (const [label, val] of defs) {
      const a = document.createElement('a');
      a.className = 'ssh-chip';
      const i = document.createElement('i');
      a.textContent = label;
      i.textContent = val == null ? '—' : money(S.data.prefix, S.data.suffix, val);
      a.appendChild(i);
      if (val != null) {
        a.dataset.cents = String(Math.round(val * 100));
        a.addEventListener('click', e => { e.preventDefault(); setAsk(+a.dataset.cents, false); });
      } else {
        a.classList.add('empty');
      }
      wrap.appendChild(a);
    }
    markChips();
  }

  function markChips() {
    for (const a of box.querySelectorAll('.ssh-chip')) a.classList.toggle('active', a.dataset.cents === String(S.ask));
  }

  function feesFor() {
    const it = globalSelected();
    const d = it && it.description;
    const wi = window.g_rgWalletInfo;
    let pub = d && d.market_fee != null ? parseFloat(d.market_fee) : NaN;
    if (!isFinite(pub)) pub = wi && wi.wallet_publisher_fee_percent_default != null ? parseFloat(wi.wallet_publisher_fee_percent_default) : 0.10;
    if (wi && wi.wallet_fee) {
      return { pct: parseFloat(wi.wallet_fee_percent) || 0.05, min: parseInt(wi.wallet_fee_minimum, 10) || 1,
               base: parseInt(wi.wallet_fee_base, 10) || 0, pub };
    }
    return { pct: 0.05, min: 1, base: 0, pub };
  }

  function setAsk(cents, auto) {
    S.ask = Math.max(MIN_ASK, Math.round(cents));
    S.askAuto = !!auto;
    redrawPrice();
  }

  // Everything that depends on the asking price: input, chips, button, both canvases.
  function redrawPrice() {
    if (!S.data || !box || !box.classList.contains('open')) return;
    const m = n => money(S.data.prefix, S.data.suffix, n);
    const input = box.querySelector('.ssh-price');
    if (document.activeElement !== input) input.value = (S.ask / 100).toFixed(2);
    markChips();
    const recv = receivedForBuyerPays(S.ask, feesFor());
    const btn = box.querySelector('.ssh-list');
    if (!btn.classList.contains('busy')) btn.textContent = `List at ${m(S.ask / 100)} · you get ${m(recv / 100)}`;
    if (S.view.length) {
      drawChart(S.hover);
      drawHist();
    }
  }

  function setupCanvas(canvas, H) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    if (!W) return null;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px "Motiva Sans", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    return { ctx, W, H };
  }

  function axisLabel(t, span) {
    const d = new Date(t);
    if (span <= 2 * DAY) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (span <= 400 * DAY) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
  }

  function pointLabel(p, now) {
    const d = new Date(p.t);
    const date = d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const hourly = now - p.t < 32 * DAY;
    return hourly ? date + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date;
  }

  function drawChart(hoverIdx) {
    const canvas = box.querySelector('.ssh-canvas');
    const pts = S.view;
    const c = setupCanvas(canvas, HEIGHT);
    if (!c) return;
    const { ctx, W, H } = c;
    const { L, R, T, B } = PAD;
    const pw = W - L - R, ph = H - T - B;
    const single = pts.length < 2;
    const t0 = pts[0].t, t1 = single ? t0 + 1 : pts[pts.length - 1].t, span = t1 - t0;
    let pmax = S.ask / 100, vmax = 0;
    if (S.lowest != null && S.lowest > pmax) pmax = S.lowest;
    for (const p of pts) { if (p.p > pmax) pmax = p.p; if (p.v > vmax) vmax = p.v; }
    pmax = pmax * 1.12 || 1;
    vmax = vmax || 1;
    const X = t => L + (t - t0) / span * pw;
    const Y = p => T + ph - (p / pmax) * ph;
    S.scale = { L, R, T, ph, pw, pmax, t0, span };
    const m = n => money(S.data.prefix, S.data.suffix, n);

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = GREY;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const v = pmax * i / 3, y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillText(m(v), L - 4, y);
    }

    const bw = Math.max(1, Math.min(6, pw / Math.max(1, pts.length)));
    ctx.fillStyle = 'rgba(143,152,160,0.25)';
    for (const p of pts) {
      const h = p.v / vmax * ph * 0.3;
      ctx.fillRect(X(p.t) - bw / 2, T + ph - h, bw, h);
    }

    if (!single) {
      ctx.beginPath();
      ctx.moveTo(X(t0), Y(pts[0].p));
      for (const p of pts) ctx.lineTo(X(p.t), Y(p.p));
      ctx.lineTo(X(t1), T + ph);
      ctx.lineTo(X(t0), T + ph);
      ctx.closePath();
      ctx.fillStyle = 'rgba(102,192,244,0.12)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X(t0), Y(pts[0].p));
      for (const p of pts) ctx.lineTo(X(p.t), Y(p.p));
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      ctx.beginPath(); ctx.arc(X(t0), Y(pts[0].p), 3, 0, Math.PI * 2);
      ctx.fillStyle = BLUE; ctx.fill();
    }

    ctx.fillStyle = GREY;
    const n = single ? 1 : 4;
    for (let i = 0; i <= n; i++) {
      const t = t0 + span * i / n;
      ctx.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center';
      ctx.fillText(axisLabel(t, span), X(t), H - B / 2);
    }

    if (S.lowest != null) {
      const y = Math.round(Y(S.lowest)) + 0.5;
      ctx.strokeStyle = GREY;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = 'left';
      ctx.fillStyle = GREY;
      ctx.fillText('lowest listing', L + 3, y + 8);
    }

    const ya = Math.round(Y(S.ask / 100)) + 0.5;
    ctx.strokeStyle = AMBER;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(L, ya); ctx.lineTo(W - R, ya); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'right';
    ctx.fillText(m(S.ask / 100), W - R - 2, ya - 7);
    ctx.fillRect(W - R + 2, ya - 6, 12, 12);
    ctx.fillStyle = '#1b2838';
    ctx.fillRect(W - R + 5, ya - 2, 6, 1);
    ctx.fillRect(W - R + 5, ya + 1, 6, 1);

    if (!single && hoverIdx >= 0 && hoverIdx < pts.length) {
      const p = pts[hoverIdx], x = Math.round(X(p.t)) + 0.5, y = Y(p.p);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  }

  function drawHist() {
    const canvas = box.querySelector('.ssh-hist');
    const c = setupCanvas(canvas, HEIGHT);
    if (!c) return;
    const { ctx, W, H } = c;
    const T = 30, B = 18, L = 4, R = 4;
    const pw = W - L - R, ph = H - T - B;
    const bins = priceBins(S.view, 11);
    const ask = S.ask / 100;
    const share = shareAtOrAbove(S.view, ask);
    ctx.textAlign = 'left';
    ctx.fillStyle = GREY;
    ctx.fillText('Sales by price', L, 7);
    if (share != null) {
      ctx.fillStyle = AMBER;
      ctx.fillText(`${Math.round(share * 100)}% at or above`, L, 19);
    }
    if (!bins.length) return;
    let vmax = 0;
    for (const b of bins) if (b.v > vmax) vmax = b.v;
    vmax = vmax || 1;
    const slot = pw / bins.length;
    const bw = Math.max(2, slot - 2);
    bins.forEach((b, i) => {
      const h = b.v / vmax * ph;
      const x = L + i * slot + (slot - bw) / 2;
      const centre = (b.from + b.to) / 2;
      ctx.fillStyle = centre >= ask - 1e-9 ? BLUE : 'rgba(102,192,244,0.35)';
      ctx.fillRect(x, T + ph - h, bw, h);
    });
    ctx.fillStyle = GREY;
    ctx.textAlign = 'left';
    ctx.fillText(bins[0].from.toFixed(2), L, H - B / 2);
    if (bins.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(bins[bins.length - 1].from.toFixed(2), W - R, H - B / 2);
    }
  }

  function drawSpark(canvas, pts) {
    const c = setupCanvas(canvas, 28);
    if (!c || pts.length < 2) return;
    const { ctx, W, H } = c;
    let pmax = 0;
    for (const p of pts) if (p.p > pmax) pmax = p.p;
    pmax = pmax || 1;
    const t0 = pts[0].t, span = pts[pts.length - 1].t - t0 || 1;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (p.t - t0) / span * (W - 2) + 1, y = H - 2 - p.p / pmax * (H - 4);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function priceAtY(y) {
    const s = S.scale;
    const p = (s.T + s.ph - y) / s.ph * s.pmax;
    return Math.max(MIN_ASK, Math.round(p * 100));
  }

  function askLineY() {
    return S.scale.T + S.scale.ph - (S.ask / 100) / S.scale.pmax * S.scale.ph;
  }

  function askTip() {
    const m = n => money(S.data.prefix, S.data.suffix, n);
    const recv = receivedForBuyerPays(S.ask, feesFor());
    const share = shareAtOrAbove(S.view, S.ask / 100);
    const sh = share == null ? '' : ` · ${Math.round(share * 100)}% of sales at or above`;
    return `Asking ${m(S.ask / 100)} · you get ${m(recv / 100)}${sh}`;
  }

  function onChartMove(e) {
    if (!S.scale || !S.view.length || S.drag) return;
    const canvas = e.currentTarget;
    const nearAsk = Math.abs(e.offsetY - askLineY()) <= 6;
    canvas.style.cursor = nearAsk ? 'ns-resize' : 'crosshair';
    if (nearAsk) {
      if (S.hover !== -1) { S.hover = -1; drawChart(-1); }
      setTip(askTip() + ' · drag to change');
      return;
    }
    if (S.view.length < 2) return;
    const s = S.scale;
    const t = s.t0 + Math.min(Math.max((e.offsetX - s.L) / s.pw, 0), 1) * s.span;
    const i = nearestIndex(S.view, t);
    if (i === S.hover) return;
    S.hover = i;
    drawChart(i);
    const p = S.view[i];
    setTip(`${pointLabel(p, Date.now())} · ${money(S.data.prefix, S.data.suffix, p.p)} · ${p.v} sold · click to ask this`);
  }

  // A click on the chart asks the price of the point under the cursor.
  function onChartClick(e) {
    if (S.suppressClick) { S.suppressClick = false; return; }
    if (!S.scale || !S.view.length) return;
    if (Math.abs(e.offsetY - askLineY()) <= 6) return;
    const cents = S.hover >= 0 && S.hover < S.view.length
      ? Math.round(S.view[S.hover].p * 100)
      : priceAtY(e.offsetY);
    setAsk(cents, false);
    setTip(askTip());
  }

  function onChartLeave() {
    if (S.drag) return;
    if (S.hover !== -1) { S.hover = -1; drawChart(-1); }
    setTip('');
  }

  function onChartDown(e) {
    if (!S.scale || !S.view.length || e.button !== 0) return;
    if (Math.abs(e.offsetY - askLineY()) > 6) return;
    e.preventDefault();
    S.drag = true;
    S.hover = -1;
    const canvas = e.currentTarget;
    const move = ev => {
      const y = ev.clientY - canvas.getBoundingClientRect().top;
      S.ask = priceAtY(Math.min(Math.max(y, S.scale.T), S.scale.T + S.scale.ph));
      S.askAuto = false;
      redrawPrice();
      setTip(askTip());
    };
    const up = () => {
      S.drag = false;
      S.suppressClick = true;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      redrawPrice();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function sessionId() {
    if (window.g_sessionID) return window.g_sessionID;
    const m = /(?:^|;\s*)sessionid=([^;]+)/.exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function listItem() {
    const btn = box.querySelector('.ssh-list');
    if (!S.data || btn.classList.contains('busy')) return;
    const it = globalSelected();
    const d = it && it.description;
    if (!d) { setTip('Select the item first.'); return; }
    if (d.market_hash_name !== S.item.hash) { setTip('The panel and the selected item differ. Click the item again.'); return; }
    if (!d.marketable) { setTip('This item cannot be listed on the market.'); return; }
    const sid = sessionId();
    if (!sid) { setTip('No Steam session found. Reload the page.'); return; }
    const m = n => money(S.data.prefix, S.data.suffix, n);
    const recv = receivedForBuyerPays(S.ask, feesFor());
    const label = btn.textContent;
    btn.classList.add('busy');
    btn.textContent = 'Listing…';
    try {
      const body = new URLSearchParams({
        sessionid: sid, appid: String(it.appid), contextid: String(it.contextid),
        assetid: String(it.assetid || it.id), amount: '1', price: String(recv),
      });
      const res = await fetch(`${location.origin}/market/sellitem/`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body.toString(),
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (!res.ok || !data || !data.success) throw new Error((data && data.message) || `Steam answered ${res.status}.`);
      btn.textContent = `Listed at ${m(S.ask / 100)}`;
      setTip(data.needs_mobile_confirmation ? 'Listed. Confirm it in the Steam mobile app.' :
             data.needs_email_confirmation ? 'Listed. Confirm it by email.' : 'Listed.');
      if (it.element && it.element.style) it.element.style.opacity = '0.35';
    } catch (e) {
      btn.classList.remove('busy');
      btn.textContent = label;
      setTip(e.message);
    }
  }

  // Sparkline tooltip when the mouse rests on a tile in the grid.
  function lookupAsset(tile) {
    if (tile.rgItem) return tile.rgItem;
    const m = /^item(\d+)_(\d+)_(\d+)$/.exec(tile.id || '');
    const inv = window.g_ActiveInventory;
    if (!m || !inv) return null;
    const assets = inv.m_rgAssets;
    return assets && assets[m[3]] ? assets[m[3]] : null;
  }

  function initGridHover() {
    const tipEl = document.createElement('div');
    tipEl.className = 'ssh-hover';
    tipEl.style.display = 'none';
    document.body.appendChild(tipEl);
    let timer = 0, current = null;

    const hide = () => { current = null; clearTimeout(timer); tipEl.style.display = 'none'; };

    document.addEventListener('mouseover', e => {
      const tile = e.target && e.target.closest ? e.target.closest('#inventories .item') : null;
      if (!tile || tile === current) return;
      hide();
      current = tile;
      timer = setTimeout(() => showTileHover(tile, tipEl), 450);
    });
    document.addEventListener('mouseout', e => {
      const tile = e.target && e.target.closest ? e.target.closest('#inventories .item') : null;
      if (!tile || tile !== current) return;
      if (e.relatedTarget && tile.contains(e.relatedTarget)) return;
      hide();
    });
    document.addEventListener('mousedown', hide, true);
  }

  async function showTileHover(tile, tipEl) {
    const rg = lookupAsset(tile);
    const d = rg && rg.description;
    if (!d || !d.marketable || !d.market_hash_name) return;
    let data;
    try { data = await fetchHistory(String(rg.appid || d.appid), d.market_hash_name); } catch (e) { return; }
    if (!tile.matches(':hover')) return;
    const points = toPoints(data.prices);
    const now = Date.now();
    const s = periodStats(points, 30, now);
    tipEl.textContent = '';
    const spark = document.createElement('canvas');
    const name = document.createElement('b');
    name.textContent = d.name || d.market_hash_name;
    tipEl.appendChild(spark);
    tipEl.appendChild(name);
    if (s.median != null) {
      const med = document.createElement('span');
      med.textContent = `${money(data.prefix, data.suffix, s.median)} med`;
      tipEl.appendChild(med);
      if (s.trend != null) {
        const tr = document.createElement('span');
        tr.className = s.trend < 0 ? 'ssh-down' : 'ssh-up';
        tr.textContent = fmtTrend(s.trend);
        tipEl.appendChild(tr);
      }
      const rate = document.createElement('span');
      rate.textContent = `${fmtRate(s.perDay)} / day`;
      tipEl.appendChild(rate);
    } else {
      const none = document.createElement('span');
      none.textContent = points.length ? 'no sales in 30d' : 'no sale history';
      tipEl.appendChild(none);
    }
    const r = tile.getBoundingClientRect();
    tipEl.style.display = '';
    const w = tipEl.offsetWidth;
    const left = Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 8);
    tipEl.style.left = `${Math.max(0, left)}px`;
    tipEl.style.top = `${r.bottom + window.scrollY + 4}px`;
    drawSpark(spark, s.view.length >= 2 ? s.view : points);
  }

  function watch(panel) {
    let timer = 0;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => update(panel), 150);
    }).observe(panel, { childList: true, subtree: true });
  }

  function init() {
    const panels = ['iteminfo0', 'iteminfo1'].map(id => document.getElementById(id)).filter(Boolean);
    if (!panels.length) return;
    addStyle();
    ensureBox();
    for (const p of panels) { watch(p); update(p); }
    initGridHover();
  }

  init();
})();
