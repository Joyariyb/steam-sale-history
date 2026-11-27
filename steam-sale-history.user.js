// ==UserScript==
// @name         Steam Inventory Sale History
// @namespace    joey.steam-tools
// @version      3.2.0
// @description  Sale history above the inventory grid. Each card opens priced at its 30-day held high (outliers set aside), so selling is two clicks: card, List. Chart, clickable sales-by-price bars, price chips, list-all, auto-advance, keyboard and tile price badges.
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
  const MIN_ASK = 3;

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

  // The highest price that held: at least `trim` of the units (and never fewer
  // than three) sold at or above it, with a real part of them (a quarter of that
  // number) on each of two separate days. A lone spike, or a surge that lasted
  // one day, falls outside that and is left out. null with no sales.
  function heldHigh(points, trim) {
    const sold = points.filter(p => p.v > 0);
    let total = 0;
    for (const p of sold) total += p.v;
    if (!total) return null;
    const need = Math.max(3, Math.ceil(total * trim));
    const perDay = Math.ceil(need / 4);
    sold.sort((a, b) => b.p - a.p);
    const days = new Map();
    let units = 0, strong = 0;
    for (const p of sold) {
      const d = Math.floor(p.t / DAY), before = days.get(d) || 0;
      units += p.v;
      days.set(d, before + p.v);
      if (before < perDay && before + p.v >= perDay) strong++;
      if (units >= need && strong >= 2) return p.p;
    }
    return sold[sold.length - 1].p;
  }

  // How much sold at or above a price: units, separate days, and when last.
  function soldAtOrAbove(points, price) {
    const days = new Set();
    let units = 0, total = 0, last = null;
    for (const p of points) {
      total += p.v;
      if (p.v > 0 && p.p >= price - 1e-9) {
        units += p.v;
        days.add(Math.floor(p.t / DAY));
        if (last === null || p.t > last) last = p.t;
      }
    }
    return { units, days: days.size, last, total };
  }

  // The price a card opens on, in cents, and why. Prices in o are in currency
  // units and may be null. source: 'held30' | 'held7' | 'lowest'.
  function pickAsk(o) {
    const cents = x => (x == null || !isFinite(x)) ? null : Math.max(MIN_ASK, Math.round(x * 100));
    const held30 = cents(o.held30), held7 = cents(o.held7), lowest = cents(o.lowest);
    let c = null, why = null;
    if (o.source === 'lowest' && lowest != null) { c = lowest; why = 'lowest'; }
    else if (o.source === 'held7' && held7 != null) { c = held7; why = 'held7'; }
    else if (held30 != null) { c = held30; why = 'held30'; }
    if (c == null) {
      if (lowest != null) return { cents: lowest, why: 'lowest' };
      if (cents(o.median) != null) return { cents: cents(o.median), why: 'median' };
      if (cents(o.last) != null) return { cents: cents(o.last), why: 'last' };
      return { cents: MIN_ASK, why: 'floor' };
    }
    // The market has moved above anything that held: sit just under the cheapest listing.
    if (o.undercut && why !== 'lowest' && lowest != null && lowest - 1 > c) return { cents: lowest - 1, why: 'undercut' };
    return { cents: c, why };
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

  // Steam's own "This item is worth: 10 Gems" line in the item panel.
  function parseGems(text) {
    const m = /worth:\s*(\d[\d,.\s]*)\s*Gems?/i.exec(text || '');
    if (!m) return null;
    const n = parseInt(m[1].replace(/\D/g, ''), 10);
    return isFinite(n) && n > 0 ? n : null;
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

  // "today", "yesterday", "12 days ago".
  function fmtAgo(t, now) {
    const d = Math.max(0, Math.floor((now - t) / DAY));
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
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
  const HEIGHT = 160;
  const HIST_H = 76;
  const STALE_DAYS = 10;
  const LIST_GAP = 400;
  const BLUE = '#66c0f4', AMBER = '#e9b84a', VIOLET = '#b9a3e3', GREY = '#8f98a0', LIGHT = '#c6d4df', SLATE = '#56616b';

  // Pricing rules, each kept in localStorage: [key, default].
  const RULES = {
    source: ['ssh.source', 'held30'], trim: ['ssh.trim', '0.05'], undercut: ['ssh.undercut', '1'],
    stale: ['ssh.stale', '1'], advance: ['ssh.advance', '1'], keys: ['ssh.keys', '1'], remember: ['ssh.remember', '0'], dock: ['ssh.dock', '1'],
  };
  const SOURCES = [['held30', 'Held high, 30 days'], ['held7', 'Held high, 7 days'], ['lowest', 'Cheapest listing']];
  const TRIMS = [['0.02', 'Loose, top 2%'], ['0.05', 'Balanced, top 5%'], ['0.1', 'Strict, top 10%']];
  const CHECKS = [
    ['undercut', 'When the cheapest listing is above the held high, ask one cent under it'],
    ['stale', `Warn when nothing has held that high in the last ${STALE_DAYS} days`],
    ['advance', 'After listing, select the next unlisted card'],
    ['keys', 'Keyboard: Enter lists, arrow keys move between cards, 1 to 5 pick a price'],
    ['remember', 'Remember a price I set by hand for that card'],
    ['dock', 'Sit beside the grid, in the page margin, when there is room'],
  ];
  const WHY = {
    held30: 'Held high, 30 days', held7: 'Held high, 7 days', lowest: 'Cheapest listing',
    undercut: 'One cent under the cheapest listing', median: '30-day median', last: 'Last sale price',
    floor: 'Lowest price Steam allows', saved: 'Your saved price',
  };

  const STYLE = `
    .ssh-box { box-sizing: border-box; width: 100%; margin: 0 0 8px; padding: 8px 10px; background: rgba(0,0,0,.3);
               border: 1px solid #2a3f5a; border-radius: 3px; font: 11px "Motiva Sans", Arial, sans-serif; color: ${GREY}; }
    .ssh-box.dock { position: fixed; z-index: 400; margin: 0; overflow-y: auto; background: #16202d; }
    .ssh-box a { text-decoration: none; cursor: pointer; }
    .ssh-strip { display: flex; align-items: center; gap: 10px; min-height: 28px; }
    .ssh-box.open .ssh-strip { display: none; }
    .ssh-box:not(.open) .ssh-full { display: none; }
    .ssh-box.nodata .ssh-d { display: none !important; }
    .ssh-spark { width: 110px; height: 28px; flex: none; }
    .ssh-s-name { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .ssh-s-note { white-space: nowrap; }
    .ssh-warn { color: ${AMBER}; }
    .ssh-up { color: #75b022; } .ssh-down { color: #e06b5c; }
    .ssh-toggle { color: ${BLUE}; padding: 2px 4px; font-size: 13px; line-height: 1; }
    .ssh-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .ssh-name { color: #fff; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .ssh-range { white-space: nowrap; }
    .ssh-range a { color: ${GREY}; margin-left: 2px; padding: 2px 8px; border-radius: 9px; }
    .ssh-range a.active { background: #2a475e; color: ${BLUE}; }
    .ssh-gear { color: ${BLUE}; }
    .ssh-rules { display: none; margin: 0 0 10px; padding: 10px; background: #16202d; border: 1px solid #2a3f5a; border-radius: 3px; color: ${LIGHT}; }
    .ssh-box.rules .ssh-rules { display: block; }
    .ssh-rules h5 { margin: 0 0 4px; font: 11px "Motiva Sans", Arial, sans-serif; color: ${GREY}; }
    .ssh-seg { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
    .ssh-seg a { padding: 3px 9px; border: 1px solid #2a3f5a; border-radius: 3px; color: ${LIGHT}; }
    .ssh-seg a.active { border-color: ${AMBER}; color: ${AMBER}; background: rgba(233,184,74,.1); }
    .ssh-rules p { margin: -3px 0 8px; color: ${GREY}; }
    .ssh-rules label { display: flex; gap: 6px; align-items: flex-start; margin-top: 5px; cursor: pointer; }
    .ssh-rules input { margin: 1px 0 0; flex: none; }
    .ssh-hero { display: flex; align-items: stretch; gap: 12px; }
    .ssh-ask { flex: none; }
    .ssh-lbl { font-size: 10px; letter-spacing: .06em; }
    .ssh-askrow { display: flex; align-items: baseline; color: ${AMBER}; font-size: 24px; line-height: 32px; white-space: nowrap; }
    .ssh-price { width: 82px; height: 32px; padding: 0 2px; background: transparent; border: 0; border-bottom: 1px solid transparent;
                 color: ${AMBER}; font: 24px "Motiva Sans", Arial, sans-serif; -moz-appearance: textfield; appearance: textfield; }
    .ssh-price:hover, .ssh-price:focus { border-bottom-color: ${AMBER}; outline: none; }
    .ssh-price::-webkit-outer-spin-button, .ssh-price::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .ssh-gems { display: inline-flex; align-items: center; gap: 5px; margin-top: 3px; padding: 0 8px 0 6px; border: 1px solid #4b3f72;
                border-radius: 9px; background: rgba(169,140,232,.1); color: ${VIOLET}; line-height: 16px; white-space: nowrap; }
    .ssh-why { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
    .ssh-why-t { color: #fff; font-size: 12px; }
    .ssh-why-t a { color: ${BLUE}; font-size: 11px; margin-left: 6px; }
    .ssh-why-d { color: #a9b4bd; }
    .ssh-do { flex: none; width: 160px; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
    .ssh-list { display: block; box-sizing: border-box; border-radius: 3px; background: #75b022; color: #10202b; text-align: center;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ssh-list:hover { background: #8ed13a; }
    .ssh-list.busy { opacity: .6; pointer-events: none; }
    .ssh-list.done { background: #2a3f5a; color: ${LIGHT}; pointer-events: none; }
    .ssh-f-list { padding: 6px 6px; }
    .ssh-f-list b { display: block; font-size: 14px; line-height: 18px; }
    .ssh-f-list i { display: block; font-style: normal; line-height: 14px; overflow: hidden; text-overflow: ellipsis; }
    .ssh-s-list { padding: 0 12px; height: 24px; line-height: 24px; font-weight: bold; flex: none; }
    .ssh-all { display: block; padding: 3px 0; border: 1px solid #3d6b1f; border-radius: 3px; color: #a4d007; text-align: center; white-space: nowrap; }
    .ssh-all:hover { border-color: #75b022; }
    .ssh-all.busy { opacity: .5; pointer-events: none; }
    .ssh-tip { min-height: 14px; line-height: 14px; margin: 6px 0 2px; color: ${LIGHT}; }
    .ssh-canvas { display: block; width: 100%; height: ${HEIGHT}px; cursor: crosshair; }
    .ssh-railhead { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .ssh-share { color: ${AMBER}; white-space: nowrap; }
    .ssh-hist { display: block; width: 100%; height: ${HIST_H}px; cursor: pointer; }
    .ssh-chips { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; margin: 6px 0 8px; }
    .ssh-chip { display: block; padding: 4px 7px; border-radius: 3px; border: 1px solid #2a3f5a; color: ${GREY}; font-size: 10px;
                white-space: nowrap; overflow: hidden; }
    .ssh-chip:hover { border-color: ${BLUE}; }
    .ssh-chip i { display: block; font-style: normal; font-size: 13px; color: ${LIGHT}; }
    .ssh-chip.active, .ssh-chip.active i { border-color: ${AMBER}; color: ${AMBER}; }
    .ssh-chip.active { background: rgba(233,184,74,.1); }
    .ssh-chip.empty { cursor: default; }
    .ssh-chip.empty:hover { border-color: #2a3f5a; }
    .ssh-stats { display: flex; gap: 10px; align-items: center; border-top: 1px solid #2a3f5a; padding-top: 6px; }
    .ssh-st { flex: 1; min-width: 0; }
    .ssh-stats b { color: ${LIGHT}; font-weight: normal; }
    .ssh-tally { color: #a4d007; white-space: nowrap; }
    .ssh-market { color: ${BLUE}; white-space: nowrap; }
    .ssh-hover { position: absolute; z-index: 1000; background: #16202d; border: 1px solid #2a3f5a; border-radius: 3px;
                 padding: 6px 8px; display: flex; align-items: center; gap: 8px; font: 11px "Motiva Sans", Arial, sans-serif;
                 color: ${GREY}; pointer-events: none; white-space: nowrap; }
    .ssh-hover canvas { width: 90px; height: 24px; }
    .ssh-hover b { color: ${LIGHT}; font-weight: normal; }
    .ssh-hover em { color: ${AMBER}; font-style: normal; }
    .ssh-badge { position: absolute; left: 2px; bottom: 2px; z-index: 3; padding: 0 3px; border-radius: 2px; background: rgba(0,0,0,.72);
                 color: ${LIGHT}; font: 10px/14px "Motiva Sans", Arial, sans-serif; pointer-events: none; }
    .ssh-badge:empty { display: none; }
    .ssh-badge.done { color: #a4d007; }
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

  function dropPref(key) {
    try { localStorage.removeItem(key); } catch (e) { /* storage blocked */ }
  }

  const rule = k => pref(RULES[k][0], RULES[k][1]);
  const on = k => rule(k) === '1';

  function trimValue() {
    const t = parseFloat(rule('trim'));
    return TRIMS.some(x => parseFloat(x[0]) === t) ? t : 0.05;
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
    if (!panel) return null;
    const el = panel.querySelector('[id$="_item_market_actions"]');
    const v = el ? parseStartingAt(el.innerText || el.textContent) : null;
    // Other inventory extensions move that block; the line itself is still somewhere in the panel.
    return v != null ? v : parseStartingAt(panel.innerText || panel.textContent);
  }

  // Gem value, read from the text Steam shows. innerText only: it leaves out the
  // hidden block a reused panel still holds from an earlier item.
  function panelGems(panel) {
    return panel ? parseGems(panel.innerText) : null;
  }

  // One shared panel, mounted above the grid.
  const S = { key: null, item: null, panel: null, data: null, points: [], p30: [], lowest: null, gems: null, ask: MIN_ASK, manual: false,
              why: null, held30: null, held7: null, heldRecent: null, med30: null, raw30: null, cut: 0, left: 0, chipCents: [], rail: null,
              hover: -1, drag: false, scale: null, view: [], controller: null, suppressClick: false };
  let box = null;
  let listing = false;

  // What this session has listed: asset -> price text, item -> count, and the running total.
  const listed = new Map();
  const listedByItem = new Map();
  const tally = { n: 0, cents: 0 };
  // Price text shown on the tiles of each item whose history is known, by market hash name.
  const badges = new Map();

  const assetKey = a => `${a.appid}_${a.contextid}_${a.assetid || a.id}`;
  const m$ = n => money(S.data.prefix, S.data.suffix, n);

  // Unlisted copies of an item among the inventory's loaded assets, the selected one first.
  function copiesOf(item) {
    const inv = window.g_ActiveInventory;
    const assets = inv && inv.m_rgAssets;
    const sel = globalSelected();
    const out = [];
    if (assets) {
      for (const id in assets) {
        const a = assets[id], d = a && a.description;
        if (d && d.marketable && d.market_hash_name === item.hash && !listed.has(assetKey(a))) out.push(a);
      }
    }
    if (sel && sel.description.market_hash_name === item.hash && !listed.has(assetKey(sel))) {
      const i = out.indexOf(sel);
      if (i > 0) out.splice(i, 1);
      if (i !== 0) out.unshift(sel);
    }
    return out;
  }

  // Write the price badge (or the listed mark) onto every tile of one item.
  function paintBadges(hash) {
    const inv = window.g_ActiveInventory;
    const assets = inv && inv.m_rgAssets;
    if (!assets) return;
    const text = badges.get(hash) || '';
    for (const id in assets) {
      const a = assets[id], d = a && a.description, el = a && a.element;
      if (!el || !d || d.market_hash_name !== hash) continue;
      const host = el.parentElement && el.parentElement.classList.contains('itemHolder') ? el.parentElement : el;
      let b = null;
      for (const c of host.children) if (c.classList && c.classList.contains('ssh-badge')) { b = c; break; }
      if (!b) {
        b = document.createElement('span');
        b.className = 'ssh-badge';
        host.appendChild(b);
      }
      const done = listed.get(assetKey(a));
      b.textContent = done ? '✓ ' + done : text;
      b.classList.toggle('done', !!done);
      if (done && el.style) el.style.opacity = '0.35';
    }
  }

  function setBadge(hash, text) {
    if (badges.get(hash) === text) return;
    badges.set(hash, text);
    paintBadges(hash);
  }

  function mountBox(el) {
    const left = document.querySelector('.inventory_page_left');
    const grid = document.getElementById('inventories');
    const panel = document.getElementById('iteminfo0');
    if (left) left.insertBefore(el, left.firstChild);
    else if (grid && grid.parentElement) grid.parentElement.insertBefore(el, grid);
    else if (panel && panel.parentElement) panel.parentElement.insertBefore(el, panel);
    else document.body.appendChild(el);
  }

  // Where the panel sits. With room in the page margin left of the grid it is
  // pinned there, so the grid and Steam's own item panel stay where they were;
  // otherwise it goes above the grid.
  const DOCK_MIN = 400, DOCK_MAX = 540;
  function placeBox() {
    if (!box) return;
    const col = document.querySelector('.inventory_page_left') || document.getElementById('inventories');
    const r = col ? col.getBoundingClientRect() : null;
    const room = r ? r.left - 24 : 0;
    if (on('dock') && room >= DOCK_MIN) {
      if (box.parentElement !== document.body) document.body.appendChild(box);
      box.classList.add('dock');
      const w = Math.min(DOCK_MAX, room), top = Math.max(8, r.top);
      box.style.width = w + 'px';
      box.style.left = (r.left - 12 - w) + 'px';
      box.style.top = top + 'px';
      box.style.maxHeight = `calc(100vh - ${top + 8}px)`;
    } else if (box.classList.contains('dock') || !box.parentElement) {
      box.classList.remove('dock');
      box.style.width = box.style.left = box.style.top = box.style.maxHeight = '';
      mountBox(box);
    }
  }

  let placing = 0;
  function queuePlace() {
    if (placing) return;
    placing = requestAnimationFrame(() => { placing = 0; placeBox(); });
  }

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'ssh-box' + (pref('ssh.open', '1') === '1' ? ' open' : '');
    box.style.display = 'none';
    box.innerHTML =
      '<div class="ssh-strip"><canvas class="ssh-spark"></canvas><span class="ssh-s-name"></span><span class="ssh-s-note"></span>' +
      '<a class="ssh-list ssh-s-list ssh-d"></a><a class="ssh-toggle" title="Expand">▾</a></div>' +
      '<div class="ssh-full">' +
      '<div class="ssh-head"><span class="ssh-name"></span><span class="ssh-range"></span>' +
      '<a class="ssh-gear" title="Pricing rules">Rules</a><a class="ssh-toggle" title="Collapse">▴</a></div>' +
      '<div class="ssh-rules"></div>' +
      '<div class="ssh-hero ssh-d">' +
      '<div class="ssh-ask"><div class="ssh-lbl">ASK · BUYER PAYS</div><div class="ssh-askrow"><span class="ssh-pre"></span>' +
      '<input class="ssh-price" type="number" step="0.01" min="0.03" aria-label="Asking price"><span class="ssh-suf"></span></div>' +
      '<div class="ssh-gems" style="display:none" title="What Steam gives if you turn this item into gems">' +
      '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M5 .8 9.2 4 5 9.2 .8 4Z" fill="rgba(185,163,227,.25)" ' +
      'stroke="#b9a3e3" stroke-linejoin="round"/><path d="M.8 4H9.2" stroke="#b9a3e3" stroke-width=".8"/></svg><span></span></div></div>' +
      '<div class="ssh-why"><div class="ssh-why-t"></div><div class="ssh-why-d"></div><div class="ssh-why-o"></div>' +
      '<div class="ssh-why-w ssh-warn"></div></div>' +
      '<div class="ssh-do"><a class="ssh-list ssh-f-list"><b></b><i></i></a><a class="ssh-all"></a></div></div>' +
      '<div class="ssh-tip">&nbsp;</div>' +
      '<canvas class="ssh-canvas ssh-d"></canvas>' +
      '<div class="ssh-railhead ssh-d"><span>Sales by price, 30 days. Click a bar to ask that price.</span><span class="ssh-share"></span></div>' +
      '<canvas class="ssh-hist ssh-d"></canvas>' +
      '<div class="ssh-chips ssh-d"></div>' +
      '<div class="ssh-stats"><span class="ssh-st"></span><span class="ssh-tally"></span>' +
      '<a class="ssh-market" target="_blank" rel="noopener">Market ↗</a></div></div>';

    for (const t of box.querySelectorAll('.ssh-toggle')) {
      t.addEventListener('click', e => {
        e.preventDefault();
        const open = !box.classList.contains('open');
        box.classList.toggle('open', open);
        setPref('ssh.open', open ? '1' : '0');
        render();
      });
    }
    box.querySelector('.ssh-gear').addEventListener('click', e => { e.preventDefault(); box.classList.toggle('rules'); });
    buildRules(box.querySelector('.ssh-rules'));
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
      if (isFinite(v)) setAsk(v);
      else input.value = (S.ask / 100).toFixed(2);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    for (const b of box.querySelectorAll('.ssh-list')) b.addEventListener('click', e => { e.preventDefault(); listItems(1); });
    box.querySelector('.ssh-all').addEventListener('click', e => { e.preventDefault(); listItems(S.left); });

    const canvas = box.querySelector('.ssh-canvas');
    canvas.addEventListener('mousemove', onChartMove);
    canvas.addEventListener('mouseleave', onChartLeave);
    canvas.addEventListener('mousedown', onChartDown);
    canvas.addEventListener('click', onChartClick);
    const hist = box.querySelector('.ssh-hist');
    hist.addEventListener('mousemove', onRailMove);
    hist.addEventListener('mouseleave', () => setTip(''));
    hist.addEventListener('click', onRailClick);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { if (canvas.clientWidth) redrawPrice(); }).observe(canvas);
    }
    placeBox();
    window.addEventListener('scroll', queuePlace, { passive: true });
    window.addEventListener('resize', queuePlace);
    return box;
  }

  function buildRules(wrap) {
    const seg = (title, key, options, note) => {
      const h = document.createElement('h5');
      h.textContent = title;
      const row = document.createElement('div');
      row.className = 'ssh-seg';
      for (const [value, label] of options) {
        const a = document.createElement('a');
        a.textContent = label;
        a.dataset.rule = key;
        a.dataset.value = value;
        a.addEventListener('click', e => { e.preventDefault(); setPref(RULES[key][0], value); rulesChanged(); });
        row.appendChild(a);
      }
      wrap.appendChild(h);
      wrap.appendChild(row);
      if (note) {
        const p = document.createElement('p');
        p.textContent = note;
        wrap.appendChild(p);
      }
    };
    seg('Price a card opens on', 'source', SOURCES);
    seg('Outliers set aside before taking the high', 'trim', TRIMS,
        'The held high is the highest price that at least this share of units sold at or above, with real volume on two or more separate days.');
    for (const [key, text] of CHECKS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.rule = key;
      input.addEventListener('change', () => { setPref(RULES[key][0], input.checked ? '1' : '0'); rulesChanged(); });
      const span = document.createElement('span');
      span.textContent = text;
      label.appendChild(input);
      label.appendChild(span);
      wrap.appendChild(label);
    }
    syncRules();
  }

  function syncRules() {
    if (!box) return;
    const source = rule('source'), trim = String(trimValue());
    for (const a of box.querySelectorAll('.ssh-seg a')) {
      const want = a.dataset.rule === 'trim' ? trim : SOURCES.some(x => x[0] === source) ? source : 'held30';
      a.classList.toggle('active', String(parseFloat(a.dataset.value) || a.dataset.value) === want);
    }
    for (const i of box.querySelectorAll('.ssh-rules input')) i.checked = on(i.dataset.rule);
  }

  function rulesChanged() {
    syncRules();
    placeBox();
    if (!S.data || !S.points.length) return;
    analyse();
    if (!S.manual || S.why === 'saved') applyDefault();
    render();
  }

  function setTip(text) {
    const tip = box && box.querySelector('.ssh-tip');
    if (tip) { if (text) tip.textContent = text; else tip.innerHTML = '&nbsp;'; }
  }

  function showMessage(text) {
    box.classList.add('nodata');
    setTip(text);
    box.querySelector('.ssh-st').textContent = '';
    const note = box.querySelector('.ssh-s-note');
    note.textContent = text;
    note.className = 'ssh-s-note';
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
        S.key = null; S.item = null; S.panel = null; S.data = null; S.points = []; S.p30 = []; S.view = [];
      }
      return;
    }
    if (!isCurrent(item)) return;
    box.style.display = '';
    placeBox();
    const key = item.appid + '/' + item.hash;
    if (S.key === key) {
      S.panel = panel;
      const left = copiesOf(item).length;
      if (left !== S.left) { S.left = left; drawButtons(); }
      refreshGems();
      refreshLowest();
      return;
    }
    S.key = key;
    S.item = item;
    S.panel = panel;
    S.data = null;
    S.points = [];
    S.p30 = [];
    S.view = [];
    S.hover = -1;
    S.drag = false;
    S.manual = false;
    S.left = copiesOf(item).length;
    S.lowest = panelLowest(panel);
    S.gems = panelGems(panel);
    drawGems();
    setName(item.name);
    box.querySelector('.ssh-market').href = item.url;
    if (S.controller) S.controller.abort();
    S.controller = new AbortController();
    showMessage('Loading sale history…');
    try {
      const data = await fetchHistory(item.appid, item.hash, S.controller.signal);
      if (S.key !== key) return;
      S.data = data;
      S.points = toPoints(data.prices);
      analyse();
      applyDefault();
      render();
    } catch (e) {
      if (e.name === 'AbortError' || S.key !== key) return;
      showMessage(e.message);
    }
  }

  // The 30-day figures every price decision rests on.
  function analyse() {
    const now = Date.now();
    const trim = trimValue();
    S.cut = now - 30 * DAY;
    S.p30 = inRange(S.points, 30, now);
    S.held30 = heldHigh(S.p30, trim);
    S.held7 = heldHigh(inRange(S.points, 7, now), trim);
    S.heldRecent = heldHigh(inRange(S.points, STALE_DAYS, now), trim);
    S.med30 = median(S.p30.map(p => p.p));
    S.raw30 = S.p30.length ? Math.max(...S.p30.map(p => p.p)) : null;
  }

  function applyDefault() {
    const saved = on('remember') ? parseInt(pref('ssh.ask:' + S.key, ''), 10) : NaN;
    if (isFinite(saved) && saved >= MIN_ASK) {
      S.ask = saved; S.manual = true; S.why = 'saved';
      return;
    }
    const d = pickAsk({ source: rule('source'), held30: S.held30, held7: S.held7, lowest: S.lowest, median: S.med30,
                        last: S.points.length ? S.points[S.points.length - 1].p : null, undercut: on('undercut') });
    S.ask = d.cents;
    S.why = d.why;
    S.manual = false;
  }

  function resetAsk() {
    dropPref('ssh.ask:' + S.key);
    S.manual = false;
    applyDefault();
    redrawPrice();
  }

  function drawGems() {
    const el = box && box.querySelector('.ssh-gems');
    if (!el) return;
    el.style.display = S.gems ? '' : 'none';
    el.lastChild.textContent = S.gems ? `${S.gems} ${S.gems === 1 ? 'gem' : 'gems'}` : '';
  }

  // Steam fills the gem value in a moment after the panel opens, like "Starting at".
  function refreshGems() {
    const v = panelGems(S.panel);
    if (v === S.gems) return;
    S.gems = v;
    drawGems();
  }

  // Steam fills "Starting at" a moment after the panel opens; pick it up when it lands.
  function refreshLowest() {
    const v = panelLowest(S.panel);
    if (v === S.lowest) return;
    S.lowest = v;
    if (!S.data || !S.points.length) return;
    if (!S.manual) applyDefault();
    renderChips();
    redrawPrice();
  }

  function render() {
    if (!S.data || !box) return;
    const now = Date.now();
    const days = getRange();
    for (const a of box.querySelectorAll('.ssh-range a')) a.classList.toggle('active', +a.dataset.days === days);

    if (!S.points.length) { showMessage('No sales recorded.'); return; }
    box.classList.remove('nodata');
    box.querySelector('.ssh-pre').textContent = (S.data.prefix || '').trim();
    box.querySelector('.ssh-suf').textContent = (S.data.suffix || '').trim();

    const s30 = periodStats(S.points, 30, now);
    drawSpark(box.querySelector('.ssh-spark'), s30.view.length >= 2 ? s30.view : S.points);

    const s = periodStats(S.points, days, now);
    S.view = s.view;
    S.hover = -1;
    const label = days ? `${days}d` : 'all time';
    const stats = box.querySelector('.ssh-st');
    const canvas = box.querySelector('.ssh-canvas');
    if (!s.view.length) {
      canvas.style.display = 'none';
      setTip(`No sales in the last ${label}.`);
      stats.textContent = '';
    } else {
      canvas.style.display = '';
      setTip('');
      const trend = s.trend == null ? '' :
        ` · <span class="${s.trend >= 0 ? 'ssh-up' : 'ssh-down'}">${fmtTrend(s.trend)}</span> on the ${label} before`;
      stats.innerHTML =
        `Sold <b>${s.sold}</b> in ${label} · <b>${fmtRate(s.perDay)} / day</b>${trend} · low <b>${m$(s.low)}</b>`;
    }
    renderChips();
    redrawPrice();
  }

  function renderChips() {
    const wrap = box && box.querySelector('.ssh-chips');
    if (!wrap || !S.data) return;
    wrap.textContent = '';
    const defs = [['Cheapest listing', S.lowest], ['30d median', S.med30], ['7d high', S.held7], ['Held high', S.held30],
                  ['Raw high', S.raw30]];
    S.chipCents = [];
    defs.forEach(([label, val], n) => {
      const a = document.createElement('a');
      a.className = 'ssh-chip';
      const i = document.createElement('i');
      a.textContent = label;
      i.textContent = val == null ? '—' : m$(Math.max(MIN_ASK, Math.round(val * 100)) / 100);
      a.appendChild(i);
      if (val != null) {
        const cents = Math.max(MIN_ASK, Math.round(val * 100));
        a.dataset.cents = String(cents);
        a.dataset.label = label;
        a.title = `Key ${n + 1}`;
        a.addEventListener('click', e => { e.preventDefault(); setAsk(cents); });
        S.chipCents.push(cents);
      } else {
        a.classList.add('empty');
        S.chipCents.push(null);
      }
      wrap.appendChild(a);
    });
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

  // A price the user chose: chip, bar, chart, drag or typed.
  function setAsk(cents) {
    S.ask = Math.max(MIN_ASK, Math.round(cents));
    S.manual = true;
    S.why = 'manual';
    if (on('remember') && S.key) setPref('ssh.ask:' + S.key, S.ask);
    redrawPrice();
  }

  // Why the ask is what it is, and what the history says about it.
  function reason() {
    const now = Date.now();
    const ask = S.ask / 100;
    const ev = soldAtOrAbove(S.p30, ask);
    let title = WHY[S.why] || 'Custom price';
    if (S.why === 'manual') {
      const chip = box.querySelector(`.ssh-chip[data-cents="${S.ask}"]`);
      if (chip) title = chip.dataset.label;
    }
    let detail = ev.units
      ? `Sold at or above on ${ev.days} ${ev.days === 1 ? 'day' : 'days'} · ${ev.units} ${ev.units === 1 ? 'unit' : 'units'}` +
        ` · last ${fmtAgo(ev.last, now)}`
      : 'Nothing sold this high in 30 days.';
    if (S.why === 'undercut') detail = `Cheapest listing is ${m$(S.lowest)}, above the held high of ${m$(S.held30)}.`;
    let outliers = '';
    if (S.why === 'held30' && S.held30 != null) {
      const above = soldAtOrAbove(S.p30, S.held30 + 0.0001).units;
      if (above) outliers = `${above} higher ${above === 1 ? 'sale' : 'sales'} set aside as outliers, up to ${m$(S.raw30)}`;
    }
    // Stale: the same held-high test, run on the recent days alone, no longer reaches the ask.
    // (The date of the last sale would not do: one late spike would hide a price that has gone.)
    let warn = '', short = '';
    if (on('stale') && S.why === 'held30' && (S.heldRecent == null || Math.round(S.heldRecent * 100) < S.ask)) {
      short = `not held in ${STALE_DAYS} days`;
      warn = `Nothing has held this high in the last ${STALE_DAYS} days.` + (S.held7 != null ? ` The 7-day high is ${m$(S.held7)}.` : '');
    }
    return { title, detail, outliers, warn, short, share: ev.total ? ev.units / ev.total : null };
  }

  function drawButtons() {
    if (!S.data || !box || listing) return;
    const full = box.querySelector('.ssh-f-list'), strip = box.querySelector('.ssh-s-list'), all = box.querySelector('.ssh-all');
    const recv = receivedForBuyerPays(S.ask, feesFor());
    const n = listedByItem.get(S.key) || 0;
    const done = S.left === 0 && n > 0;
    for (const b of [full, strip]) { b.classList.remove('busy'); b.classList.toggle('done', done); }
    all.classList.remove('busy');
    if (done) {
      full.firstChild.textContent = n > 1 ? `Listed ${n}` : 'Listed';
      full.lastChild.textContent = 'Confirm in the mobile app';
      strip.textContent = 'Listed';
    } else {
      full.firstChild.textContent = `List at ${m$(S.ask / 100)}`;
      full.lastChild.textContent = `you get ${m$(recv / 100)}` + (n ? ` · ${n} listed` : on('keys') ? ' · Enter' : '');
      strip.textContent = `List at ${m$(S.ask / 100)}`;
    }
    all.style.display = S.left > 1 ? '' : 'none';
    all.textContent = `List all ${S.left} · you get ${m$(recv * S.left / 100)}`;
    const t = box.querySelector('.ssh-tally');
    t.textContent = tally.n ? `${tally.n} listed this session · ${m$(tally.cents / 100)}` : '';
  }

  // Everything that depends on the asking price: input, reason, chips, buttons, tile badge, both canvases.
  function redrawPrice() {
    if (!S.data || !box || !S.points.length) return;
    drawButtons();
    const r = reason();
    const note = box.querySelector('.ssh-s-note');
    note.textContent = r.short || r.title;
    note.className = 'ssh-s-note' + (r.short ? ' ssh-warn' : '');
    if (S.item) setBadge(S.item.hash, m$(S.ask / 100));
    if (!box.classList.contains('open')) return;
    const input = box.querySelector('.ssh-price');
    if (document.activeElement !== input) input.value = (S.ask / 100).toFixed(2);
    const t = box.querySelector('.ssh-why-t');
    t.textContent = r.title;
    if (S.manual) {
      const a = document.createElement('a');
      a.textContent = 'reset';
      a.addEventListener('click', e => { e.preventDefault(); resetAsk(); });
      t.appendChild(a);
    }
    box.querySelector('.ssh-why-d').textContent = r.detail;
    box.querySelector('.ssh-why-o').textContent = r.outliers;
    box.querySelector('.ssh-why-w').textContent = r.warn;
    box.querySelector('.ssh-share').textContent = r.share == null ? '' : `${Math.round(r.share * 100)}% sold at or above your ask`;
    markChips();
    if (S.view.length) drawChart(S.hover);
    drawHist();
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

  // A sale in the last 30 days above the held high: drawn as a hollow dot and
  // kept out of the chart's scale, so one spike cannot flatten the line.
  function isOutlier(p) {
    return S.held30 != null && p.t >= S.cut && p.p > S.held30 + 1e-9;
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
    const ins = pts.filter(p => !isOutlier(p));
    let pmax = S.ask / 100, vmax = 0;
    if (S.lowest != null && S.lowest > pmax) pmax = S.lowest;
    for (const p of ins) if (p.p > pmax) pmax = p.p;
    for (const p of pts) if (p.v > vmax) vmax = p.v;
    pmax = pmax * 1.15 || 1;
    vmax = vmax || 1;
    const X = t => L + (t - t0) / span * pw;
    const Y = p => Math.max(T + 3, T + ph - (p / pmax) * ph);
    S.scale = { L, R, T, ph, pw, pmax, t0, span };

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = GREY;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const v = pmax * i / 3, y = Math.round(T + ph - (v / pmax) * ph) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillText(m$(v), L - 4, y);
    }

    const bw = Math.max(1, Math.min(6, pw / Math.max(1, pts.length)));
    ctx.fillStyle = 'rgba(143,152,160,0.25)';
    for (const p of pts) {
      const h = p.v / vmax * ph * 0.3;
      ctx.fillRect(X(p.t) - bw / 2, T + ph - h, bw, h);
    }

    if (ins.length >= 2) {
      const a = ins[0], z = ins[ins.length - 1];
      ctx.beginPath();
      ctx.moveTo(X(a.t), Y(a.p));
      for (const p of ins) ctx.lineTo(X(p.t), Y(p.p));
      ctx.lineTo(X(z.t), T + ph);
      ctx.lineTo(X(a.t), T + ph);
      ctx.closePath();
      ctx.fillStyle = 'rgba(102,192,244,0.12)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X(a.t), Y(a.p));
      for (const p of ins) ctx.lineTo(X(p.t), Y(p.p));
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    } else if (ins.length) {
      ctx.beginPath(); ctx.arc(X(ins[0].t), Y(ins[0].p), 3, 0, Math.PI * 2);
      ctx.fillStyle = BLUE; ctx.fill();
    }

    ctx.strokeStyle = GREY;
    ctx.fillStyle = '#16202d';
    for (const p of pts) {
      if (!isOutlier(p)) continue;
      ctx.beginPath(); ctx.arc(X(p.t), Y(p.p), 2.5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
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
      ctx.fillText('cheapest listing', L + 3, y + 8);
    }

    const ya = Math.round(Y(S.ask / 100)) + 0.5;
    ctx.strokeStyle = AMBER;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(L, ya); ctx.lineTo(W - R, ya); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'right';
    ctx.fillText('ask ' + m$(S.ask / 100), W - R - 2, ya - 7);
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

  // Sales by price over the last 30 days, one clickable bar per price band.
  // Bands above the held high are grey; everything above the ask and the held
  // high is gathered into one last "higher" bar.
  function drawHist() {
    const canvas = box.querySelector('.ssh-hist');
    const c = setupCanvas(canvas, HIST_H);
    S.rail = null;
    if (!c) return;
    const { ctx, W, H } = c;
    const pts = S.p30;
    if (!pts.length) {
      ctx.fillStyle = GREY;
      ctx.textAlign = 'left';
      ctx.fillText('No sales in the last 30 days.', 0, H / 2);
      return;
    }
    const T = 2, ph = 50, base = T + ph;
    const ask = S.ask / 100;
    const hi = Math.max(S.held30 == null ? 0 : S.held30, ask);
    const inl = pts.filter(p => p.p <= hi + 1e-9);
    let higher = 0;
    for (const p of pts) if (p.p > hi + 1e-9) higher += p.v;
    const bins = priceBins(inl.concat([{ p: hi, v: 0 }, { p: ask, v: 0 }]), 14);
    const slots = bins.length + (higher ? 1 : 0);
    const slot = W / slots;
    const bw = Math.max(2, slot - 3);
    let vmax = 0;
    for (const b of bins) if (b.v > vmax) vmax = b.v;
    vmax = vmax || 1;
    let askIdx = bins.findIndex(b => ask >= b.from - 1e-9 && ask < b.to - 1e-9);
    if (askIdx < 0) askIdx = bins.length - 1;
    const cells = [];
    bins.forEach((b, i) => {
      const h = b.v ? 4 + b.v / vmax * (ph - 4) : 1.5;
      const x = i * slot + (slot - bw) / 2;
      const trimmed = S.held30 != null && b.from > S.held30 + 1e-9;
      ctx.fillStyle = trimmed ? SLATE : b.to > ask + 1e-9 ? BLUE : 'rgba(102,192,244,0.35)';
      ctx.fillRect(x, base - h, bw, h);
      if (i === askIdx) {
        ctx.strokeStyle = AMBER;
        ctx.strokeRect(x - 0.5, base - h - 0.5, bw + 1, h + 1);
      }
      const cents = Math.max(MIN_ASK, Math.round(b.from * 100));
      const wide = b.to - b.from > 0.011;
      cells.push({ cents, tip: `${m$(b.from)}${wide ? ' to ' + m$(b.to) : ''} · ${b.v} sold · click to ask ${m$(cents / 100)}` });
    });
    if (higher) {
      const x = bins.length * slot + (slot - bw) / 2;
      ctx.fillStyle = SLATE;
      ctx.fillRect(x, base - 8, bw, 8);
      const cents = Math.max(MIN_ASK, Math.round(S.raw30 * 100));
      cells.push({ cents, tip: `${higher} higher ${higher === 1 ? 'sale' : 'sales'}, up to ${m$(S.raw30)} · click to ask ${m$(cents / 100)}` });
    }
    ctx.strokeStyle = '#2a3f5a';
    ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(W, base + 0.5); ctx.stroke();
    const cx = (askIdx + 0.5) * slot;
    ctx.fillStyle = AMBER;
    ctx.beginPath(); ctx.moveTo(cx, base + 3); ctx.lineTo(cx + 5, base + 10); ctx.lineTo(cx - 5, base + 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = GREY;
    ctx.textAlign = 'left';
    ctx.fillText(m$(bins[0].from), 0, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText(higher ? 'higher sales' : m$(bins[bins.length - 1].from), W, H - 6);
    S.rail = { slot, cells };
  }

  function railCell(e) {
    if (!S.rail) return null;
    const i = Math.floor(e.offsetX / S.rail.slot);
    return S.rail.cells[Math.min(Math.max(i, 0), S.rail.cells.length - 1)] || null;
  }

  function onRailMove(e) {
    const cell = railCell(e);
    setTip(cell ? cell.tip : '');
  }

  function onRailClick(e) {
    const cell = railCell(e);
    if (!cell) return;
    setAsk(cell.cents);
    setTip(askTip());
  }

  function drawSpark(canvas, pts) {
    const c = setupCanvas(canvas, canvas.clientHeight || 28);
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
    const recv = receivedForBuyerPays(S.ask, feesFor());
    const share = shareAtOrAbove(S.p30, S.ask / 100);
    const sh = share == null ? '' : ` · ${Math.round(share * 100)}% of 30-day sales at or above`;
    return `Asking ${m$(S.ask / 100)} · you get ${m$(recv / 100)}${sh}`;
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
    setTip(`${pointLabel(p, Date.now())} · ${m$(p.p)} · ${p.v} sold${isOutlier(p) ? ' · outlier' : ''} · click to ask this`);
  }

  // A click on the chart asks the price of the point under the cursor.
  function onChartClick(e) {
    if (S.suppressClick) { S.suppressClick = false; return; }
    if (!S.scale || !S.view.length) return;
    if (Math.abs(e.offsetY - askLineY()) <= 6) return;
    const cents = S.hover >= 0 && S.hover < S.view.length
      ? Math.round(S.view[S.hover].p * 100)
      : priceAtY(e.offsetY);
    setAsk(cents);
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
      setAsk(priceAtY(Math.min(Math.max(y, S.scale.T), S.scale.T + S.scale.ph)));
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

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // One listing, the way Steam's own sell dialog posts it. `recv` is what the seller receives, in cents.
  async function postListing(sid, asset, recv) {
    const body = new URLSearchParams({
      sessionid: sid, appid: String(asset.appid), contextid: String(asset.contextid),
      assetid: String(asset.assetid || asset.id), amount: '1', price: String(recv),
    });
    const res = await fetch(`${location.origin}/market/sellitem/`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || !data || !data.success) throw new Error((data && data.message) || `Steam answered ${res.status}.`);
    return data;
  }

  // List `count` copies of the selected item at the asking price, one request at a time.
  async function listItems(count) {
    if (!S.data || !S.points.length || listing || !box || box.classList.contains('nodata')) return;
    const it = globalSelected();
    const d = it && it.description;
    if (!d) { setTip('Select the item first.'); return; }
    if (d.market_hash_name !== S.item.hash) { setTip('The panel and the selected item differ. Click the item again.'); return; }
    if (!d.marketable) { setTip('This item cannot be listed on the market.'); return; }
    const queue = copiesOf(S.item).slice(0, Math.max(1, count));
    if (!queue.length) { setTip('Already listed.'); return; }
    const sid = sessionId();
    if (!sid) { setTip('No Steam session found. Reload the page.'); return; }
    const key = S.key, hash = S.item.hash, name = S.item.name, ask = S.ask;
    const recv = receivedForBuyerPays(ask, feesFor());
    const price = m$(ask / 100);
    const full = box.querySelector('.ssh-f-list'), strip = box.querySelector('.ssh-s-list'), all = box.querySelector('.ssh-all');
    listing = true;
    for (const b of [full, strip, all]) b.classList.add('busy');
    let done = 0, error = null, confirm = '';
    for (const asset of queue) {
      const label = queue.length > 1 ? `Listing ${done + 1} of ${queue.length}…` : 'Listing…';
      full.firstChild.textContent = label;
      strip.textContent = label;
      try {
        const data = await postListing(sid, asset, recv);
        if (data.needs_mobile_confirmation) confirm = ' Confirm in the Steam mobile app.';
        else if (data.needs_email_confirmation) confirm = ' Confirm by email.';
        listed.set(assetKey(asset), price);
        listedByItem.set(key, (listedByItem.get(key) || 0) + 1);
        tally.n++;
        tally.cents += recv;
        done++;
        paintBadges(hash);
      } catch (e) { error = e; break; }
      if (done < queue.length) await sleep(LIST_GAP);
    }
    listing = false;
    if (S.key === key) S.left = copiesOf(S.item).length;
    if (S.data) { drawButtons(); }
    const what = done > 1 ? `${done} × ${name}` : name;
    if (error) setTip((done ? `Listed ${what} at ${price}, then stopped: ` : '') + error.message);
    else setTip(`Listed ${what} at ${price}.${confirm}`);
    if (!error && on('advance') && S.key === key && S.left === 0) {
      setTimeout(() => { if (S.key === key) step(1); }, 600);
    }
  }

  // Tiles the grid is showing right now, in reading order.
  function visibleTiles() {
    const inv = window.g_ActiveInventory;
    const root = (inv && inv.m_$Inventory && inv.m_$Inventory[0]) || document.getElementById('inventories');
    if (!root) return [];
    return Array.from(root.querySelectorAll('.itemHolder > .item')).filter(el => el.rgItem && el.offsetParent !== null);
  }

  // Select the next (dir 1) or previous (dir -1) marketable, unlisted tile on the visible page.
  function step(dir) {
    const tiles = visibleTiles();
    if (!tiles.length) return false;
    const sel = globalSelected();
    let i = sel ? tiles.indexOf(sel.element) : -1;
    if (i < 0) i = dir > 0 ? -1 : tiles.length;
    for (i += dir; i >= 0 && i < tiles.length; i += dir) {
      const el = tiles[i], rg = el.rgItem, d = rg.description;
      if (!d || !d.marketable || listed.has(assetKey(rg))) continue;
      const link = el.querySelector('a.inventory_item_link');
      if (link) link.click();
      else if (window.g_ActiveInventory && window.g_ActiveInventory.SelectItem) window.g_ActiveInventory.SelectItem(null, el, rg, false);
      else return false;
      return true;
    }
    return false;
  }

  function onKey(e) {
    if (!on('keys') || !box || e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.defaultPrevented) return;
    const t = e.target;
    if (t && t.closest) {
      if (t.closest('input, textarea, select, button, [contenteditable]')) return;
      const link = t.closest('a');
      if (link && !link.classList.contains('inventory_item_link')) return;
    }
    if (document.querySelector('.newmodal')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (globalSelected() && step(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
      return;
    }
    if (box.style.display === 'none' || !S.data || !S.points.length) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      listItems(1);
    } else if (/^[1-5]$/.test(e.key)) {
      const cents = S.chipCents[+e.key - 1];
      if (cents != null) { e.preventDefault(); setAsk(cents); }
    }
  }

  // Sparkline tooltip when the mouse rests on a tile in the grid.
  function lookupAsset(tile) {
    if (tile.rgItem) return tile.rgItem;
    const m = /^(\d+)_(\d+)_(\d+)$/.exec(tile.id || '');
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
    const points = toPoints(data.prices);
    const now = Date.now();
    const s = periodStats(points, 30, now);
    const held = heldHigh(s.view, trimValue());
    // The selected item's badge follows its asking price; every other tile shows its held high.
    if (held != null && !(S.item && S.item.hash === d.market_hash_name)) {
      setBadge(d.market_hash_name, money(data.prefix, data.suffix, Math.max(MIN_ASK, Math.round(held * 100)) / 100));
    }
    if (!tile.matches(':hover')) return;
    tipEl.textContent = '';
    const spark = document.createElement('canvas');
    const name = document.createElement('b');
    name.textContent = d.name || d.market_hash_name;
    tipEl.appendChild(spark);
    tipEl.appendChild(name);
    if (s.median != null) {
      if (held != null) {
        const hh = document.createElement('em');
        hh.textContent = `${money(data.prefix, data.suffix, held)} held high`;
        tipEl.appendChild(hh);
      }
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
    document.addEventListener('keydown', onKey);
  }

  init();
})();
