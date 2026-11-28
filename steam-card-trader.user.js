// ==UserScript==
// @name         Steam Card Trader
// @namespace    joey.steam-tools
// @version      1.1.1
// @description  Buy side and sell side for trading cards. On the market: a scanner that ranks cards worth a buy order after fees, and a helper on each card's page that sets the price in Steam's buy dialog. In the inventory: Sale History's panel, with the lowest price that still profits on what you paid, and a scan that prices every card you hold. On the Booster Pack Creator: which of your games makes a pack worth more than its gems.
// @author       Joey
// @homepageURL  https://github.com/Joyariyb/steam-sale-history
// @supportURL   https://github.com/Joyariyb/steam-sale-history/issues
// @downloadURL  https://raw.githubusercontent.com/Joyariyb/steam-sale-history/main/steam-card-trader.user.js
// @updateURL    https://raw.githubusercontent.com/Joyariyb/steam-sale-history/main/steam-card-trader.user.js
// @match        https://steamcommunity.com/id/*/inventory*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @match        https://steamcommunity.com/market*
// @match        https://steamcommunity.com/tradingcards/boostercreator*
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

  // ---- buy side ----
  const RECENT_DAYS = 10;
  // Steam holds a card bought on the market for a week before it can be listed again.
  const HOLD_DAYS = 7;
  const CARD_FEES = { pct: 0.05, min: 1, base: 0, pub: 0.10 };
  // The least a sale must clear over what was paid to count as making money: one cent.
  const FLOOR_PROFIT = 1;

  // How Steam writes a currency, by its currency number: [prefix, suffix, ISO code].
  const CURRENCIES = {
    1: ['$', '', 'USD'], 2: ['£', '', 'GBP'], 3: ['', '€', 'EUR'], 4: ['CHF ', '', 'CHF'], 5: ['', ' pуб.', 'RUB'],
    6: ['', 'zł', 'PLN'], 7: ['R$ ', '', 'BRL'], 8: ['¥ ', '', 'JPY'], 9: ['', ' kr', 'NOK'], 10: ['Rp ', '', 'IDR'],
    11: ['RM', '', 'MYR'], 12: ['₱', '', 'PHP'], 13: ['S$', '', 'SGD'], 14: ['฿', '', 'THB'], 15: ['', '₫', 'VND'],
    16: ['₩ ', '', 'KRW'], 17: ['', ' TL', 'TRY'], 18: ['', '₴', 'UAH'], 19: ['Mex$ ', '', 'MXN'], 20: ['CDN$ ', '', 'CAD'],
    21: ['A$ ', '', 'AUD'], 22: ['NZ$ ', '', 'NZD'], 23: ['¥ ', '', 'CNY'], 24: ['₹ ', '', 'INR'], 25: ['CLP$ ', '', 'CLP'],
    26: ['S/.', '', 'PEN'], 27: ['COL$ ', '', 'COP'], 28: ['R ', '', 'ZAR'], 29: ['HK$ ', '', 'HKD'], 30: ['NT$ ', '', 'TWD'],
    31: ['', ' SR', 'SAR'], 32: ['', ' AED', 'AED'], 34: ['ARS$ ', '', 'ARS'], 35: ['₪', '', 'ILS'], 37: ['', '₸', 'KZT'],
    38: ['', ' KD', 'KWD'], 39: ['', ' QR', 'QAR'], 40: ['₡', '', 'CRC'], 41: ['$U', '', 'UYU'],
  };

  function currencyOf(code) {
    return CURRENCIES[code] || ['', ' (currency ' + code + ')', 'currency ' + code];
  }

  // A price in cents, written the way Steam writes that currency.
  function centsText(code, cents) {
    const c = currencyOf(code);
    return money(c[0], c[1], cents / 100);
  }

  // The new market's history rows ({time in seconds, price_median, purchases}) -> points.
  function apiPoints(prices) {
    const out = [];
    for (const row of prices || []) {
      const t = Number(row && row.time) * 1000;
      const p = Number(row && row.price_median);
      const v = parseInt(row && row.purchases, 10) || 0;
      if (isFinite(t) && t > 0 && isFinite(p)) out.push({ t, p, v });
    }
    return out;
  }

  function popcount(n) {
    let c = 0;
    for (n >>>= 0; n; n &= n - 1) c++;
    return c;
  }

  // Sales by price over the last 30 days, cheapest first: [{c, v, r, m}]. c is a price in
  // cents, v the units sold in hours whose median was c, r those of the last RECENT_DAYS,
  // m one bit per day back from now (bit 0 = the last 24 hours) on which any sold.
  function priceLevels(points, now) {
    const map = new Map();
    for (const p of points) {
      const age = Math.floor((now - p.t) / DAY);
      if (age < 0 || age >= 30 || p.v <= 0) continue;
      const c = Math.round(p.p * 100);
      let l = map.get(c);
      if (!l) map.set(c, l = { c, v: 0, r: 0, m: 0 });
      l.v += p.v;
      if (age < RECENT_DAYS) l.r += p.v;
      l.m |= 1 << age;
    }
    return Array.from(map.values()).sort((a, b) => a.c - b.c);
  }

  // Levels as one flat array of numbers, for storage, and back.
  function packLevels(levels) {
    const out = [];
    for (const l of levels) out.push(l.c, l.v, l.r, l.m);
    return out;
  }

  function unpackLevels(flat) {
    const out = [];
    for (let i = 0; flat && i + 3 < flat.length; i += 4) out.push({ c: flat[i], v: flat[i + 1], r: flat[i + 2], m: flat[i + 3] });
    return out;
  }

  function unitsOf(levels, key) {
    let n = 0;
    for (const l of levels) n += l[key];
    return n;
  }

  // Units sold at or above (dir 1) or at or below (dir -1) a price, and on how many separate days.
  function flow(levels, cents, dir) {
    let units = 0, mask = 0;
    for (const l of levels) {
      if (dir > 0 ? l.c >= cents : l.c <= cents) { units += l.v; mask |= l.m; }
    }
    return { units, days: popcount(mask) };
  }

  // The highest price that at least `share` of the units (never fewer than three) sold at
  // or above, on `minDays` or more separate days. key 'v' reads the 30 days, 'r' the last
  // RECENT_DAYS. null when too little sold to call any price held.
  function heldPrice(levels, share, minDays, key) {
    const total = unitsOf(levels, key);
    if (!total) return null;
    const need = Math.max(3, Math.ceil(total * share));
    const recent = (1 << RECENT_DAYS) - 1;
    let units = 0, mask = 0;
    for (let i = levels.length - 1; i >= 0; i--) {
      const l = levels[i];
      if (!l[key]) continue;
      units += l[key];
      mask |= key === 'r' ? l.m & recent : l.m;
      if (units >= need && popcount(mask) >= minDays) return l.c;
    }
    return null;
  }

  // The price half of the 30 days' units sold at or below.
  function medianLevel(levels) {
    const total = unitsOf(levels, 'v');
    if (!total) return null;
    let units = 0;
    for (const l of levels) {
      units += l.v;
      if (units * 2 >= total) return l.c;
    }
    return levels[levels.length - 1].c;
  }

  // Steam's compact order book [cents, quantity, cents, quantity, ...] -> [{c, q}], kept in
  // Steam's order: dearest first for buy orders, cheapest first for listings.
  function bookLevels(compact, limit) {
    const out = [];
    for (let i = 0; compact && i + 1 < compact.length && out.length < (limit || Infinity); i += 2) {
      const c = Number(compact[i]), q = Number(compact[i + 1]);
      if (isFinite(c) && isFinite(q) && q > 0) out.push({ c, q });
    }
    return out;
  }

  // The cheapest ask (what the buyer pays) that leaves the seller `cost + profit`.
  function askToClear(cost, profit, w) {
    return Math.max(MIN_ASK, amountToSend(cost + profit, w));
  }

  // The buy order worth placing on one card, or null when no price clears the fees.
  // card: {bids: [{c, q}] dearest first, asks: [{c, q}] cheapest first, levels: priceLevels()}.
  // opt: {minProfit, share, maxQty}. Every price is in cents of one currency.
  //   now:  a listing is already cheap enough, so buy it outright.
  //   top:  one cent over the best buy order still pays, and takes whoever sells into the orders next.
  //   wait: only a lower price pays, and Steam fills the oldest order first, so this one
  //         sits behind every order already at or above it.
  function planFlip(card, opt, w) {
    const { bids, asks, levels } = card;
    const total = unitsOf(levels, 'v');
    if (!total || !asks.length) return null;
    const s30 = heldPrice(levels, opt.share, 3, 'v');
    const s10 = heldPrice(levels, opt.share, 2, 'r');
    if (s30 == null || s10 == null) return null;
    // Sell where a real share of the month's sales went, unless the last ten days fell short of it.
    const sell = Math.min(s30, s10);
    const net = receivedForBuyerPays(sell, w);
    const maxPay = net - opt.minProfit;
    if (maxPay < MIN_ASK) return null;
    const top = bids.length ? bids[0].c : 0, low = asks[0].c;
    let kind, buy, ahead = 0, avail = 0;
    if (low <= maxPay) {
      kind = 'now'; buy = low; avail = asks[0].q;
    } else if (top + 1 <= maxPay) {
      kind = 'top'; buy = Math.max(MIN_ASK, top + 1);
    } else {
      kind = 'wait'; buy = maxPay;
      for (const b of bids) if (b.c >= buy) ahead += b.q;
    }
    const sellFlow = flow(levels, sell, 1).units / 30;
    let queue = 0;
    for (const a of asks) if (a.c <= sell) queue += a.q;
    const sellDays = sellFlow > 0 ? (queue + 1) / sellFlow : Infinity;
    let fillDays = 0;
    if (kind === 'top') {
      // Sales at or under the best buy order are people selling into the orders. With none
      // on record, assume a tenth of all sales do.
      const hit = flow(levels, top, -1).units / 30 || total / 300;
      fillDays = 1 / hit;
    } else if (kind === 'wait') {
      const hit = flow(levels, buy, -1).units / 30;
      fillDays = hit > 0 ? (ahead + 1) / hit : Infinity;
    }
    const cycle = fillDays + HOLD_DAYS + sellDays;
    const profit = net - buy;
    const room = kind === 'now' ? avail : Infinity;
    const qty = Math.max(1, Math.min(opt.maxQty, room, Math.round(sellFlow * 2) || 1));
    return {
      kind, buy, sell, net, profit, roi: profit / buy, maxPay, top, low, ahead, avail, fillDays, sellDays, cycle, qty,
      perMonth: isFinite(cycle) ? profit * 30 / cycle : 0, perDay: total / 30, sellFlow, median: medianLevel(levels),
    };
  }

  // "now", "2.5 d", "14 d", "90+ d", "never".
  function fmtDays(d) {
    if (!isFinite(d)) return 'never';
    if (d < 0.05) return 'now';
    if (d > 90) return '90+ d';
    return (d < 10 ? d.toFixed(1) : String(Math.round(d))) + ' d';
  }

  // "under a day", "about 1 day", "about 12 days", "over 90 days".
  function daysText(d) {
    if (d < 1) return 'under a day';
    if (d > 90) return 'over 90 days';
    const n = Math.round(d);
    return 'about ' + n + (n === 1 ? ' day' : ' days');
  }

  // "45 s", "12 min", "1 h 20 min".
  function fmtSpan(seconds) {
    if (seconds < 60) return Math.max(1, Math.round(seconds)) + ' s';
    const min = Math.round(seconds / 60);
    return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
  }

  // The text a price box already holds, with the amount swapped: "A$ 0.17" -> "A$ 0.13".
  // Keeps a decimal comma where the box uses one.
  function moneyLike(old, cents) {
    const m = /\d[\d.,\s]*\d|\d/.exec(old || '');
    const comma = !!m && /,\d{1,2}$/.test(m[0]);
    const text = (cents / 100).toFixed(2).replace('.', comma ? ',' : '.');
    return m ? old.slice(0, m.index) + text + old.slice(m.index + m[0].length) : text;
  }

  // ---- booster packs ----
  // Gems are bought and sold on the market in Sacks of Gems, 1000 gems a sack.
  const SACK_GEMS = 1000;
  const SACK_HASH = '753-Sack of Gems';

  // Steam writes a few characters of a game's name as HTML entities: "Tom &amp; Jerry".
  function unescapeHtml(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
    return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return named[e.toLowerCase()] || m;
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    });
  }

  // The games the Booster Pack Creator offers, from its catalog, given as a list or keyed by
  // appid. An entry is {appid, name, series, price: the pack's cost in gems, as text}, plus
  // unavailable and available_at_time once a pack was made in the last day.
  // -> [{appid, name, series, gems, cool, at}], one per game, in the catalog's order.
  function creatorGames(list) {
    const out = [], seen = new Set();
    for (const g of Array.isArray(list) ? list : Object.values(list || {})) {
      const appid = parseInt(g && g.appid, 10);
      const price = String(g && g.price != null ? g.price : '').trim();
      const gems = Math.round(parseFloat(/^\d{1,3}([,.\s]\d{3})+$/.test(price) ? price.replace(/\D/g, '') : price));
      if (!(appid > 0) || !(gems > 0) || seen.has(appid)) continue;
      seen.add(appid);
      out.push({
        appid, gems, series: parseInt(g.series, 10) || 1, name: unescapeHtml(g.name).trim() || `App ${appid}`,
        cool: !!g.unavailable, at: g.available_at_time ? unescapeHtml(g.available_at_time).trim() : '',
      });
    }
    return out;
  }

  // Where the JSON value that opens at text[i] ('[' or '{') closes, or -1. Brackets inside
  // strings do not count.
  function jsonEnd(text, i) {
    let depth = 0, str = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (str) {
        if (ch === '\\') i++;
        else if (ch === '"') str = false;
      } else if (ch === '"') str = true;
      else if (ch === '[' || ch === '{') depth++;
      else if ((ch === ']' || ch === '}') && --depth === 0) return i + 1;
    }
    return -1;
  }

  // The creator page's own script calls CBoosterCreatorPage.Init( catalog as JSON, gems,
  // tradable gems, untradable gems, ... ). Read from that script's text: {games, goo:
  // {total, tradable, untradable} or null}, or null when the call or its catalog is not there.
  function parseCreatorInit(text) {
    const s = String(text || ''), call = 'CBoosterCreatorPage.Init(';
    const at = s.indexOf(call);
    if (at < 0) return null;
    const open = s.indexOf('[', at + call.length);
    if (open < 0 || s.slice(at + call.length, open).trim()) return null;
    const end = jsonEnd(s, open);
    if (end < 0) return null;
    let list;
    try { list = JSON.parse(s.slice(open, end)); } catch (e) { return null; }
    // The three gem counts follow, as plain numbers or as parseFloat( "1234" ).
    const goo = [];
    let rest = s.slice(end);
    while (goo.length < 3) {
      const m = /^\s*,\s*([^,]*)/.exec(rest);
      const n = m && /\d+(\.\d+)?/.exec(m[1]);
      if (!n) break;
      goo.push(parseFloat(n[0]));
      rest = rest.slice(m[0].length);
    }
    return { games: creatorGames(list), goo: goo.length === 3 ? { total: goo[0], tradable: goo[1], untradable: goo[2] } : null };
  }

  // A pack's market name. It keeps the name a game had when its cards came out, so a renamed
  // game's pack is found by searching instead.
  function boosterHash(appid, name) {
    return `${appid}-${name} Booster Pack`;
  }

  // The best buy order and the cheapest listing in an order book, in cents, null where there is none.
  function bookTops(book) {
    const top = (amt, compact) => {
      const n = Number(amt);
      if (n > 0) return Math.round(n);
      const l = bookLevels(compact, 1)[0];
      return l ? l.c : null;
    };
    return {
      bid: top(book && book.amtMaxBuyOrder, book && book.rgCompactBuyOrders),
      ask: top(book && book.amtMinSellOrder, book && book.rgCompactSellOrders),
    };
  }

  // What one gem is worth, in cents: a Sack of Gems sold to its best buy order, less the fees.
  function gemCents(sackBid, w) {
    return sackBid > 0 ? receivedForBuyerPays(sackBid, w) / SACK_GEMS : null;
  }

  // What one pack nets once its gems are counted at what they would sell for, in cents.
  // now: sold to the best buy order. listed: listed one cent under the cheapest listing, once
  // someone buys it, but never above cap (what packs have sold for, when known) and never under
  // the best buy order. null where there is no such order or listing.
  function packNet(gems, bid, ask, perGem, w, cap) {
    const cost = gems * perGem;
    const keepNow = bid > 0 ? receivedForBuyerPays(bid, w) : null;
    const listAt = ask > 0 ? Math.max(MIN_ASK, Math.min(ask - 1, cap > 0 ? cap : Infinity), bid > 0 ? bid : 0) : null;
    const keepListed = listAt ? receivedForBuyerPays(listAt, w) : null;
    const net = keep => (keep == null ? null : Math.round(keep - cost) || 0);
    return { cost, keepNow, now: net(keepNow), listAt, keepListed, listed: net(keepListed) };
  }

  // 'pays' when selling to the best buy order beats the gems, 'listed' when only a listing
  // would, 'even' when the better of the two comes to nothing, 'loses' when both lose, else null.
  function packVerdict(net) {
    if (!net || (net.now == null && net.listed == null)) return null;
    if (net.now > 0) return 'pays';
    if (net.listed > 0) return 'listed';
    const best = Math.max(net.now == null ? -Infinity : net.now, net.listed == null ? -Infinity : net.listed);
    return best === 0 ? 'even' : 'loses';
  }

  // How far back one sale still shows that a pack sells on the market. Packs of little-known
  // games can go months between sales, so a week would leave out packs that do sell.
  const MARKET_DAYS = 365;

  // Whether a looked-up pack sells on the market. 'live' when someone has a buy order for it, or
  // some sold in the last year (sy). 'gone' when the market has no packs of the game at all.
  // 'empty' when nobody is selling or buying it and none sold in the last year. 'unsold' when it
  // is listed, but nobody has a buy order and none sold in the last year. 'unsure' when there are
  // no buy orders and the year's sales are not looked up yet. null when it is not looked up.
  function packMarket(r) {
    if (!r || r.err) return null;
    if (r.none) return 'gone';
    if (r.b > 0) return 'live';
    if (r.sy == null) return 'unsure';
    if (r.sy > 0) return 'live';
    return r.a > 0 ? 'unsold' : 'empty';
  }

  // What packs have been selling for, in cents: the median of the last week's sales, or of the
  // year's when none sold this week. null when the sales are not looked up, none sold, or they
  // came in another currency than the order book.
  function packCap(r) {
    if (!r || r.hc !== r.cur) return null;
    return r.s7 > 0 ? r.m7 : r.sy > 0 ? r.my : null;
  }

  // A row's tag: what its pack nets, or why it is not ranked. A pack that pays only once listed
  // is 'stale' when none sold in the last year: its listings are not selling.
  function packTag(x) {
    if (x.market === 'gone' || x.market === 'empty' || x.market === 'unsold') return x.market;
    const v = packVerdict(x.net);
    return v === 'listed' && x.r.sy === 0 ? 'stale' : v;
  }

  // "+A$0.75", "−A$0.12", "A$0.00".
  function signedCents(code, cents) {
    return (cents > 0 ? '+' : cents < 0 ? '−' : '') + centsText(code, Math.abs(cents));
  }

  // Units sold over the last `days`, and the price half of them sold at or under, in cents.
  function recentSales(points, days, now) {
    const sold = points.filter(p => p.t >= now - days * DAY && p.v > 0).sort((a, b) => a.p - b.p);
    let units = 0, run = 0;
    for (const p of sold) units += p.v;
    for (const p of sold) {
      run += p.v;
      if (run * 2 >= units) return { units, median: Math.round(p.p * 100) };
    }
    return { units: 0, median: null };
  }

  // The most recent sale: {t, price in cents}, or null when none sold.
  function lastSale(points) {
    let last = null;
    for (const p of points) if (p.v > 0 && (!last || p.t > last.t)) last = p;
    return last ? { t: last.t, price: Math.round(last.p * 100) } : null;
  }

  // The pack table's columns, as sort keys. A missing value sorts last whichever way a column
  // is turned; ties go to what selling now nets, then listing, then the name.
  const PACK_KEYS = {
    name: x => x.g.name.toLowerCase(), gems: x => x.g.gems,
    bid: x => (x.r && x.r.b) || null, ask: x => (x.r && x.r.a) || null,
    now: x => (x.net ? x.net.now : null), listed: x => (x.net ? x.net.listed : null),
    // Last week's sales, then the year's to part packs that sold none this week.
    sold: x => (x.r && x.r.s7 != null ? x.r.s7 + (x.r.sy || 0) / 1e7 : null),
  };

  function sortPacks(rows, key, dir) {
    const by = (f, d) => (a, b) => {
      const x = f(a), y = f(b);
      if (x == null || y == null) return (x == null) - (y == null);
      return (x < y ? -1 : x > y ? 1 : 0) * d;
    };
    const order = [by(PACK_KEYS[key] || PACK_KEYS.now, dir), by(PACK_KEYS.now, -1), by(PACK_KEYS.listed, -1), by(PACK_KEYS.name, 1)];
    return rows.slice().sort((a, b) => {
      for (const f of order) {
        const c = f(a, b);
        if (c) return c;
      }
      return 0;
    });
  }

  // Each of the creator's games with its looked-up pack, whether that pack sells on the market,
  // and what a pack nets, best first. Only a pack that sells is set against its gems. recs, by
  // appid: {b: best buy order, a: cheapest listing, in cents, and once looked up s7 and sy: units
  // sold in the last week and year, m7 and my: their medians}, or {err} or {none} when there is
  // no order book to go on.
  function rankPacks(games, recs, perGem, w) {
    const rows = games.map(g => {
      const r = (recs && recs[g.appid]) || null, market = packMarket(r);
      const net = market === 'live' && perGem != null ? packNet(g.gems, r.b, r.a, perGem, w, packCap(r)) : null;
      return { g, r, market, net };
    });
    return sortPacks(rows, 'now', -1);
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
    source: ['sct.source', 'held30'], trim: ['sct.trim', '0.05'], undercut: ['sct.undercut', '1'],
    stale: ['sct.stale', '1'], advance: ['sct.advance', '1'], keys: ['sct.keys', '1'], remember: ['sct.remember', '0'], dock: ['sct.dock', '1'],
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
    floor: 'Lowest price Steam allows', saved: 'Your saved price', cost: 'Lowest price that profits on what you paid',
  };

  const STYLE = `
    .sct-box { box-sizing: border-box; width: 100%; margin: 0 0 8px; padding: 8px 10px; background: rgba(0,0,0,.3);
               border: 1px solid #2a3f5a; border-radius: 3px; font: 11px "Motiva Sans", Arial, sans-serif; color: ${GREY}; }
    .sct-box.dock { position: fixed; z-index: 400; margin: 0; overflow-y: auto; background: #16202d; }
    .sct-box a { text-decoration: none; cursor: pointer; }
    .sct-strip { display: flex; align-items: center; gap: 10px; min-height: 28px; }
    .sct-box.open .sct-strip { display: none; }
    .sct-box:not(.open) .sct-full { display: none; }
    .sct-box.nodata .sct-d { display: none !important; }
    .sct-spark { width: 110px; height: 28px; flex: none; }
    .sct-s-name { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .sct-s-note { white-space: nowrap; }
    .sct-warn { color: ${AMBER}; }
    .sct-up { color: #75b022; } .sct-down { color: #e06b5c; }
    .sct-toggle { color: ${BLUE}; padding: 2px 4px; font-size: 13px; line-height: 1; }
    .sct-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .sct-name { color: #fff; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .sct-range { white-space: nowrap; }
    .sct-range a { color: ${GREY}; margin-left: 2px; padding: 2px 8px; border-radius: 9px; }
    .sct-range a.active { background: #2a475e; color: ${BLUE}; }
    .sct-gear { color: ${BLUE}; }
    .sct-rules { display: none; margin: 0 0 10px; padding: 10px; background: #16202d; border: 1px solid #2a3f5a; border-radius: 3px; color: ${LIGHT}; }
    .sct-box.rules .sct-rules { display: block; }
    .sct-rules h5 { margin: 0 0 4px; font: 11px "Motiva Sans", Arial, sans-serif; color: ${GREY}; }
    .sct-seg { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
    .sct-seg a { padding: 3px 9px; border: 1px solid #2a3f5a; border-radius: 3px; color: ${LIGHT}; }
    .sct-seg a.active { border-color: ${AMBER}; color: ${AMBER}; background: rgba(233,184,74,.1); }
    .sct-rules p { margin: -3px 0 8px; color: ${GREY}; }
    .sct-rules label { display: flex; gap: 6px; align-items: flex-start; margin-top: 5px; cursor: pointer; }
    .sct-rules input { margin: 1px 0 0; flex: none; }
    .sct-hero { display: flex; align-items: stretch; gap: 12px; }
    .sct-ask { flex: none; }
    .sct-lbl { font-size: 10px; letter-spacing: .06em; }
    .sct-askrow { display: flex; align-items: baseline; color: ${AMBER}; font-size: 24px; line-height: 32px; white-space: nowrap; }
    .sct-box input.sct-price { width: 4.6ch; height: 32px; padding: 0 2px !important; background: transparent !important; border: 0 !important;
                 border-bottom: 1px solid transparent !important; border-radius: 0 !important; box-shadow: none !important; margin: 0;
                 color: ${AMBER}; font: 24px "Motiva Sans", Arial, sans-serif; -moz-appearance: textfield; appearance: textfield; }
    .sct-box input.sct-price:hover, .sct-box input.sct-price:focus { border-bottom-color: ${AMBER} !important; outline: none; }
    .sct-price::-webkit-outer-spin-button, .sct-price::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .sct-gems { display: inline-flex; align-items: center; gap: 5px; margin-top: 3px; padding: 0 8px 0 6px; border: 1px solid #4b3f72;
                border-radius: 9px; background: rgba(169,140,232,.1); color: ${VIOLET}; line-height: 16px; white-space: nowrap; }
    .sct-why { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
    .sct-why-t { color: #fff; font-size: 12px; }
    .sct-why-t a { color: ${BLUE}; font-size: 11px; margin-left: 6px; }
    .sct-why-d { color: #a9b4bd; }
    .sct-box.narrow .sct-hero { flex-wrap: wrap; row-gap: 8px; }
    .sct-box.narrow .sct-ask { flex: 1; }
    .sct-box.narrow .sct-why { order: 3; flex: none; width: 100%; }
    .sct-do { flex: none; width: 160px; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
    .sct-list { display: block; box-sizing: border-box; border-radius: 3px; background: #75b022; color: #10202b; text-align: center;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sct-list:hover { background: #8ed13a; }
    .sct-list.busy { opacity: .6; pointer-events: none; }
    .sct-list.done { background: #2a3f5a; color: ${LIGHT}; pointer-events: none; }
    .sct-f-list { padding: 6px 6px; }
    .sct-f-list b { display: block; font-size: 14px; line-height: 18px; }
    .sct-f-list i { display: block; font-style: normal; line-height: 14px; overflow: hidden; text-overflow: ellipsis; }
    .sct-s-list { padding: 0 12px; height: 24px; line-height: 24px; font-weight: bold; flex: none; }
    .sct-all { display: block; padding: 3px 0; border: 1px solid #3d6b1f; border-radius: 3px; color: #a4d007; text-align: center; white-space: nowrap; }
    .sct-all:hover { border-color: #75b022; }
    .sct-all.busy { opacity: .5; pointer-events: none; }
    .sct-tip { min-height: 14px; line-height: 14px; margin: 6px 0 2px; color: ${LIGHT}; }
    .sct-canvas { display: block; width: 100%; height: ${HEIGHT}px; cursor: crosshair; }
    .sct-railhead { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .sct-share { color: ${AMBER}; white-space: nowrap; }
    .sct-hist { display: block; width: 100%; height: ${HIST_H}px; cursor: pointer; }
    .sct-chips { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; margin: 6px 0 8px; }
    .sct-chip { display: block; padding: 4px 7px; border-radius: 3px; border: 1px solid #2a3f5a; color: ${GREY}; font-size: 10px;
                white-space: nowrap; overflow: hidden; }
    .sct-chip:hover { border-color: ${BLUE}; }
    .sct-chip i { display: block; font-style: normal; font-size: 13px; color: ${LIGHT}; }
    .sct-chip.active, .sct-chip.active i { border-color: ${AMBER}; color: ${AMBER}; }
    .sct-chip.active { background: rgba(233,184,74,.1); }
    .sct-chip.empty { cursor: default; }
    .sct-chip.empty:hover { border-color: #2a3f5a; }
    .sct-stats { display: flex; gap: 10px; align-items: center; border-top: 1px solid #2a3f5a; padding-top: 6px; }
    .sct-st { flex: 1; min-width: 0; }
    .sct-stats b { color: ${LIGHT}; font-weight: normal; }
    .sct-tally { color: #a4d007; white-space: nowrap; }
    .sct-market { color: ${BLUE}; white-space: nowrap; }
    .sct-hover { position: absolute; z-index: 1000; background: #16202d; border: 1px solid #2a3f5a; border-radius: 3px;
                 padding: 6px 8px; display: flex; align-items: center; gap: 8px; font: 11px "Motiva Sans", Arial, sans-serif;
                 color: ${GREY}; pointer-events: none; white-space: nowrap; }
    .sct-hover canvas { width: 90px; height: 24px; }
    .sct-hover b { color: ${LIGHT}; font-weight: normal; }
    .sct-hover em { color: ${AMBER}; font-style: normal; }
    .sct-badge { position: absolute; left: 2px; bottom: 2px; z-index: 3; padding: 0 3px; border-radius: 2px; background: rgba(0,0,0,.72);
                 color: ${LIGHT}; font: 10px/14px "Motiva Sans", Arial, sans-serif; pointer-events: none; }
    .sct-badge:empty { display: none; }
    .sct-badge.done { color: #a4d007; }
    .sct-paid { display: flex; align-items: center; gap: 5px; margin-top: 4px; white-space: nowrap; }
    .sct-box input.sct-cost { width: 6.5ch; height: 18px; padding: 0 3px !important; background: rgba(0,0,0,.25) !important;
                 border: 1px solid #2a3f5a !important; border-radius: 2px !important; box-shadow: none !important; margin: 0;
                 color: ${LIGHT}; font: 11px "Motiva Sans", Arial, sans-serif; -moz-appearance: textfield; appearance: textfield; }
    .sct-cost::-webkit-outer-spin-button, .sct-cost::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .sct-floor { color: #a4d007; }
    .sct-floor.under { color: #e06b5c; }
    .sct-scanlink { color: ${BLUE}; white-space: nowrap; }
    .sct-inv { display: none; margin: 0 0 10px; border: 1px solid #2a3f5a; border-radius: 3px; background: #16202d; }
    .sct-box.inv .sct-inv { display: block; }
    .sct-inv-h { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid #2a3f5a; color: ${LIGHT}; }
    .sct-inv-note { flex: 1; min-width: 0; color: ${GREY}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sct-inv-list { max-height: 260px; overflow-y: auto; }
    .sct-inv-row { display: grid; grid-template-columns: minmax(0, 1fr) 30px 64px 80px; gap: 6px; align-items: center; padding: 3px 8px; color: ${GREY}; }
    .sct-inv-row:hover { background: rgba(102,192,244,.08); }
    .sct-inv-row b { color: ${LIGHT}; font-weight: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sct-inv-row em { color: ${AMBER}; font-style: normal; text-align: right; }
    .sct-inv-row span { text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sct-inv-row.done { opacity: .45; }
    .sct-conflict { position: fixed; z-index: 500; left: 12px; bottom: 12px; max-width: 380px; padding: 8px 10px; background: #3a2a12;
                    border: 1px solid ${AMBER}; border-radius: 3px; color: #fff; font: 12px "Motiva Sans", Arial, sans-serif; }

    .sct-launch { position: fixed; z-index: 8990; left: 14px; bottom: 14px; padding: 7px 12px; border: 1px solid #3d6c8d; border-radius: 3px;
                  background: #2a475e; color: ${BLUE}; font: 12px "Motiva Sans", Arial, sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
    .sct-launch:hover { background: #33566f; color: #fff; }
    .sct-dash { position: fixed; inset: 0; z-index: 9000; overflow-y: auto; background: #1b2838; color: ${LIGHT};
                font: 13px/1.4 "Motiva Sans", Arial, sans-serif; text-align: left; }
    .sct-dash *, .sct-card *, .sct-packs * { box-sizing: border-box; }
    .sct-dash a, .sct-card a, .sct-packs a { color: ${BLUE}; text-decoration: none; cursor: pointer; }
    .sct-dash-in { max-width: 1240px; margin: 0 auto; padding: 18px 20px 60px; }
    .sct-dh { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .sct-dh h1 { flex: 1; margin: 0; font: 22px "Motiva Sans", Arial, sans-serif; color: #fff; }
    .sct-dash a.sct-btn, .sct-card a.sct-btn, .sct-packs a.sct-btn { display: inline-block; padding: 6px 14px; border: 1px solid #3d6c8d; border-radius: 3px;
               background: #2a475e; color: ${BLUE}; font: 13px "Motiva Sans", Arial, sans-serif; white-space: nowrap; }
    .sct-dash a.sct-btn:hover, .sct-card a.sct-btn:hover, .sct-packs a.sct-btn:hover { background: #33566f; color: #fff; }
    .sct-dash a.sct-btn.go, .sct-card a.sct-btn.go, .sct-packs a.sct-btn.go { background: #75b022; border-color: #75b022; color: #10202b; }
    .sct-dash a.sct-btn.go:hover, .sct-card a.sct-btn.go:hover, .sct-packs a.sct-btn.go:hover { background: #8ed13a; color: #10202b; }
    .sct-dash a.sct-btn.small, .sct-card a.sct-btn.small, .sct-packs a.sct-btn.small { padding: 2px 9px; font-size: 12px; }
    .sct-status { min-height: 20px; color: ${GREY}; }
    .sct-bar { height: 4px; margin: 6px 0 10px; border-radius: 2px; background: #16202d; overflow: hidden; }
    .sct-bar i { display: block; width: 0; height: 100%; background: ${BLUE}; transition: width .3s; }
    .sct-note { margin: 0 0 8px; padding: 7px 10px; border: 1px solid #6b5a2a; border-radius: 3px; background: rgba(233,184,74,.08); color: ${AMBER}; }
    .sct-tabs { display: flex; gap: 4px; margin-top: 12px; border-bottom: 1px solid #2a3f5a; }
    .sct-dash .sct-tabs a { padding: 7px 14px; border: 1px solid transparent; border-radius: 3px 3px 0 0; color: ${GREY}; margin-bottom: -1px; }
    .sct-dash .sct-tabs a.active { background: #16202d; color: #fff; border-color: #2a3f5a; border-bottom-color: #16202d; }
    .sct-view { padding: 10px 12px 14px; background: #16202d; border: 1px solid #2a3f5a; border-top: 0; }
    .sct-filters { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-bottom: 8px; color: ${GREY}; }
    .sct-dash input, .sct-dash select { height: 26px; padding: 0 6px; background: #0e1620; border: 1px solid #2a3f5a; border-radius: 3px;
                                        color: ${LIGHT}; font: 13px "Motiva Sans", Arial, sans-serif; }
    .sct-dash input[type=number] { width: 78px; }
    .sct-t { width: 100%; border-collapse: collapse; }
    .sct-t th { padding: 6px 8px; border-bottom: 1px solid #2a3f5a; color: ${GREY}; font-size: 12px; font-weight: normal; text-align: right;
                white-space: nowrap; cursor: pointer; user-select: none; }
    .sct-t th:first-child, .sct-t td:first-child { text-align: left; }
    .sct-t th.sorted { color: ${AMBER}; }
    .sct-t td { padding: 5px 8px; border-bottom: 1px solid rgba(42,63,90,.5); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .sct-t tr:hover td { background: rgba(102,192,244,.05); }
    .sct-t td.name { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
    .sct-t td.name i { display: block; overflow: hidden; text-overflow: ellipsis; font-style: normal; font-size: 11px; color: ${GREY}; }
    .sct-t td b { font-weight: normal; color: #fff; }
    .sct-tag { display: inline-block; padding: 0 7px; border: 1px solid; border-radius: 9px; font-size: 11px; line-height: 17px; white-space: nowrap; }
    .sct-tag.now { color: #a4d007; border-color: #4c6b22; background: rgba(117,176,34,.12); }
    .sct-tag.top { color: ${BLUE}; border-color: #2f5f7f; background: rgba(102,192,244,.1); }
    .sct-tag.wait { color: ${GREY}; border-color: #3a4652; }
    .sct-dim { color: ${GREY}; }
    .sct-ok { color: #a4d007; }
    .sct-empty { padding: 26px 10px; color: ${GREY}; text-align: center; }
    .sct-set { display: grid; grid-template-columns: minmax(220px, 320px) auto; gap: 9px 14px; align-items: center; max-width: 780px; }
    .sct-set p { grid-column: 1 / -1; margin: 0 0 4px; color: ${GREY}; font-size: 12px; }
    .sct-card { position: fixed; z-index: 8980; right: 14px; bottom: 14px; width: 322px; background: #16202d; border: 1px solid #2a3f5a; border-radius: 4px;
                box-shadow: 0 4px 18px rgba(0,0,0,.6); color: ${LIGHT}; font: 12px/1.45 "Motiva Sans", Arial, sans-serif; text-align: left; }
    .sct-ch { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid #2a3f5a; }
    .sct-ch b { flex: 1; color: #fff; font-weight: normal; }
    .sct-card.shut .sct-cb { display: none; }
    .sct-card.shut .sct-ch { border-bottom: 0; }
    .sct-cb { padding: 9px 10px 10px; }
    .sct-big { display: flex; align-items: center; gap: 8px; color: ${AMBER}; font-size: 22px; line-height: 28px; }
    .sct-cb p { margin: 5px 0 0; color: #a9b4bd; }
    .sct-cb p b { color: ${LIGHT}; font-weight: normal; }
    .sct-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    .sct-packs { margin: 18px 0; background: #16202d; border: 1px solid #2a3f5a; border-radius: 4px; color: ${LIGHT};
                 font: 13px/1.4 "Motiva Sans", Arial, sans-serif; text-align: left; }
    .sct-ph { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #2a3f5a; }
    .sct-ph b { flex: 1; color: #fff; font-weight: normal; font-size: 15px; }
    .sct-packs.shut .sct-pb { display: none; }
    .sct-packs.shut .sct-ph { border-bottom: 0; }
    .sct-pb { padding: 10px 12px 12px; }
    .sct-psum { margin: 0 0 8px; color: #fff; }
    .sct-psum:empty { display: none; }
    .sct-ptable { overflow-x: auto; }
    .sct-packs .sct-t td.name { max-width: 290px; }
    .sct-packs .sct-t tr.cool td { opacity: .5; }
    .sct-pfoot { margin: 10px 0 0; color: ${GREY}; font-size: 12px; }
    .sct-bad { color: #e06b5c; }
    .sct-tag.lose { color: #e06b5c; border-color: #6b2f28; background: rgba(224,107,92,.1); }
    .sct-tag.off { color: ${GREY}; border-color: ${SLATE}; border-style: dashed; }
    .sct-packs .sct-t td i.sct-sub { display: block; font-style: normal; font-size: 11px; color: ${GREY}; }
  `;

  function addStyle() {
    if (document.getElementById('sct-style')) return;
    const el = document.createElement('style');
    el.id = 'sct-style';
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
    const r = +pref('sct.range', '30');
    return RANGES.some(x => x[1] === r) ? r : 30;
  }

  // ---- shared by the inventory and the market pages ----
  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  // What the wallet looks like, kept from whichever signed-in page showed it:
  // {cur: Steam's currency number, prefix, suffix, fees: {pct, min, base}}.
  function wallet() {
    return readJson('sct.wallet', {});
  }

  function learnWallet(patch) {
    const w = wallet();
    let changed = false;
    for (const k in patch) {
      if (patch[k] == null || JSON.stringify(w[k]) === JSON.stringify(patch[k])) continue;
      w[k] = patch[k];
      changed = true;
    }
    if (changed) writeJson('sct.wallet', w);
  }

  // Card fees in the wallet's currency, as far as a signed-in page has shown them.
  function feesNow() {
    return Object.assign({}, CARD_FEES, wallet().fees || {});
  }

  // What was paid for a card, by market hash name: {buy (cents each), qty, t, name, src}.
  // src is 'steam' (read from the account's buy orders), 'order' (noted on the card's
  // page) or 'manual' (typed into the inventory panel).
  function ledger() {
    return readJson('sct.ledger', {});
  }

  function costOf(hash) {
    const e = ledger()[hash];
    return e && e.buy >= 1 ? e.buy : null;
  }

  function setCost(hash, entry) {
    const l = ledger();
    l[hash] = Object.assign({ t: Date.now() }, entry);
    writeJson('sct.ledger', l);
  }

  function dropCost(hash) {
    const l = ledger();
    delete l[hash];
    writeJson('sct.ledger', l);
  }

  // Trader settings: [default, lowest allowed].
  const OPTS = { minProfit: [2, 1], share: [0.25, 0.01], maxQty: [5, 1], minPerDay: [10, 0], bandMin: [15, 3], bandMax: [300, 4],
                 cards: [200, 10], gap: [3, 1.5] };

  function opts() {
    const saved = readJson('sct.opts', {}), o = {};
    for (const k in OPTS) {
      const v = Number(saved[k]);
      o[k] = isFinite(v) && saved[k] != null && saved[k] !== '' ? Math.max(OPTS[k][1], v) : OPTS[k][0];
    }
    o.cards = Math.min(3000, Math.round(o.cards));
    return o;
  }

  function setOpt(key, value) {
    const o = readJson('sct.opts', {});
    o[key] = value;
    writeJson('sct.opts', o);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const cardUrl = hash => `${location.origin}/market/listings/753/${encodeURIComponent(hash)}`;
  const traderUrl = () => `${location.origin}/market/#card-trader`;
  const signedOut = () => !!document.querySelector('a[href*="/login/home"]');

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  // Steam's market API, the one its own pages call: GET path?q=Method&qp=[arguments].
  // `anon` leaves the session cookie out, so the lookup is not tied to the account.
  async function marketCall(anon, path, method, ...args) {
    const url = `${location.origin}${path}?q=${method}&qp=${encodeURIComponent(JSON.stringify(args))}`;
    const res = await fetch(url, { credentials: anon ? 'omit' : 'same-origin', cache: 'no-store' });
    if (res.status === 429 || res.status === 403) {
      const e = new Error(`Steam is refusing lookups for now (${res.status}).`);
      e.rate = true;
      throw e;
    }
    if (!res.ok) throw new Error(`Steam answered ${res.status}.`);
    const body = await res.json();
    return body ? body.data : null;
  }

  // One card's order book and its last 30 days of sales, as a record small enough to
  // store. Prices come in whatever currency Steam answers in: the wallet's when signed
  // in, the visitor's country's when not.
  async function loadCard(anon, hash, between) {
    const ob = await marketCall(anon, '/market/orderbook', 'Load', 753, hash);
    const book = ob && ob.success && ob.data;
    if (!book) throw new Error('Steam sent no order book for this card.');
    if (between) await between();
    const ph = await marketCall(anon, '/market/actions', 'QueryPriceHistory', 753, hash);
    return {
      cur: book.eCurrency, cb: book.cBuyOrders || 0, cs: book.cSellOrders || 0,
      bb: (book.rgCompactBuyOrders || []).slice(0, 24), aa: (book.rgCompactSellOrders || []).slice(0, 40),
      lv: packLevels(priceLevels(apiPoints(ph && ph.prices), Date.now())),
    };
  }

  const cardOf = rec => ({ bids: bookLevels(rec.bb), asks: bookLevels(rec.aa), levels: unpackLevels(rec.lv) });

  // Read the account's open buy orders into the ledger. A filled order drops off Steam's
  // list but stays here, which is how the inventory knows what a card cost.
  async function syncOrders() {
    const l = ledger();
    let n = 0;
    for (let start = 0, pages = 0; pages < 8; pages++) {
      const page = await marketCall(false, '/market/actions', 'QueryMyBuyOrders', start, 50, true);
      const rows = page && Array.isArray(page.rgBuyOrders) ? page.rgBuyOrders : null;
      if (!rows) throw new Error('Steam did not list your buy orders.');
      for (const row of rows) {
        const o = row && row.order, d = row && row.description;
        const price = o ? parseInt(o.price, 10) : NaN;
        if (!d || String(d.appid) !== '753' || !d.market_hash_name || !(price >= 1)) continue;
        const old = l[d.market_hash_name];
        l[d.market_hash_name] = {
          buy: price, qty: parseInt(o.quantity, 10) || 1, t: old && old.buy === price ? old.t : Date.now(),
          name: d.name || d.market_hash_name, src: 'steam',
        };
        if (o.wallet_currency) learnWallet({ cur: parseInt(o.wallet_currency, 10) });
        n++;
      }
      if (!page.bMore || !rows.length) break;
      start += rows.length;
    }
    writeJson('sct.ledger', l);
    return n;
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
    const key = `sct:${appid}:${hash}`;
    const cached = cacheGet(key);
    if (cached) return Promise.resolve(cached);
    if (inflight.has(key)) return inflight.get(key);
    const url = `${location.origin}/market/pricehistory/?appid=${encodeURIComponent(appid)}` +
                `&market_hash_name=${encodeURIComponent(hash)}`;
    const p = (async () => {
      const res = await fetch(url, { credentials: 'same-origin', signal });
      if (res.status === 429) {
        const e = new Error('Steam is rate-limiting history requests. Try again in a minute.');
        e.rate = true;
        throw e;
      }
      if (res.status === 400) throw new Error('No sale history for this item, or not signed in.');
      if (!res.ok) throw new Error(`Steam answered ${res.status}.`);
      let data;
      try { data = await res.json(); } catch (e) { throw new Error('Sign in to Steam to see sale history.'); }
      if (!data || data.success !== true) throw new Error('No sale history for this item.');
      const out = { prefix: data.price_prefix || '', suffix: data.price_suffix || '', prices: data.prices || [] };
      cacheSet(key, out);
      learnWallet({ prefix: out.prefix, suffix: out.suffix });
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
    const a = panel.querySelector('a[href*="/market/listings/"]:not(.sct-market)');
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
              hover: -1, drag: false, scale: null, view: [], controller: null, suppressClick: false, cost: null, floor: null };
  let box = null;
  let listing = false;
  // True while the original Sale History script is running on the same page: this one stands down.
  let conflict = false;

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
      for (const c of host.children) if (c.classList && c.classList.contains('sct-badge')) { b = c; break; }
      if (!b) {
        b = document.createElement('span');
        b.className = 'sct-badge';
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
      box.classList.toggle('narrow', w < 500);
    } else if (box.classList.contains('dock') || !box.parentElement) {
      box.classList.remove('dock', 'narrow');
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
    box.className = 'sct-box' + (pref('sct.open', '1') === '1' ? ' open' : '');
    box.style.display = 'none';
    box.innerHTML =
      '<div class="sct-strip"><canvas class="sct-spark"></canvas><span class="sct-s-name"></span><span class="sct-s-note"></span>' +
      '<a class="sct-list sct-s-list sct-d"></a><a class="sct-toggle" title="Expand">▾</a></div>' +
      '<div class="sct-full">' +
      '<div class="sct-head"><span class="sct-name"></span><span class="sct-range"></span>' +
      '<a class="sct-scanlink" title="Look up every card in this inventory and price it">Price all</a>' +
      '<a class="sct-gear" title="Pricing rules">Rules</a><a class="sct-toggle" title="Collapse">▴</a></div>' +
      '<div class="sct-rules"></div>' +
      '<div class="sct-inv"><div class="sct-inv-h"><span class="sct-inv-note"></span><a class="sct-inv-stop"></a></div>' +
      '<div class="sct-inv-list"></div></div>' +
      '<div class="sct-hero sct-d">' +
      '<div class="sct-ask"><div class="sct-lbl">ASK · BUYER PAYS</div><div class="sct-askrow"><span class="sct-pre"></span>' +
      '<input class="sct-price" type="number" step="0.01" min="0.03" aria-label="Asking price"><span class="sct-suf"></span></div>' +
      '<div class="sct-gems" style="display:none" title="What Steam gives if you turn this item into gems">' +
      '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M5 .8 9.2 4 5 9.2 .8 4Z" fill="rgba(185,163,227,.25)" ' +
      'stroke="#b9a3e3" stroke-linejoin="round"/><path d="M.8 4H9.2" stroke="#b9a3e3" stroke-width=".8"/></svg><span></span></div>' +
      '<div class="sct-paid" title="What you paid for this card. The ask will not open below the price that still profits on it.">' +
      '<span>Paid</span><input class="sct-cost" type="number" step="0.01" min="0" placeholder="?" aria-label="What you paid">' +
      '<a class="sct-floor"></a></div></div>' +
      '<div class="sct-why"><div class="sct-why-t"></div><div class="sct-why-d"></div><div class="sct-why-o"></div>' +
      '<div class="sct-why-w sct-warn"></div></div>' +
      '<div class="sct-do"><a class="sct-list sct-f-list"><b></b><i></i></a><a class="sct-all"></a></div></div>' +
      '<div class="sct-tip">&nbsp;</div>' +
      '<canvas class="sct-canvas sct-d"></canvas>' +
      '<div class="sct-railhead sct-d"><span>Sales by price, 30 days. Click a bar to ask that price.</span><span class="sct-share"></span></div>' +
      '<canvas class="sct-hist sct-d"></canvas>' +
      '<div class="sct-chips sct-d"></div>' +
      '<div class="sct-stats"><span class="sct-st"></span><span class="sct-tally"></span>' +
      '<a class="sct-market" target="_blank" rel="noopener">Market ↗</a>' +
      '<a class="sct-market sct-trader" target="_blank" rel="noopener" title="The buy-side scanner">Trader ↗</a></div></div>';
    box.querySelector('.sct-trader').href = traderUrl();

    for (const t of box.querySelectorAll('.sct-toggle')) {
      t.addEventListener('click', e => {
        e.preventDefault();
        const open = !box.classList.contains('open');
        box.classList.toggle('open', open);
        setPref('sct.open', open ? '1' : '0');
        render();
      });
    }
    box.querySelector('.sct-gear').addEventListener('click', e => { e.preventDefault(); box.classList.toggle('rules'); });
    box.querySelector('.sct-scanlink').addEventListener('click', e => { e.preventDefault(); scanInventory(); });
    box.querySelector('.sct-inv-stop').addEventListener('click', e => {
      e.preventDefault();
      if (inv.running) inv.stop = true; else box.classList.remove('inv');
    });
    const cost = box.querySelector('.sct-cost');
    cost.addEventListener('change', () => costTyped(cost));
    cost.addEventListener('keydown', e => { if (e.key === 'Enter') cost.blur(); });
    box.querySelector('.sct-floor').addEventListener('click', e => { e.preventDefault(); if (S.floor != null) setAsk(S.floor); });
    buildRules(box.querySelector('.sct-rules'));
    const ranges = box.querySelector('.sct-range');
    for (const [label, days] of RANGES) {
      const a = document.createElement('a');
      a.textContent = label;
      a.dataset.days = String(days);
      a.addEventListener('click', e => { e.preventDefault(); setPref('sct.range', days); render(); });
      ranges.appendChild(a);
    }
    const input = box.querySelector('.sct-price');
    input.addEventListener('change', () => {
      const v = Math.round(parseFloat(input.value) * 100);
      if (isFinite(v)) setAsk(v);
      else input.value = (S.ask / 100).toFixed(2);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    for (const b of box.querySelectorAll('.sct-list')) b.addEventListener('click', e => { e.preventDefault(); listItems(1); });
    box.querySelector('.sct-all').addEventListener('click', e => { e.preventDefault(); listItems(S.left); });

    const canvas = box.querySelector('.sct-canvas');
    canvas.addEventListener('mousemove', onChartMove);
    canvas.addEventListener('mouseleave', onChartLeave);
    canvas.addEventListener('mousedown', onChartDown);
    canvas.addEventListener('click', onChartClick);
    const hist = box.querySelector('.sct-hist');
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
      row.className = 'sct-seg';
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
    for (const a of box.querySelectorAll('.sct-seg a')) {
      const want = a.dataset.rule === 'trim' ? trim : SOURCES.some(x => x[0] === source) ? source : 'held30';
      a.classList.toggle('active', String(parseFloat(a.dataset.value) || a.dataset.value) === want);
    }
    for (const i of box.querySelectorAll('.sct-rules input')) i.checked = on(i.dataset.rule);
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
    const tip = box && box.querySelector('.sct-tip');
    if (tip) { if (text) tip.textContent = text; else tip.innerHTML = '&nbsp;'; }
  }

  function showMessage(text) {
    box.classList.add('nodata');
    setTip(text);
    box.querySelector('.sct-st').textContent = '';
    const note = box.querySelector('.sct-s-note');
    note.textContent = text;
    note.className = 'sct-s-note';
    const spark = box.querySelector('.sct-spark');
    spark.getContext('2d').clearRect(0, 0, spark.width, spark.height);
  }

  function setName(name) {
    for (const el of box.querySelectorAll('.sct-name, .sct-s-name')) el.textContent = name || '';
  }

  async function update(panel) {
    if (conflict) return;
    ensureBox();
    const item = panelItem(panel);
    if (!item) {
      // The panel shows nothing marketable. Clear only if it is the live selection. The
      // box stays, so "Price all" can still be reached.
      const it = globalSelected();
      if (!it || !it.description.marketable || !panelName(panel) || panelName(panel) === (it.description.name || '').trim()) {
        S.key = null; S.item = null; S.panel = null; S.data = null; S.points = []; S.p30 = []; S.view = [];
        setName('');
        box.style.display = '';
        placeBox();
        showMessage('Pick a card to see its sale history.');
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
    S.cost = costOf(item.hash);
    S.floor = null;
    drawGems();
    setName(item.name);
    box.querySelector('.sct-market').href = item.url;
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
    const saved = on('remember') ? parseInt(pref('sct.ask:' + S.key, ''), 10) : NaN;
    if (isFinite(saved) && saved >= MIN_ASK) {
      S.ask = saved; S.manual = true; S.why = 'saved';
    } else {
      const d = pickAsk({ source: rule('source'), held30: S.held30, held7: S.held7, lowest: S.lowest, median: S.med30,
                          last: S.points.length ? S.points[S.points.length - 1].p : null, undercut: on('undercut') });
      S.ask = d.cents;
      S.why = d.why;
      S.manual = false;
    }
    applyFloor();
  }

  // The lowest ask that still profits on what was paid. A default below it is raised to
  // it; a price set by hand is left alone and flagged.
  function applyFloor() {
    S.floor = S.cost == null ? null : askToClear(S.cost, FLOOR_PROFIT, feesFor());
    if (S.floor != null && !S.manual && S.ask < S.floor) { S.ask = S.floor; S.why = 'cost'; }
  }

  // The "Paid" box changed: keep it for this card, or forget it when emptied.
  function costTyped(input) {
    if (!S.item) return;
    const v = Math.round(parseFloat(input.value) * 100);
    if (isFinite(v) && v >= 1) setCost(S.item.hash, { buy: v, qty: 1, name: S.item.name, src: 'manual' });
    else dropCost(S.item.hash);
    S.cost = costOf(S.item.hash);
    if (!S.data || !S.points.length) return;
    if (S.manual) applyFloor(); else applyDefault();
    redrawPrice();
  }

  function drawPaid() {
    const input = box.querySelector('.sct-cost'), note = box.querySelector('.sct-floor');
    if (document.activeElement !== input) input.value = S.cost == null ? '' : (S.cost / 100).toFixed(2);
    const under = S.floor != null && S.ask < S.floor;
    note.textContent = S.floor == null ? '' : under ? `a loss under ${m$(S.floor / 100)}` : `profits from ${m$(S.floor / 100)}`;
    note.classList.toggle('under', under);
    note.title = S.floor == null ? '' : 'Click to ask this price';
  }

  function resetAsk() {
    dropPref('sct.ask:' + S.key);
    S.manual = false;
    applyDefault();
    redrawPrice();
  }

  function drawGems() {
    const el = box && box.querySelector('.sct-gems');
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
    for (const a of box.querySelectorAll('.sct-range a')) a.classList.toggle('active', +a.dataset.days === days);

    if (!S.points.length) { showMessage('No sales recorded.'); return; }
    box.classList.remove('nodata');
    box.querySelector('.sct-pre').textContent = (S.data.prefix || '').trim();
    box.querySelector('.sct-suf').textContent = (S.data.suffix || '').trim();

    const s30 = periodStats(S.points, 30, now);
    drawSpark(box.querySelector('.sct-spark'), s30.view.length >= 2 ? s30.view : S.points);

    const s = periodStats(S.points, days, now);
    S.view = s.view;
    S.hover = -1;
    const label = days ? `${days}d` : 'all time';
    const stats = box.querySelector('.sct-st');
    const canvas = box.querySelector('.sct-canvas');
    if (!s.view.length) {
      canvas.style.display = 'none';
      setTip(`No sales in the last ${label}.`);
      stats.textContent = '';
    } else {
      canvas.style.display = '';
      setTip('');
      const trend = s.trend == null ? '' :
        ` · <span class="${s.trend >= 0 ? 'sct-up' : 'sct-down'}">${fmtTrend(s.trend)}</span> on the ${label} before`;
      stats.innerHTML =
        `Sold <b>${s.sold}</b> in ${label} · <b>${fmtRate(s.perDay)} / day</b>${trend} · low <b>${m$(s.low)}</b>`;
    }
    renderChips();
    redrawPrice();
  }

  function renderChips() {
    const wrap = box && box.querySelector('.sct-chips');
    if (!wrap || !S.data) return;
    wrap.textContent = '';
    const defs = [['Cheapest', S.lowest, 'Cheapest listing'], ['30d median', S.med30], ['7d high', S.held7],
                  ['Held high', S.held30], ['Raw high', S.raw30]];
    S.chipCents = [];
    defs.forEach(([label, val, full], n) => {
      const a = document.createElement('a');
      a.className = 'sct-chip';
      const i = document.createElement('i');
      a.textContent = label;
      i.textContent = val == null ? '—' : m$(Math.max(MIN_ASK, Math.round(val * 100)) / 100);
      a.appendChild(i);
      if (val != null) {
        const cents = Math.max(MIN_ASK, Math.round(val * 100));
        a.dataset.cents = String(cents);
        a.dataset.label = full || label;
        a.title = `${full || label} · key ${n + 1}`;
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
    for (const a of box.querySelectorAll('.sct-chip')) a.classList.toggle('active', a.dataset.cents === String(S.ask));
  }

  function feesFor() {
    const it = globalSelected();
    return feesOf(it && it.description);
  }

  // Steam's fees on one item, from its description and the wallet.
  function feesOf(d) {
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
    if (on('remember') && S.key) setPref('sct.ask:' + S.key, S.ask);
    redrawPrice();
  }

  // Why the ask is what it is, and what the history says about it.
  function reason() {
    const now = Date.now();
    const ask = S.ask / 100;
    const ev = soldAtOrAbove(S.p30, ask);
    let title = WHY[S.why] || 'Custom price';
    if (S.why === 'manual') {
      const chip = box.querySelector(`.sct-chip[data-cents="${S.ask}"]`);
      if (chip) title = chip.dataset.label;
    }
    let detail = ev.units
      ? `Sold at or above on ${ev.days} ${ev.days === 1 ? 'day' : 'days'} · ${ev.units} ${ev.units === 1 ? 'unit' : 'units'}` +
        ` · last ${fmtAgo(ev.last, now)}`
      : 'Nothing sold this high in 30 days.';
    if (S.why === 'undercut') detail = `Cheapest listing is ${m$(S.lowest)}, above the held high of ${m$(S.held30)}.`;
    if (S.why === 'cost') detail = `You paid ${m$(S.cost / 100)}. Nothing lower covers that after Steam's fees.`;
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
    if (S.why === 'cost' && ev.units === 0) {
      short = 'above the market';
      warn = `Nothing has sold this high in 30 days, so it may sit unsold. The held high is ${S.held30 == null ? 'unknown' : m$(S.held30)}.`;
    }
    if (S.floor != null && S.ask < S.floor) {
      short = 'under what you paid';
      warn = `After fees this pays less than the ${m$(S.cost / 100)} you paid. ${m$(S.floor / 100)} is the least that profits.`;
    }
    return { title, detail, outliers, warn, short, share: ev.total ? ev.units / ev.total : null };
  }

  function drawButtons() {
    if (!S.data || !box || listing) return;
    const full = box.querySelector('.sct-f-list'), strip = box.querySelector('.sct-s-list'), all = box.querySelector('.sct-all');
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
    const t = box.querySelector('.sct-tally');
    t.textContent = tally.n ? `${tally.n} listed this session · ${m$(tally.cents / 100)}` : '';
  }

  // Everything that depends on the asking price: input, reason, chips, buttons, tile badge, both canvases.
  function redrawPrice() {
    if (!S.data || !box || !S.points.length) return;
    drawButtons();
    const r = reason();
    const note = box.querySelector('.sct-s-note');
    note.textContent = r.short || r.title;
    note.className = 'sct-s-note' + (r.short ? ' sct-warn' : '');
    if (S.item) setBadge(S.item.hash, m$(S.ask / 100));
    if (!box.classList.contains('open')) return;
    const input = box.querySelector('.sct-price');
    if (document.activeElement !== input) input.value = (S.ask / 100).toFixed(2);
    input.style.width = (Math.max(4, input.value.length) + 0.6) + 'ch';
    const t = box.querySelector('.sct-why-t');
    t.textContent = r.title;
    if (S.manual) {
      const a = document.createElement('a');
      a.textContent = 'reset';
      a.addEventListener('click', e => { e.preventDefault(); resetAsk(); });
      t.appendChild(a);
    }
    box.querySelector('.sct-why-d').textContent = r.detail;
    box.querySelector('.sct-why-o').textContent = r.outliers;
    box.querySelector('.sct-why-w').textContent = r.warn;
    box.querySelector('.sct-share').textContent = r.share == null ? '' : `${Math.round(r.share * 100)}% sold at or above your ask`;
    drawPaid();
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
    const canvas = box.querySelector('.sct-canvas');
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
    const canvas = box.querySelector('.sct-hist');
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
    const full = box.querySelector('.sct-f-list'), strip = box.querySelector('.sct-s-list'), all = box.querySelector('.sct-all');
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
    if (inv.rows.length && !inv.running) drawInv();
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
    if (conflict || !on('keys') || !box || e.ctrlKey || e.altKey || e.metaKey || e.repeat || e.defaultPrevented) return;
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
    tipEl.className = 'sct-hover';
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
        tr.className = s.trend < 0 ? 'sct-down' : 'sct-up';
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
    // Attributes too: Steam fills some blocks while they are hidden and only then shows them.
    }).observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }

  // ---- every card in the inventory, priced ----
  const INV_GAP = 1500;
  const inv = { running: false, stop: false, rows: [] };

  // The price a card would open on, worked out without selecting it. The cheapest
  // listing is not known here, so the "market has moved up" rule waits for a click.
  function quote(points, key, hash, fees) {
    const now = Date.now(), trim = trimValue();
    const p30 = inRange(points, 30, now);
    const saved = on('remember') ? parseInt(pref('sct.ask:' + key, ''), 10) : NaN;
    const manual = isFinite(saved) && saved >= MIN_ASK;
    let ask = manual ? saved : pickAsk({
      source: rule('source'), held30: heldHigh(p30, trim), held7: heldHigh(inRange(points, 7, now), trim), lowest: null,
      median: median(p30.map(p => p.p)), last: points.length ? points[points.length - 1].p : null, undercut: false,
    }).cents;
    const cost = costOf(hash);
    const floor = cost == null ? null : askToClear(cost, FLOOR_PROFIT, fees);
    if (floor != null && !manual && ask < floor) ask = floor;
    return { ask, sold: points.length > 0 };
  }

  // Select an asset the way a click on its tile would, turning the grid to its page first.
  function selectAsset(a) {
    const active = window.g_ActiveInventory, tile = a && a.element;
    if (!tile) { setTip('Steam has not drawn that card\'s page yet. Page through the grid to it.'); return; }
    try { if (active && active.EnsurePageActiveForItem) active.EnsurePageActiveForItem(tile); } catch (e) { /* stay on this page */ }
    const link = tile.querySelector('a.inventory_item_link');
    if (link) link.click();
    else if (active && active.SelectItem) active.SelectItem(null, tile, a, false);
  }

  function invRowEl(row) {
    const left = row.assets.filter(a => !listed.has(assetKey(a)));
    const price = cents => money(row.prefix, row.suffix, cents / 100);
    const priced = row.q && row.q.sold;
    return el('a', {
      class: 'sct-inv-row' + (left.length ? '' : ' done'), title: row.type,
      onclick: e => { e.preventDefault(); selectAsset(left[0] || row.assets[0]); },
    },
      el('b', { text: row.name }),
      el('span', { text: '×' + row.assets.length }),
      el('em', { text: priced ? price(row.q.ask) : row.q ? 'no sales' : row.err ? '—' : '…' }),
      el('span', { text: priced ? 'get ' + price(row.recv) : row.err }));
  }

  function drawInv() {
    const list = box.querySelector('.sct-inv-list');
    list.replaceChildren(...inv.rows.map(row => (row.el = invRowEl(row))));
  }

  // Look up every marketable item in the inventory, one request at a time, and price each
  // the way the panel would. Tiles get their price badges; the list is the overview.
  async function scanInventory() {
    const active = window.g_ActiveInventory;
    if (inv.running || conflict || !active) return;
    const note = box.querySelector('.sct-inv-note'), stop = box.querySelector('.sct-inv-stop');
    box.classList.add('inv');
    Object.assign(inv, { running: true, stop: false, rows: [] });
    drawInv();
    stop.textContent = 'stop';
    note.textContent = 'Loading the whole inventory…';
    try {
      // Steam loads an inventory a page at a time. Ask for the rest, and stop waiting after a while.
      if (typeof active.LoadCompleteInventory === 'function') await Promise.race([active.LoadCompleteInventory(), sleep(25000)]);
    } catch (e) { /* price what has loaded */ }
    const byHash = new Map();
    const assets = active.m_rgAssets || {};
    for (const id in assets) {
      const a = assets[id], d = a && a.description;
      if (!d || !d.marketable || !d.market_hash_name) continue;
      let row = byHash.get(d.market_hash_name);
      if (!row) {
        row = { appid: String(a.appid || d.appid), hash: d.market_hash_name, name: d.name || d.market_hash_name, type: d.type || '',
                d, assets: [], q: null, recv: 0, err: '', prefix: '', suffix: '', el: null };
        byHash.set(row.hash, row);
      }
      row.assets.push(a);
    }
    inv.rows = Array.from(byHash.values());
    drawInv();
    let done = 0, refused = 0;
    for (const row of inv.rows) {
      if (inv.stop) break;
      for (;;) {
        note.textContent = `Pricing ${done + 1} of ${inv.rows.length}…`;
        const fresh = !cacheGet(`sct:${row.appid}:${row.hash}`);
        try {
          const data = await fetchHistory(row.appid, row.hash);
          const fees = feesOf(row.d);
          row.prefix = data.prefix;
          row.suffix = data.suffix;
          row.q = quote(toPoints(data.prices), row.appid + '/' + row.hash, row.hash, fees);
          row.recv = receivedForBuyerPays(row.q.ask, fees);
          if (row.q.sold && !(S.item && S.item.hash === row.hash)) setBadge(row.hash, money(data.prefix, data.suffix, row.q.ask / 100));
          refused = 0;
          if (fresh) await sleep(INV_GAP);
        } catch (e) {
          if (e.rate && ++refused <= 3) {
            for (let s = 60 * refused; s > 0 && !inv.stop; s--) {
              note.textContent = `Steam is rate-limiting lookups. Trying again in ${s} s.`;
              await sleep(1000);
            }
            if (!inv.stop) continue;
          }
          row.err = e.rate ? 'rate-limited' : 'no history';
          if (e.rate) inv.stop = true;
        }
        break;
      }
      done++;
      const fresh = invRowEl(row);
      if (row.el) row.el.replaceWith(fresh);
      row.el = fresh;
    }
    // Most valuable first, once the prices are in.
    const worth = row => (row.q && row.q.sold ? row.recv * row.assets.length : -1);
    inv.rows.sort((a, b) => worth(b) - worth(a));
    drawInv();
    const priced = inv.rows.filter(r => r.q && r.q.sold);
    let copies = 0, cents = 0;
    for (const r of priced) { copies += r.assets.length; cents += r.recv * r.assets.length; }
    const first = priced[0];
    note.textContent = (refused > 3 ? 'Stopped: Steam is rate-limiting lookups. ' : inv.stop ? 'Stopped. ' : '') +
      `${priced.length} of ${inv.rows.length} priced` +
      (first ? ` · ${copies} ${copies === 1 ? 'copy' : 'copies'} would pay you ${money(first.prefix, first.suffix, cents / 100)}` : '') +
      ' · click one to list it';
    stop.textContent = 'close';
    inv.running = false;
  }

  // Two scripts answering the same keystroke would list a card twice. If the original
  // Sale History script is on this page as well, this one hides its panel and says so.
  function checkConflict() {
    if (conflict || !document.querySelector('.ssh-box')) return;
    conflict = true;
    inv.stop = true;
    if (box) box.style.display = 'none';
    document.body.appendChild(el('div', {
      class: 'sct-conflict',
      text: 'Steam Card Trader is paused on this page because the original Sale History script is running too. Turn one of them off in Violentmonkey, then reload.',
    }));
  }

  // First run: carry over the rules and saved prices kept by the original script.
  function migratePrefs() {
    if (pref('sct.migrated', '') === '1') return;
    try {
      const old = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('ssh.')) old.push(k);
      }
      for (const k of old) {
        const to = 'sct.' + k.slice(4);
        if (localStorage.getItem(to) === null) localStorage.setItem(to, localStorage.getItem(k));
      }
    } catch (e) { /* storage blocked */ }
    setPref('sct.migrated', '1');
  }

  function initInventory() {
    const panels = ['iteminfo0', 'iteminfo1'].map(id => document.getElementById(id)).filter(Boolean);
    if (!panels.length) return;
    migratePrefs();
    addStyle();
    const wi = window.g_rgWalletInfo;
    if (wi && wi.wallet_currency) {
      learnWallet({ cur: parseInt(wi.wallet_currency, 10), fees: {
        pct: parseFloat(wi.wallet_fee_percent) || 0.05, min: parseInt(wi.wallet_fee_minimum, 10) || 1, base: parseInt(wi.wallet_fee_base, 10) || 0,
      } });
    }
    ensureBox();
    for (const p of panels) { watch(p); update(p); }
    initGridHover();
    document.addEventListener('keydown', onKey);
    checkConflict();
    for (const ms of [600, 2000, 5000]) setTimeout(checkConflict, ms);
  }

  // --- market ---
  // The scanner. Its lookups go out without the Steam sign-in, a few seconds apart, and
  // it only ever reads: placing an order is left to the person, in Steam's own dialog.
  const STOP = new Error('stopped');
  const KINDS = { now: 'Buy now', top: 'Top bid', wait: 'Low bid' };
  const COLS = [
    ['name', 'Card', ''],
    ['kind', 'Order', 'Buy now: a listing is already cheap enough. Top bid: one cent over the best buy order still pays. ' +
      'Low bid: only a lower price pays, so the order waits behind the ones already there.'],
    ['buy', 'Buy at', 'The price to put in the buy order, and how many copies to try.'],
    ['sell', 'Sell at', 'Where the dearest quarter of the last 30 days\' sales went, unless the last 10 days fell short of it. ' +
      'Settings changes the quarter.'],
    ['profit', 'Profit', 'What the sell price leaves after Steam\'s fees, less the buy price, for one card.'],
    ['perDay', 'Sold a day', 'Units sold a day over the last 30 days.'],
    ['dip', 'Now vs month', 'The cheapest listing against the month\'s median sale price. Under zero is cheaper than usual.'],
    ['cycle', 'Whole trip', 'Days for the order to fill, plus the 7 days Steam holds a bought card, plus days to sell it.'],
    ['perMonth', 'A month', 'Profit × 30 ÷ the trip\'s days: what the money in one card earns in a month if every step goes to plan. In cents.'],
    ['', '', ''],
  ];
  const scan = { running: false, stop: false, done: 0, total: 0, note: '', error: '', what: 'scan', draw: () => drawStatus() };
  const view = { tab: 'buy', sort: 'perMonth', dir: -1, kind: '', text: '', msg: '' };
  let scanData = null;
  let dash = null;
  let helper = null;

  function loadScan() {
    if (!scanData) scanData = readJson('sct.scan', null) || { cards: {}, t: 0, cur: 0 };
    return scanData;
  }

  // Keep the scan small enough for local storage: nothing older than three days, and the
  // newest 2500 cards at most.
  function saveScan() {
    const d = loadScan(), cut = Date.now() - 3 * DAY;
    let keep = Object.values(d.cards).filter(r => r.t >= cut).sort((a, b) => b.t - a.t).slice(0, 2500);
    for (;;) {
      d.cards = {};
      for (const r of keep) d.cards[r.h] = r;
      if (writeJson('sct.scan', d) || !keep.length) return;
      keep = keep.slice(0, keep.length >> 1);
    }
  }

  // Wait a second at a time, so a stop is noticed and a countdown can be shown. job is what
  // is looking things up: the scan here, or the pack ranking on the Booster Pack Creator.
  async function hold(seconds, say, job = scan) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (job.stop) throw STOP;
      if (say) { job.note = say(Math.ceil((end - Date.now()) / 1000)); job.draw(); }
      await sleep(Math.min(1000, Math.max(0, end - Date.now())));
    }
  }

  // One lookup, tried again after a long wait when Steam says it has had too many.
  // state: {refused, job}, kept across one run's lookups.
  async function lookup(state, fn) {
    const job = state.job || scan;
    for (;;) {
      if (job.stop) throw STOP;
      try {
        const v = await fn();
        state.refused = 0;
        return v;
      } catch (e) {
        if (!e.rate) throw e;
        if (++state.refused > 3) {
          const err = new Error(`Steam kept refusing lookups, so the ${job.what} stopped. Leave it an hour before trying again.`);
          err.fatal = true;
          throw err;
        }
        await hold([120, 300, 900][state.refused - 1], s => `Steam is refusing lookups for now. Trying again in ${fmtSpan(s)}.`, job);
      }
    }
  }

  async function runScan() {
    if (scan.running) return;
    const o = opts(), data = loadScan(), state = { refused: 0 };
    Object.assign(scan, { running: true, stop: false, done: 0, total: 0, note: 'Finding the most-traded cards…', error: '' });
    drawStatus();
    const gap = () => hold(o.gap);
    let failed = 0;
    try {
      const found = [], seen = new Set();
      for (let start = 0; found.length < o.cards; start += 100) {
        const page = await lookup(state, () => marketCall(true, '/market/actions', 'Search', {
          appid: 753, filters: { item_class: ['item_class_2'] }, price: { eCurrency: wallet().cur || 1, unMin: o.bandMin, unMax: o.bandMax },
          accessoryFilters: {}, sort: 4, direction: 2, count: 100, start,
        }));
        const rows = (page && page.results) || [];
        for (const r of rows) {
          const d = r.asset_description || {};
          if (!r.strHash || seen.has(r.strHash)) continue;
          seen.add(r.strHash);
          found.push({ h: r.strHash, n: d.name || r.strHash, g: String(d.type || '').replace(/ Trading Card$/, '') });
        }
        if (!rows.length || start + rows.length >= (page.total_count || 0)) break;
        await gap();
      }
      found.length = Math.min(found.length, o.cards);
      scan.total = found.length;
      for (const f of found) {
        const old = data.cards[f.h];
        // Looked up within the hour and fine: a stopped scan picks up where it left off.
        if (!(old && !old.err && Date.now() - old.t < 3600000)) {
          scan.note = f.g ? `${f.g} · ${f.n}` : f.n;
          drawStatus();
          try {
            const rec = await lookup(state, () => loadCard(true, f.h, gap));
            data.cards[f.h] = Object.assign(rec, f, { t: Date.now() });
            data.cur = rec.cur;
            failed = 0;
          } catch (e) {
            if (e === STOP || e.fatal) throw e;
            data.cards[f.h] = Object.assign({}, f, { t: Date.now(), err: e.message });
            if (++failed >= 5) throw new Error(`Five lookups failed in a row (${e.message}). Check the connection, then scan again.`);
          }
          await gap();
        }
        scan.done++;
        if (scan.done % 10 === 0) saveScan();
        if (scan.done % 5 === 0) drawView();
        drawStatus();
      }
    } catch (e) {
      if (e !== STOP) scan.error = e.message;
    }
    if (scan.done) data.t = Date.now();
    saveScan();
    Object.assign(scan, { running: false, stop: false, note: '' });
    drawDash();
  }

  // Fees for the currency a scan came back in: the wallet's own when it is the wallet's currency.
  function scanFees(cur) {
    return cur === wallet().cur ? feesNow() : CARD_FEES;
  }

  // Every scanned card with an order worth placing under the current settings and filters.
  function buyRows() {
    const d = loadScan(), o = opts(), fees = scanFees(d.cur), mine = ledger();
    const rows = [];
    for (const rec of Object.values(d.cards)) {
      if (rec.err || !rec.lv) continue;
      const plan = planFlip(cardOf(rec), o, fees);
      if (!plan || plan.perDay < o.minPerDay) continue;
      if (view.kind && plan.kind !== view.kind) continue;
      if (view.text && !`${rec.n} ${rec.g}`.toLowerCase().includes(view.text)) continue;
      rows.push({ rec, plan, dip: plan.median ? (plan.low - plan.median) / plan.median : 0, mine: mine[rec.h] });
    }
    const key = view.sort;
    const val = r => (key === 'name' ? r.rec.n.toLowerCase() : key === 'dip' ? r.dip : r.plan[key]);
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * view.dir;
    });
    return rows;
  }

  function openDash() {
    if (dash) return;
    addStyle();
    dash = el('div', { class: 'sct-dash' }, el('div', { class: 'sct-dash-in' },
      el('div', { class: 'sct-dh' }, el('h1', { text: 'Card Trader' }),
        el('a', { class: 'sct-btn sct-go', onclick: () => { if (scan.running) scan.stop = true; else runScan(); drawStatus(); } }),
        el('a', { class: 'sct-btn', text: 'Close', onclick: closeDash })),
      el('div', { class: 'sct-status' }), el('div', { class: 'sct-bar' }, el('i')), el('div', { class: 'sct-notes' }),
      el('div', { class: 'sct-tabs' }), el('div', { class: 'sct-view' })));
    dash.dataset.overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(dash);
    drawDash();
  }

  // Closing the dashboard leaves a running scan going in this tab.
  function closeDash() {
    if (!dash) return;
    document.documentElement.style.overflow = dash.dataset.overflow || '';
    dash.remove();
    dash = null;
  }

  function drawStatus() {
    if (!dash) return;
    const d = loadScan(), o = opts(), w = wallet(), n = Object.keys(d.cards).length;
    const go = dash.querySelector('.sct-go');
    go.textContent = scan.running ? (scan.stop ? 'Stopping…' : 'Stop the scan') : n ? 'Scan again' : 'Scan';
    go.classList.toggle('go', !scan.running);
    let text;
    if (scan.running) {
      const left = (scan.total - scan.done) * 2 * o.gap;
      text = scan.total ? `Scanning ${scan.done} of ${scan.total}` + (left > 0 ? ` · about ${fmtSpan(left)} left` : '') : '';
      if (scan.note) text += (text ? ' · ' : '') + scan.note;
    } else if (scan.error) {
      text = scan.error;
    } else if (n) {
      const when = new Date(d.t || Date.now()).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      text = `Last scan ${when} · ${n} cards on file · prices in ${currencyOf(d.cur)[2]}`;
    } else {
      text = `No scan yet. A scan looks up the ${o.cards} most-traded cards in your price range, two lookups each: about ${fmtSpan(o.cards * 2 * o.gap)}.`;
    }
    dash.querySelector('.sct-status').textContent = text;
    dash.querySelector('.sct-bar i').style.width = scan.running && scan.total ? `${scan.done / scan.total * 100}%` : '0';
    const notes = [];
    if (d.cur && w.cur && d.cur !== w.cur) {
      notes.push(`These prices are in ${currencyOf(d.cur)[2]}, not your wallet's ${currencyOf(w.cur)[2]}: Steam saw the scan come from another ` +
        `country, which is what a VPN does. The ranking still holds. Each card's own page works out the exact price in ${currencyOf(w.cur)[2]}.`);
    }
    if (scan.running) notes.push('Keep this tab in view while it scans. Browsers slow a hidden tab to about one lookup a minute.');
    dash.querySelector('.sct-notes').replaceChildren(...notes.map(t => el('div', { class: 'sct-note', text: t })));
  }

  function drawTabs() {
    const defs = [['buy', `Orders worth placing (${buyRows().length})`], ['paid', `What you paid (${Object.keys(ledger()).length})`], ['set', 'Settings']];
    dash.querySelector('.sct-tabs').replaceChildren(...defs.map(([key, label]) =>
      el('a', { class: view.tab === key ? 'active' : '', text: label, onclick: () => { view.tab = key; drawDash(); } })));
  }

  function drawDash() {
    if (!dash) return;
    drawStatus();
    drawTabs();
    const v = dash.querySelector('.sct-view');
    v.replaceChildren();
    if (view.tab === 'paid') drawLedger(v);
    else if (view.tab === 'set') drawSettings(v);
    else drawBuy(v);
  }

  // Fresh numbers, without rebuilding the filter boxes someone may be typing in.
  function drawView() {
    if (!dash) return;
    drawTabs();
    if (view.tab === 'buy') drawTable();
  }

  function drawBuy(v) {
    const kind = el('select', { 'aria-label': 'Kind of order', onchange: e => { view.kind = e.target.value; drawView(); } },
      el('option', { value: '', text: 'Every kind of order' }),
      Object.keys(KINDS).map(k => el('option', { value: k, text: KINDS[k], selected: view.kind === k })));
    const text = el('input', { type: 'search', placeholder: 'Card or game', 'aria-label': 'Filter by card or game', value: view.text,
                               oninput: e => { view.text = e.target.value.trim().toLowerCase(); drawView(); } });
    v.append(
      el('div', { class: 'sct-filters' }, kind, text, el('span', { class: 'sct-rule' }),
        el('a', { text: 'Change', onclick: () => { view.tab = 'set'; drawDash(); } })),
      el('div', { class: 'sct-tablewrap' }));
    drawTable();
  }

  function drawTable() {
    const wrap = dash && dash.querySelector('.sct-tablewrap');
    if (!wrap) return;
    const d = loadScan(), o = opts(), rows = buyRows(), n = Object.keys(d.cards).length;
    const $ = c => centsText(d.cur || wallet().cur || 1, c);
    const paid = c => centsText(wallet().cur || d.cur, c);
    dash.querySelector('.sct-rule').textContent = `Orders that profit ${$(o.minProfit)} or more, on cards selling ${o.minPerDay} or more a day.`;
    if (!rows.length) {
      wrap.replaceChildren(el('div', { class: 'sct-empty', text: scan.running ? 'Orders show up here as the cards are looked up.'
        : !n ? 'Nothing scanned yet. Press Scan.'
        : `None of the ${n} cards on file has an order that clears the fees with these settings and filters. ` +
          'Loosen them under Settings, or scan again later: gaps open when a sale or a new game floods a card.' }));
      return;
    }
    const sortBy = key => {
      if (view.sort === key) view.dir = -view.dir;
      else { view.sort = key; view.dir = key === 'name' || key === 'cycle' ? 1 : -1; }
      drawTable();
    };
    const head = el('tr', {}, COLS.map(([key, label, tip]) => el('th', {
      class: view.sort === key && key ? 'sorted' : '', title: tip, onclick: key ? () => sortBy(key) : null,
      text: label + (view.sort === key && key ? (view.dir < 0 ? ' ▾' : ' ▴') : ''),
    })));
    const body = rows.slice(0, 400).map(({ rec, plan: p, dip, mine }) => el('tr', {},
      el('td', { class: 'name', title: `${rec.n} · ${rec.g}` },
        el('a', { href: cardUrl(rec.h), target: '_blank', rel: 'noopener', text: rec.n }),
        el('i', { text: rec.g + (mine ? ` · your order ${paid(mine.buy)}` : '') })),
      el('td', {}, el('span', { class: 'sct-tag ' + p.kind, text: KINDS[p.kind] })),
      el('td', {}, el('b', { text: $(p.buy) }), el('span', { class: 'sct-dim', text: ' ×' + p.qty })),
      el('td', { text: $(p.sell) }),
      el('td', {}, el('span', { class: 'sct-ok', text: '+' + $(p.profit) }), el('span', { class: 'sct-dim', text: ` ${Math.round(p.roi * 100)}%` })),
      el('td', { text: fmtRate(p.perDay) }),
      el('td', { class: dip < -0.005 ? 'sct-ok' : 'sct-dim', text: fmtTrend(dip) }),
      el('td', { title: `${fmtDays(p.fillDays)} to fill + ${HOLD_DAYS} d held + ${fmtDays(p.sellDays)} to sell`, text: fmtDays(p.cycle) }),
      el('td', {}, el('b', { text: p.perMonth.toFixed(1) + '¢' })),
      el('td', {}, el('a', { class: 'sct-btn small go', href: cardUrl(rec.h) + '?buy=1#sct', target: '_blank', rel: 'noopener',
                             title: 'Open this card with Steam\'s buy box showing and the price put in', text: 'Open' }))));
    wrap.replaceChildren(el('table', { class: 'sct-t' }, el('thead', {}, head), el('tbody', {}, body)));
    if (rows.length > 400) wrap.append(el('div', { class: 'sct-empty', text: `Showing the first 400 of ${rows.length}.` }));
  }

  function drawLedger(v) {
    const l = ledger(), o = opts(), fees = feesNow(), cur = wallet().cur || loadScan().cur || 1;
    const $ = c => centsText(cur, c);
    const read = el('a', { class: 'sct-btn small', text: 'Read my buy orders from Steam', onclick: async () => {
      if (signedOut()) view.msg = 'Sign in to Steam first.';
      else {
        try {
          const n = await syncOrders();
          view.msg = `Read ${n} open ${n === 1 ? 'order' : 'orders'} on Steam items.`;
        } catch (e) { view.msg = e.message; }
      }
      drawDash();
    } });
    v.append(el('div', { class: 'sct-filters' },
      el('span', { text: 'What each card cost you. In the inventory, a card on this list will not open below the price that still profits.' }),
      read, el('span', { text: view.msg })));
    view.msg = '';
    const rows = Object.entries(l).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
    if (!rows.length) {
      v.append(el('div', { class: 'sct-empty', text: 'Nothing on file yet. Your buy orders are read from Steam when you open a card\'s page, ' +
        'and you can type what you paid into the inventory panel.' }));
      return;
    }
    const from = { steam: 'your buy orders', order: 'noted on its page', manual: 'typed in' };
    v.append(el('table', { class: 'sct-t' },
      el('thead', {}, el('tr', {}, ['Card', 'Paid', 'Copies', 'Sell for at least', 'From', 'Noted', ''].map(t => el('th', { text: t, style: 'cursor:default' })))),
      el('tbody', {}, rows.map(([hash, e]) => el('tr', {},
        el('td', { class: 'name' }, el('a', { href: cardUrl(hash), target: '_blank', rel: 'noopener', text: e.name || hash })),
        el('td', {}, el('b', { text: $(e.buy) })),
        el('td', { text: String(e.qty || 1) }),
        el('td', { text: $(askToClear(e.buy, FLOOR_PROFIT, fees)) }),
        el('td', { class: 'sct-dim', text: from[e.src] || '' }),
        el('td', { class: 'sct-dim', text: e.t ? new Date(e.t).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '' }),
        el('td', {}, el('a', { text: 'forget', onclick: () => { dropCost(hash); drawDash(); } })))))));
  }

  function drawSettings(v) {
    const o = opts();
    const num = (key, step) => el('input', { type: 'number', step: step || 1, min: OPTS[key][1], value: o[key], 'aria-label': key,
                                             onchange: e => { setOpt(key, parseFloat(e.target.value)); drawDash(); } });
    const share = el('select', { 'aria-label': 'Sell target', onchange: e => { setOpt('share', parseFloat(e.target.value)); drawDash(); } },
      [[0.5, 'Cautious: half the month\'s sales reached it'], [0.25, 'Balanced: a quarter reached it'], [0.1, 'Hopeful: a tenth reached it']]
        .map(([val, label]) => el('option', { value: val, text: label, selected: Math.abs(o.share - val) < 1e-9 })));
    v.append(el('div', { class: 'sct-set' },
      el('label', { text: 'Least profit on a card, in cents' }), num('minProfit'),
      el('label', { text: 'Sell target' }), share,
      el('label', { text: 'Most copies in one order' }), num('maxQty'),
      el('label', { text: 'Hide cards selling fewer than this a day' }), num('minPerDay'),
      el('p', { text: 'Those four apply at once to what is already scanned.' }),
      el('label', { text: 'Cheapest card to scan, in cents' }), num('bandMin'),
      el('label', { text: 'Dearest card to scan, in cents' }), num('bandMax'),
      el('label', { text: 'Cards in one scan' }), num('cards', 10),
      el('label', { text: 'Seconds between lookups' }), num('gap', 0.5),
      el('p', { text: `A scan takes the most-traded cards in that price range, two lookups each, sent without your Steam sign-in. ` +
        `With these numbers it runs about ${fmtSpan(o.cards * 2 * o.gap)}. Under about 10 cents the fee minimums leave nothing, ` +
        'which is why the range starts at 15.' })));
  }

  // ---- one card's page ----
  function listingHash() {
    const m = /^\/market\/listings\/753\/([^/?#]+)/.exec(location.pathname);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return null; }
  }

  function unmountHelper() {
    if (!helper) return;
    clearInterval(helper.timer);
    helper.root.remove();
    helper = null;
  }

  async function mountHelper(hash) {
    unmountHelper();
    const body = el('div', { class: 'sct-cb', text: 'Reading the order book…' });
    const root = el('div', { class: 'sct-card' + (pref('sct.card', '1') === '1' ? '' : ' shut') },
      el('div', { class: 'sct-ch' }, el('b', { text: 'Card Trader' }),
        el('a', { href: traderUrl(), target: '_blank', rel: 'noopener', text: 'Scanner ↗' }),
        el('a', { title: 'Fold or unfold', text: '▾', onclick: () => setPref('sct.card', root.classList.toggle('shut') ? '0' : '1') })),
      body);
    document.body.appendChild(root);
    const me = helper = { hash, root, body, rec: null, plan: null, auto: /(^|[#&])sct\b/.test(location.hash), filled: '', open: false,
                          gone: 0, syncing: false, autoDone: false, t0: Date.now(), vpn: '', timer: 0 };
    try {
      me.rec = await loadCard(false, hash);
      if (helper !== me) return;
      const signedIn = !signedOut();
      if (signedIn) learnWallet({ cur: me.rec.cur });
      me.plan = planFlip(cardOf(me.rec), opts(), feesNow());
      drawHelper();
      me.timer = setInterval(watchBuyBox, 500);
      if (signedIn) {
        syncOrders().then(() => { if (helper === me) drawHelper(); }, () => { /* the panel works without it */ });
        checkVpn(me);
      }
    } catch (e) {
      if (helper === me) body.textContent = e.message;
    }
  }

  function drawHelper() {
    const me = helper;
    if (!me || !me.rec) return;
    const p = me.plan, o = opts(), fees = feesNow(), mine = ledger()[me.hash];
    const $ = c => centsText(me.rec.cur, c);
    const kids = [];
    if (p) {
      kids.push(el('div', { class: 'sct-big' }, `Buy at ${$(p.buy)}`, el('span', { class: 'sct-tag ' + p.kind, text: KINDS[p.kind] })));
      kids.push(el('p', {}, 'Sell at ', el('b', { text: $(p.sell) }), ', keep ', el('b', { text: $(p.net) }), ' after fees: ',
        el('b', { class: 'sct-ok', text: `+${$(p.profit)} a card` }), ` (${Math.round(p.roi * 100)}%).`));
      kids.push(el('p', { text: p.kind === 'now' ? `${p.avail} listed at this price now, so an order at it fills at once.`
        : p.kind === 'top' ? 'One cent over the best buy order, so the next person who sells into the orders sells to you.'
        : `The most worth paying. Steam fills the oldest order first, and ${p.ahead.toLocaleString()} at or above this are ahead, so it fills only on a dip.` }));
      const fill = p.kind === 'now' ? '' : isFinite(p.fillDays) ? `Should fill in ${daysText(p.fillDays)}. ` : 'Nothing has sold this low in 30 days. ';
      const sell = isFinite(p.sellDays) ? `it should take ${daysText(p.sellDays)} to sell` : 'there is no sign yet that it sells at that price';
      kids.push(el('p', { text: `${fill}Steam holds a bought card ${HOLD_DAYS} days, then ${sell}. It sells ${fmtRate(p.perDay)} a day. ` +
        `Try ${p.qty} ${p.qty === 1 ? 'copy' : 'copies'}.` }));
    } else {
      const c = cardOf(me.rec);
      kids.push(el('p', {}, el('b', { text: 'No buy price clears the fees here right now.' })));
      if (c.bids.length && c.asks.length) {
        kids.push(el('p', { text: `Best buy order ${$(c.bids[0].c)}, cheapest listing ${$(c.asks[0].c)}. ` +
          `A sale at ${$(c.asks[0].c)} pays ${$(receivedForBuyerPays(c.asks[0].c, fees))} after fees.` }));
      }
    }
    if (me.vpn) {
      kids.push(el('p', { class: 'sct-warn', text: `A VPN looks to be on: Steam quotes a signed-out visitor ${me.vpn} from here. ` +
        'Its agreement forbids hiding where you are, so turn the VPN off before you place an order.' }));
    }
    if (mine) {
      kids.push(el('p', {}, 'On file: ', el('b', { text: `${$(mine.buy)} × ${mine.qty || 1}` }), '. In the inventory it will not open under ',
        el('b', { text: $(askToClear(mine.buy, FLOOR_PROFIT, fees)) }), '. ', el('a', { text: 'Forget', onclick: () => { dropCost(me.hash); drawHelper(); } })));
    }
    if (me.filled === 'ok') kids.push(el('p', { class: 'sct-ok', text: 'Price set in Steam\'s buy box. Check it, then place the order yourself.' }));
    if (me.filled === 'fail' && p) kids.push(el('p', { class: 'sct-warn', text: `Could not set the price. Type ${(p.buy / 100).toFixed(2)} into Steam's buy box.` }));
    if (me.filled === 'nobox') kids.push(el('p', { class: 'sct-warn', text: 'Open Steam\'s buy box first.' }));
    if (signedOut()) kids.push(el('p', { class: 'sct-dim', text: 'Sign in to Steam to place an order.' }));
    else if (p) {
      kids.push(el('div', { class: 'sct-acts' },
        me.open ? el('a', { class: 'sct-btn small go', text: `Put ${$(p.buy)} in the buy box`, onclick: () => fillBuyBox(true) })
                : el('a', { class: 'sct-btn small go', text: `Open the buy box at ${$(p.buy)}`, onclick: openBuyBox }),
        el('a', { class: 'sct-btn small', text: 'Note this order', title: 'Keep the price for the inventory. Your open orders are also read from Steam.',
                  onclick: noteOrder })));
    }
    me.body.replaceChildren(...kids);
  }

  // Steam opens its buy box only when a card's page itself loads with ?buy=1, which is
  // how the scanner's Open gets there. A link to that address from inside the page does
  // not do it: Steam's pages handle a change of address themselves, without loading
  // anything, and a tab already on the address does nothing at all. So put the address in
  // place quietly and load the page afresh. Loading is all this does: it never presses
  // anything of Steam's.
  function openBuyBox() {
    const me = helper;
    if (!me) return;
    history.replaceState(history.state, '', cardUrl(me.hash) + '?buy=1#sct');
    location.reload();
  }

  // Steam's buy box, if it is open: {price, qty}. It is told apart by its shape: exactly one
  // box holding an amount of money, followed by one holding a whole number. A box with
  // two amounts, as a sell box has, is never taken for it.
  function findBuyBoxes() {
    const all = Array.from(document.querySelectorAll('input')).filter(i =>
      !i.closest('.sct-card, .sct-dash') && i.offsetParent !== null && !/^(checkbox|radio|hidden|search|range)$/.test(i.type));
    const inDialog = all.filter(i => i.closest('dialog, [role="dialog"], [aria-modal="true"]'));
    const pool = inDialog.length ? inDialog : all;
    const money = pool.filter(i => /\d[.,]\d\d(?!\d)/.test(i.value));
    const qty = money.length === 1 ? pool.slice(pool.indexOf(money[0]) + 1).find(i => /^\d+$/.test(i.value.trim())) : null;
    return qty ? { price: money[0], qty } : { price: null, qty: null };
  }

  // Steam opens its buy box on the cheapest listing's price. A box that starts anywhere
  // else is not filled in unasked.
  function startsAtAsk(me, input) {
    const v = parseMoney(input.value);
    const cents = v == null ? null : Math.round(v * 100);
    return cardOf(me.rec).asks.slice(0, 3).some(a => a.c === cents);
  }

  // Read the buy orders again a moment from now, once however often it is asked for.
  function resync(me) {
    if (me.syncing || signedOut()) return;
    me.syncing = true;
    setTimeout(() => syncOrders().catch(() => { /* keep what is on file */ }).then(() => {
      me.syncing = false;
      if (helper === me) drawHelper();
    }), 2500);
  }

  // Type into a box that React controls: set the value underneath React, then tell it.
  function typeInto(input, text) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  // Put the plan's price, and its quantity, into Steam's buy box. Nothing here presses
  // Steam's button: the order is the person's to place.
  async function fillBuyBox(asked) {
    const me = helper;
    if (!me || !me.plan) return;
    const boxes = findBuyBoxes();
    if (!boxes.price) {
      if (asked) { me.filled = 'nobox'; drawHelper(); }
      return;
    }
    typeInto(boxes.price, moneyLike(boxes.price.value, me.plan.buy));
    if (boxes.qty && me.plan.qty > 1) typeInto(boxes.qty, String(me.plan.qty));
    await sleep(300);
    if (helper !== me) return;
    // Steam rewrites the box from what it understood, so reading it back is the check.
    const got = parseMoney(boxes.price.value);
    me.filled = got != null && Math.round(got * 100) === me.plan.buy ? 'ok' : 'fail';
    drawHelper();
  }

  function watchBuyBox() {
    const me = helper;
    if (!me) return;
    const boxes = findBuyBoxes();
    // A box being typed in stops looking like a price for a moment, so it only counts as
    // closed once it has been gone a second and a half.
    me.gone = boxes.price ? 0 : me.gone + 1;
    const open = boxes.price ? true : me.gone >= 3 ? false : me.open;
    if (open === me.open) return;
    me.open = open;
    if (!open) {
      // What was said about the box no longer holds once it has closed. It may have
      // closed because an order went in, so read the orders again.
      me.filled = '';
      drawHelper();
      resync(me);
      return;
    }
    // Unasked, the price goes in once, and only where the scanner's Open or this panel's
    // button led: Steam's own buy box, opened with the page and still on the cheapest
    // listing's price.
    if (me.auto && !me.autoDone && Date.now() - me.t0 < 20000 && startsAtAsk(me, boxes.price)) {
      me.autoDone = true;
      fillBuyBox(false);
    } else {
      drawHelper();
    }
  }

  // Keep the price for the inventory by hand: what is in Steam's buy box if it is open, else the plan's.
  function noteOrder() {
    const me = helper;
    if (!me) return;
    const boxes = findBuyBoxes();
    const typed = boxes.price ? parseMoney(boxes.price.value) : null;
    const buy = typed != null ? Math.round(typed * 100) : me.plan ? me.plan.buy : 0;
    if (!(buy >= 1)) return;
    const qty = boxes.qty && parseInt(boxes.qty.value, 10) > 0 ? parseInt(boxes.qty.value, 10) : me.plan ? me.plan.qty : 1;
    setCost(me.hash, { buy, qty, name: document.title.replace(/\s+-\s+Steam Community Market$/, '') || me.hash, src: 'order' });
    drawHelper();
  }

  // A scan run through a VPN comes back in another currency. If the last one did, see
  // whether the VPN is still on before an order goes in.
  async function checkVpn(me) {
    const d = loadScan(), w = wallet();
    if (!d.cur || !w.cur || d.cur === w.cur) return;
    try {
      const ob = await marketCall(true, '/market/orderbook', 'Load', 753, me.hash);
      const cur = ob && ob.data && ob.data.eCurrency;
      if (helper === me && cur && cur !== w.cur) { me.vpn = currencyOf(cur)[2]; drawHelper(); }
    } catch (e) { /* no warning without an answer */ }
  }

  function initMarket() {
    addStyle();
    document.body.appendChild(el('a', { class: 'sct-launch', text: 'Card Trader', title: 'Find cards worth a buy order', onclick: openDash }));
    let seen;
    const tick = () => {
      // Steam's market changes pages without reloading, so watch the address.
      const hash = listingHash();
      if (hash !== seen) {
        seen = hash;
        if (hash) mountHelper(hash); else unmountHelper();
      }
      if (location.hash === '#card-trader') {
        history.replaceState(history.state, '', location.pathname + location.search);
        openDash();
      }
    };
    tick();
    setInterval(tick, 1000);
  }
  // --- end market ---

  // --- booster creator ---
  // On Steam's Booster Pack Creator: which of the account's games makes a pack worth more than
  // the gems it costs. The games come from Steam's own page. Each pack is looked up without the
  // Steam sign-in, a few seconds apart. Nothing here makes, lists or buys a pack: a pack is made
  // with Steam's own button, by the person.
  const PACK_FRESH = 3600000;
  const PACK_TOP = 10;
  const PACK_COLS = [
    ['name', 'Game', ''],
    ['gems', 'Gems', 'What Steam charges in gems for one pack, and what those gems would fetch sold as Sacks of Gems.'],
    ['bid', 'Buy order', 'The best buy order for the pack, and how many packs the buy orders want in all.'],
    ['now', 'Sell now', 'Sold to that buy order: what you keep after Steam\'s fees, less what the gems are worth.'],
    ['ask', 'Listing', 'The cheapest pack for sale, and how many are listed.'],
    ['listed', 'List it', 'Listed one cent under the cheapest listing, but never above what packs have sold for: what you keep after fees, less the gems, once it sells.'],
    ['sold', 'Sold, 7 days', 'Packs sold in the last 7 days, and the price half of them went at or under. When none sold this week, how many sold in the last ' +
      `year. Looked up for the top ${PACK_TOP} rows, and for every pack with no buy orders or that would pay listed.`],
    ['', '', ''],
  ];
  const VERDICTS = {
    pays: ['now', 'Pays', 'A pack sold to the best buy order is worth more than its gems.'],
    listed: ['top', 'Only listed', 'No buy order pays enough to cover the gems. Listed at what packs have sold for, it pays, but only once someone buys it: Sold shows how often that happens.'],
    even: ['wait', 'Breaks even', 'A pack fetches about what its gems would.'],
    loses: ['lose', 'Loses money', 'The gems are worth more sold as gems than made into this pack.'],
    gone: ['off', 'Not on the market', 'Steam\'s market has no packs of this game. A pack you make would have no one to sell to.'],
    empty: ['off', 'Not on the market', 'Nobody is selling or buying this pack, and none sold in the last year. A pack you make would have no one to sell to.'],
    unsold: ['off', 'Not selling', 'Some are listed, but nobody has a buy order and none sold in the last year. A pack you list may never sell.'],
    stale: ['off', 'Not selling', 'Listed, it would pay, but none sold in the last year, and no buy order covers the gems. A pack you list may never sell.'],
  };
  const packJob = { running: false, stop: false, done: 0, total: 0, note: '', error: '', what: 'ranking', draw: () => drawPackStatus() };
  const packView = { sort: 'now', dir: -1 };
  let packBox = null, packData = null, creatorText = null, creatorSig = '';

  // What was looked up, kept in local storage: {gem: {t, bid, ask, cur}, games: {appid: {t,
  // h (the pack's market name), b and a (best buy order, cheapest listing), cb and cs (how many
  // of each), cur, then for the top rows and any pack with no buy orders or that would pay listed:
  // s7 and m7, sy and my (units sold in the last week and year, and their medians), lt and lp
  // (when the last one sold, and its price), hc and ht (the sales' currency, when looked up), or hx
  // when that lookup failed}}}. A game with no pack on the market is {t, none}, a failed lookup
  // {t, err}.
  function loadPacks() {
    if (!packData) packData = readJson('sct.packs', null) || { gem: null, games: {} };
    return packData;
  }

  function savePacks() {
    const d = loadPacks(), cut = Date.now() - 3 * DAY;
    for (const id of Object.keys(d.games)) if (!(d.games[id].t >= cut)) delete d.games[id];
    writeJson('sct.packs', d);
  }

  // Looked up within the hour, in the currency gems were last priced in.
  function freshPack(rec, d) {
    return !!rec && !rec.err && (!!rec.none || (!!d.gem && rec.cur === d.gem.cur)) && Date.now() - rec.t < PACK_FRESH;
  }

  // The looked-up packs that can be set against the gems: those priced in the gems' currency.
  function packRecs(info, d) {
    const recs = {};
    for (const g of info.games) {
      const r = d.games[g.appid];
      if (r && (r.err || r.none || (d.gem && r.cur === d.gem.cur))) recs[g.appid] = r;
    }
    return recs;
  }

  // The account's games: from Steam's own script when this one can see it, since that keeps up
  // as packs are made, else from the page's text. {games, goo, live}, or null.
  function readCreator() {
    const page = window.CBoosterCreatorPage;
    const games = page && page.sm_rgBoosterData ? creatorGames(page.sm_rgBoosterData) : [];
    if (games.length) {
      const num = k => (isFinite(parseFloat(page[k])) ? parseFloat(page[k]) : null);
      const goo = num('sm_flUserGooAmount') == null ? null : {
        total: num('sm_flUserGooAmount'), tradable: num('sm_flUserTradableGooAmount'), untradable: num('sm_flUserUntradableGooAmount'),
      };
      return { games, goo, live: true };
    }
    if (!creatorText) {
      for (const s of document.querySelectorAll('script:not([src])')) {
        const r = parseCreatorInit(s.textContent);
        if (r) { creatorText = r; break; }
      }
    }
    return creatorText ? Object.assign({ live: false }, creatorText) : null;
  }

  // Why nothing can be ranked, or '' when something can.
  function creatorProblem(info) {
    if (!info) return 'Could not read your games from this page. Steam may have changed it, so nothing can be ranked.';
    return info.games.length ? '' : 'Steam lists no games on this page that you can make packs of.';
  }

  function creatorSignature(info) {
    return info ? info.games.filter(g => g.cool).map(g => g.appid).join() + '|' + (info.goo ? `${info.goo.total}/${info.goo.tradable}` : '') : '';
  }

  // Steam marks a game unavailable as soon as a pack of it is made, and changes the gem count.
  function watchCreator() {
    const sig = creatorSignature(readCreator());
    if (sig === creatorSig) return;
    creatorSig = sig;
    drawPacks();
  }

  // One game's pack: its order book, under its usual market name or else the one a search finds.
  // call is a lookup that keeps the gap between requests.
  async function loadPack(g, old, call) {
    let hash = (old && old.h) || boosterHash(g.appid, g.name);
    let ob = await call('/market/orderbook', 'Load', 753, hash);
    if (!(ob && ob.success && ob.data)) {
      const page = await call('/market/actions', 'Search', {
        appid: 753, filters: { item_class: ['item_class_5'], Game: [`app_${g.appid}`] }, accessoryFilters: {}, sort: 4, direction: 2, count: 10, start: 0,
      });
      const found = ((page && page.results) || []).map(r => r && r.strHash).filter(Boolean);
      const pick = found.find(h => h.startsWith(`${g.appid}-`)) || (found.length === 1 ? found[0] : null);
      if (!pick) return { t: Date.now(), none: true };
      if (pick !== hash) {
        hash = pick;
        ob = await call('/market/orderbook', 'Load', 753, hash);
      }
      // The search lists it, yet Steam answers for its order book as if it did not exist (seen on
      // 2026-11-28). That is no failed connection, so it does not count towards stopping.
      if (!(ob && ob.success && ob.data)) return { t: Date.now(), h: hash, err: 'Steam sent no order book for this pack.' };
    }
    const book = ob.data, tops = bookTops(book);
    return { t: Date.now(), h: hash, b: tops.bid || 0, a: tops.ask || 0, cb: book.cBuyOrders || 0, cs: book.cSellOrders || 0, cur: book.eCurrency };
  }

  async function runPacks() {
    if (packJob.running) return;
    const info = readCreator();
    if (creatorProblem(info)) {
      packJob.error = creatorProblem(info);
      drawPackStatus();
      return;
    }
    const o = opts(), d = loadPacks(), state = { refused: 0, job: packJob };
    // Each request waits until the gap since the last one has passed.
    let last = 0;
    const call = async (path, method, ...args) => {
      const wait = last + o.gap * 1000 - Date.now();
      if (wait > 0) await hold(wait / 1000, null, packJob);
      try { return await marketCall(true, path, method, ...args); } finally { last = Date.now(); }
    };
    // Games a pack can be made of today go first, so the rows that matter fill in first.
    const games = info.games.slice().sort((a, b) => a.cool - b.cool);
    Object.assign(packJob, { running: true, stop: false, done: 0, total: games.length + 1, note: 'What gems sell for', error: '' });
    drawPackStatus();
    let failed = 0;
    try {
      const ob = await lookup(state, () => call('/market/orderbook', 'Load', 753, SACK_HASH));
      const book = ob && ob.success && ob.data, tops = bookTops(book);
      if (!tops.bid) throw new Error('Steam sent no buy orders for Sacks of Gems, so gems cannot be priced. Try again later.');
      d.gem = { t: Date.now(), bid: tops.bid, ask: tops.ask, cur: book.eCurrency };
      packJob.done++;
      drawPacks();
      for (const g of games) {
        const old = d.games[g.appid];
        if (!freshPack(old, d)) {
          packJob.note = g.name;
          drawPackStatus();
          try {
            d.games[g.appid] = await lookup(state, () => loadPack(g, old, call));
            failed = 0;
          } catch (e) {
            if (e === STOP || e.fatal) throw e;
            d.games[g.appid] = { t: Date.now(), err: e.message, h: old && old.h };
            if (++failed >= 5) throw new Error(`Five lookups failed in a row (${e.message}). Check the connection, then rank again.`);
          }
        }
        packJob.done++;
        if (packJob.done % 10 === 0) savePacks();
        if (packJob.done % 5 === 0) drawPackTable();
        drawPackStatus();
      }
      // Past sales, one lookup each that holds the whole history: for the rows at the top; for
      // every pack nobody has a buy order for, which is on the market only if some sold in the
      // last year; and for every pack whose listing would show a profit, which is never priced
      // above what packs sold for. Each is a much larger lookup.
      const fees = scanFees(d.gem.cur);
      const ranked = rankPacks(games, packRecs(info, d), gemCents(d.gem.bid, fees), fees);
      const check = ranked.filter(x => x.market && x.market !== 'gone' && (!(x.r.b > 0) || (x.net && x.net.listed > 0)));
      const top = [...new Set(ranked.filter(x => x.net).slice(0, PACK_TOP).concat(check))]
        .filter(x => !(x.r.ht && x.r.sy != null && Date.now() - x.r.ht < PACK_FRESH && x.r.hc === d.gem.cur));
      packJob.total += top.length;
      for (const x of top) {
        packJob.note = `Past sales · ${x.g.name}`;
        drawPackStatus();
        try {
          const ph = await lookup(state, () => call('/market/actions', 'QueryPriceHistory', 753, x.r.h));
          // No list of sales at all is a failed lookup, not "none sold": the pack stays unjudged.
          if (!(ph && Array.isArray(ph.prices))) throw new Error('Steam sent no sales for this pack.');
          const points = apiPoints(ph.prices), now = Date.now(), last = lastSale(points);
          const week = recentSales(points, 7, now), year = recentSales(points, MARKET_DAYS, now);
          Object.assign(x.r, {
            s7: week.units, m7: week.median, sy: year.units, my: year.median,
            lt: last && last.t, lp: last && last.price, hc: ph.ecurrency, ht: now,
          });
          delete x.r.hx;
        } catch (e) {
          if (e === STOP || e.fatal) throw e;
          x.r.hx = e.message;
        }
        packJob.done++;
        drawPacks();
      }
    } catch (e) {
      if (e !== STOP) packJob.error = e.message;
    }
    savePacks();
    Object.assign(packJob, { running: false, stop: false, note: '' });
    drawPacks();
  }

  function drawPacks() {
    drawPackStatus();
    drawPackTable();
  }

  function drawPackStatus() {
    if (!packBox) return;
    const d = loadPacks(), o = opts(), w = wallet(), info = readCreator(), n = info ? info.games.length : 0;
    const go = packBox.querySelector('.sct-pgo');
    go.textContent = packJob.running ? (packJob.stop ? 'Stopping…' : 'Stop') : d.gem ? 'Rank again' : 'Rank my packs';
    go.classList.toggle('go', !packJob.running);
    let text;
    if (packJob.running) {
      const left = (packJob.total - packJob.done) * o.gap;
      text = `Looking up ${packJob.done} of ${packJob.total}` + (left > 0 ? ` · about ${fmtSpan(left)} left` : '');
      if (packJob.note) text += ` · ${packJob.note}`;
    } else if (packJob.error) {
      text = packJob.error;
    } else if (creatorProblem(info)) {
      text = creatorProblem(info);
    } else if (d.gem) {
      const when = new Date(d.gem.t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      const old = info.games.filter(g => !freshPack(d.games[g.appid], d)).length;
      text = `Prices from ${when}, in ${currencyOf(d.gem.cur)[2]}, for ${n} ${n === 1 ? 'game' : 'games'}` +
        (old ? ` · ${old} not looked up in the last hour: Rank again to refresh ${old === 1 ? 'it' : 'them'}` : '');
    } else {
      text = `Not ranked yet. Ranking looks up what gems sell for, then the order book of each of your ${n} games' packs, ` +
        `${o.gap} s apart and without your Steam sign-in: about ${fmtSpan((n + 1 + Math.min(n, PACK_TOP)) * o.gap)}.`;
    }
    packBox.querySelector('.sct-status').textContent = text;
    packBox.querySelector('.sct-bar i').style.width = packJob.running && packJob.total ? `${packJob.done / packJob.total * 100}%` : '0';
    const notes = [];
    if (d.gem && w.cur && d.gem.cur !== w.cur) {
      notes.push(`These prices are in ${currencyOf(d.gem.cur)[2]}, not your wallet's ${currencyOf(w.cur)[2]}: Steam saw the lookups come from ` +
        'another country, which is what a VPN does. The ranking still holds, since gems and packs were priced in the same currency.');
    }
    if (packJob.running) notes.push('Keep this tab in view while it looks up. Browsers slow a hidden tab to about one lookup a minute.');
    const goo = info && info.goo;
    if (goo && goo.untradable >= 1) {
      notes.push(`${Math.floor(goo.untradable).toLocaleString()} of your ${Math.floor(goo.total).toLocaleString()} gems are untradable. ` +
        'A pack made from them cannot be sold, so choose tradable gems when you make one.');
    }
    packBox.querySelector('.sct-notes').replaceChildren(...notes.map(t => el('div', { class: 'sct-note', text: t })));
  }

  // One plain paragraph on what the table says.
  function packSummary(info, ranked, cur, priced) {
    const n = info.games.length;
    if (!priced) return `${n} of your games can be made into booster packs. Rank them to see which packs are worth more than their gems.`;
    const known = ranked.filter(x => packVerdict(x.net));
    const of = v => ranked.filter(x => packTag(x) === v);
    const pays = of('pays'), listed = of('listed'), loses = of('loses');
    // Why a pack cannot be made right now: one a game a day, and only tradable gems make a pack that sells.
    const goo = info.goo;
    const blocked = x => (x.g.cool ? `made today${x.g.at ? `, next from ${x.g.at}` : ''}`
      : goo && goo.tradable != null && goo.tradable < x.g.gems ? `needs ${x.g.gems.toLocaleString()} tradable gems` : '');
    const parts = [];
    if (pays.length) {
      parts.push(`${pays.length} of your ${n} games ${pays.length === 1 ? 'makes a pack' : 'make packs'} worth more than the gems, sold straight to a buy order.`);
      const why = blocked(pays[0]);
      parts.push(`Best: ${pays[0].g.name}, ${signedCents(cur, pays[0].net.now)} a pack${why ? ` (${why})` : ''}.`);
      if (why) {
        const today = pays.find(x => !blocked(x));
        parts.push(today ? `Best you can make today: ${today.g.name}, ${signedCents(cur, today.net.now)}.`
          : pays.length === 1 ? 'It cannot be made today.' : 'None of them can be made today.');
      }
    } else if (known.length) {
      parts.push(`None of the ${known.length} packs that sell on the market is worth more than its gems sold to a buy order: selling the gems as Sacks of Gems pays more.`);
    }
    if (listed.length) parts.push(`${listed.length} only ${listed.length === 1 ? 'pays' : 'pay'} if listed and bought.`);
    if (loses.length) parts.push(`${loses.length} ${loses.length === 1 ? 'loses' : 'lose'} money either way.`);
    const count = (...m) => ranked.filter(x => m.includes(x.market)).length;
    const off = count('gone', 'empty'), unsure = count('unsure'), todo = ranked.filter(x => !x.r).length;
    const idle = of('unsold').length + of('stale').length;
    if (off) parts.push(`${off} ${off === 1 ? 'is' : 'are'} not on the market.`);
    if (idle) parts.push(`${idle} ${idle === 1 ? 'is' : 'are'} listed but not selling: none sold in the last year, and no buy order covers the gems.`);
    if (unsure) parts.push(`${unsure} ${unsure === 1 ? 'has' : 'have'} no buy orders and still ${unsure === 1 ? 'needs its' : 'need their'} sales looked up.`);
    if (todo) parts.push(`${todo} not looked up yet.`);
    return parts.join(' ');
  }

  // What a row needs to say about its pack's market, or ''.
  function marketNote(x) {
    const { r, market } = x;
    if (!r) return 'Not looked up yet';
    if (r.err) return r.err;
    if (market === 'gone') return 'Steam\'s market has no packs of this game';
    if (market === 'empty') return 'Nobody selling or buying, none sold in a year';
    if (market === 'unsold') return 'Listed, but no buy orders or sales in a year';
    if (market === 'unsure') return r.hx ? 'No buy orders, sales did not load: Rank again' : 'No buy orders, sales not looked up yet';
    if (packTag(x) === 'stale') return 'Pays only if listed, but none sold in a year';
    if (r.b > 0) return r.a > 0 ? '' : 'None listed: it sells straight to the buy order';
    return r.a > 0 ? '' : 'None listed or wanted now, though some sold';
  }

  function drawPackTable() {
    if (!packBox) return;
    const wrap = packBox.querySelector('.sct-ptable'), sum = packBox.querySelector('.sct-psum'), foot = packBox.querySelector('.sct-pfoot');
    const d = loadPacks(), info = readCreator();
    if (creatorProblem(info)) {
      wrap.replaceChildren();
      sum.textContent = foot.textContent = '';
      return;
    }
    const cur = d.gem ? d.gem.cur : wallet().cur || 1, fees = scanFees(cur);
    const $ = c => centsText(cur, c);
    const perGem = d.gem ? gemCents(d.gem.bid, fees) : null;
    const ranked = rankPacks(info.games, packRecs(info, d), perGem, fees);
    const rows = packView.sort === 'now' && packView.dir < 0 ? ranked : sortPacks(ranked, packView.sort, packView.dir);
    sum.textContent = packSummary(info, ranked, cur, !!d.gem);
    const sortBy = key => {
      if (packView.sort === key) packView.dir = -packView.dir;
      else { packView.sort = key; packView.dir = key === 'name' ? 1 : -1; }
      drawPackTable();
    };
    const head = el('tr', {}, PACK_COLS.map(([key, label, tip]) => el('th', {
      class: packView.sort === key && key ? 'sorted' : '', title: tip, onclick: key ? () => sortBy(key) : null,
      text: label + (packView.sort === key && key ? (packView.dir < 0 ? ' ▾' : ' ▴') : ''),
    })));
    const blank = text => el('span', { class: 'sct-dim', text: text || '—' });
    const signed = (c, tip, dim) => (c == null ? blank()
      : el('span', { class: dim || !c ? 'sct-dim' : c > 0 ? 'sct-ok' : 'sct-bad', title: tip, text: signedCents(cur, c) }));
    // Where a listing would go, and why there when it is under the cheapest listing.
    const listTip = (r, net, v, cost) => {
      const cap = packCap(r), capped = cap > 0 && net.listAt < r.a - 1;
      return `List at ${$(net.listAt)}` + (capped ? `, under the cheapest listing's ${$(r.a)}: half the packs sold in the last ` +
        `${r.s7 > 0 ? '7 days' : 'year'} went at or under ${$(cap)}` : '') +
        `. Keep ${$(net.keepListed)} after fees,${cost}.` + (v === 'stale' ? ' None sold in the last year.' : '');
    };
    // Last week's sales; when none sold this week, the year's; the last sale in the tooltip.
    const when = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const soldCell = r => {
      if (!r || r.s7 == null) return el('td', {}, blank());
      const same = r.hc === cur, kids = [el('b', { class: r.s7 ? '' : 'sct-warn', text: r.s7.toLocaleString() })];
      if (r.s7) { if (r.m7 && same) kids.push(blank(` · ${$(r.m7)}`)); }
      else if (r.sy != null) kids.push(el('i', { class: 'sct-sub', text: r.sy ? `${r.sy.toLocaleString()} in a year` : 'none in a year' }));
      const tip = [`${r.s7.toLocaleString()} sold in the last 7 days` + (r.s7 && r.m7 && same ? `, half at or under ${$(r.m7)}` : '') + '.'];
      if (r.sy != null) {
        tip.push(`${r.sy.toLocaleString()} in the last year` + (r.sy && r.my && same ? `, half at or under ${$(r.my)}` : '') + '.');
        tip.push(r.lt ? `The last sold on ${when(r.lt)}` + (r.lp && same ? `, at ${$(r.lp)}` : '') + '.' : 'None has ever sold.');
      }
      return el('td', { title: tip.join(' ') }, kids);
    };
    const goo = info.goo;
    const body = rows.map(x => {
      const { g, r, net, market } = x;
      const v = packTag(x), tag = v && VERDICTS[v], book = !!market && market !== 'gone';
      const notes = [];
      if (g.cool) notes.push(g.at ? `Made today, next from ${g.at}` : 'Made today: one pack a game a day');
      if (goo && goo.tradable != null && g.gems > goo.tradable) {
        notes.push(goo.total >= g.gems ? `Needs ${g.gems.toLocaleString()} tradable gems, you have ${Math.floor(goo.tradable).toLocaleString()}`
          : `Needs ${g.gems.toLocaleString()} gems, you have ${Math.floor(goo.total).toLocaleString()}`);
      }
      const said = marketNote(x);
      if (said) notes.push(said);
      const cost = net ? ` less ${$(Math.round(net.cost))} of gems` : '';
      return el('tr', { class: g.cool ? 'cool' : '' },
        el('td', { class: 'name', title: g.name },
          el('a', { href: cardUrl((r && r.h) || boosterHash(g.appid, g.name)), target: '_blank', rel: 'noopener', text: g.name }),
          notes.length ? el('i', { title: notes.join('\n'), text: notes.join(' · ') }) : null),
        el('td', {}, el('b', { text: g.gems.toLocaleString() }), perGem != null ? blank(` ${$(Math.round(g.gems * perGem))}`) : null),
        el('td', {}, book && r.b ? [el('b', { text: $(r.b) }), blank(` ×${r.cb.toLocaleString()}`)] : blank(book ? 'none' : '')),
        el('td', {}, signed(net && net.now, net && net.keepNow != null ? `Keep ${$(net.keepNow)} after fees,${cost}` : '')),
        el('td', {}, book && r.a ? [el('b', { text: $(r.a) }), blank(` ×${r.cs.toLocaleString()}`)] : blank(book ? 'none' : '')),
        el('td', {}, signed(net && net.listed, net && net.listAt ? listTip(r, net, v, cost) : '', v === 'stale')),
        soldCell(r),
        el('td', {}, tag ? el('span', { class: 'sct-tag ' + tag[0], title: tag[2], text: tag[1] }) : null));
    });
    wrap.replaceChildren(el('table', { class: 'sct-t' }, el('thead', {}, head), el('tbody', {}, body)));
    foot.textContent = 'Research only: this never makes, lists or buys a pack. Make one with Steam\'s own button above, then sell it from ' +
      'your inventory. ' + (d.gem ? `Gems count at what a Sack of Gems (${SACK_GEMS.toLocaleString()} gems) fetches sold to its best buy order ` +
      `of ${$(d.gem.bid)}, after fees: ${$(Math.round(perGem * SACK_GEMS))} a sack.` + (d.gem.ask ? ` Buying a sack costs ${$(d.gem.ask)}.` : '') + ' ' : '') +
      'A pack is ranked only if it sells on the market: someone has a buy order for it, or some sold in the last year. ' +
      '"List it" never prices a pack above what packs sold for: the median of the last 7 days, or of the year if none sold this week. ' +
      'Prices are looked up without your Steam sign-in and kept for an hour.';
  }

  function initCreator() {
    addStyle();
    packBox = el('div', { class: 'sct-packs' + (pref('sct.packsShut', '0') === '1' ? ' shut' : '') },
      el('div', { class: 'sct-ph' },
        el('b', { text: 'Card Trader: which pack is worth making' }),
        el('a', { class: 'sct-btn small go sct-pgo', onclick: () => { if (packJob.running) packJob.stop = true; else runPacks(); drawPackStatus(); } }),
        el('a', { href: traderUrl(), target: '_blank', rel: 'noopener', text: 'Scanner ↗' }),
        el('a', { title: 'Fold or unfold', text: '▾', onclick: () => setPref('sct.packsShut', packBox.classList.toggle('shut') ? '1' : '0') })),
      el('div', { class: 'sct-pb' },
        el('div', { class: 'sct-status' }), el('div', { class: 'sct-bar' }, el('i')), el('div', { class: 'sct-notes' }),
        el('p', { class: 'sct-psum' }), el('div', { class: 'sct-ptable' }), el('p', { class: 'sct-pfoot' })));
    const area = document.querySelector('.booster_creator_area');
    if (area) area.after(packBox);
    else (document.querySelector('.pagecontent') || document.body).append(packBox);
    creatorSig = creatorSignature(readCreator());
    drawPacks();
    setInterval(watchCreator, 3000);
  }
  // --- end booster creator ---

  if (/\/inventory/.test(location.pathname)) initInventory();
  else if (/^\/market(\/|$)/.test(location.pathname)) initMarket();
  else if (/^\/tradingcards\/boostercreator/.test(location.pathname)) initCreator();
})();
