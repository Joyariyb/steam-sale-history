// Runs the pure helpers of the userscript against known inputs.
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('// --- pure helpers ---');
const end = src.indexOf('// --- end helpers ---');
assert(start > 0 && end > start, 'helper markers present');
const names = ['parseSteamDate', 'toPoints', 'inRange', 'median', 'periodStats', 'niceBinWidth', 'priceBins',
  'shareAtOrAbove', 'parseMoney', 'parseStartingAt', 'amountToSend', 'receivedForBuyerPays', 'money', 'fmtRate',
  'fmtTrend', 'nearestIndex', 'DAY'];
const h = new Function(src.slice(start, end) + '\nreturn { ' + names.join(', ') + ' };')();
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Steam's stamp format, hourly and daily rows.
assert.strictEqual(h.parseSteamDate('Nov 07 2026 05: +0'), Date.UTC(2026, 10, 7, 5));
assert.strictEqual(h.parseSteamDate('Dec 05 2015 01: +0'), Date.UTC(2015, 11, 5, 1));
assert(isNaN(h.parseSteamDate('2026-11-07')));
assert(isNaN(h.parseSteamDate(null)));

// Rows -> points, bad rows dropped, volume parsed from its string.
const pts = h.toPoints([
  ['Nov 01 2026 01: +0', 0.05, '3'],
  ['Nov 02 2026 01: +0', 0.07, '12'],
  ['garbage', 0.09, '1'],
  ['Nov 03 2026 01: +0', 'x', '1'],
  ['Nov 04 2026 01: +0', 0.04, '7'],
]);
assert.strictEqual(pts.length, 3);
assert.deepStrictEqual(pts.map(p => p.v), [3, 12, 7]);

// Range filter and median.
const now = Date.UTC(2026, 10, 7, 12);
assert.strictEqual(h.inRange(pts, 0, now).length, 3);
assert.strictEqual(h.inRange(pts, 4, now).length, 1);
assert.strictEqual(h.median([]), null);
assert.strictEqual(h.median([3, 1, 2]), 2);
assert(near(h.median([0.05, 0.07]), 0.06));

// Period stats: this window versus the one before it.
const series = [];
for (let d = 59; d >= 0; d--) series.push({ t: now - (d + 0.5) * h.DAY, p: d >= 30 ? 0.05 : 0.06, v: 2 });
const s30 = h.periodStats(series, 30, now);
assert.strictEqual(s30.view.length, 30);
assert.strictEqual(s30.sold, 60);
assert(near(s30.perDay, 2));
assert(near(s30.median, 0.06));
assert(near(s30.trend, 0.2));
assert(near(s30.low, 0.06) && near(s30.high, 0.06));
const sAll = h.periodStats(series, 0, now);
assert.strictEqual(sAll.trend, null);
assert.strictEqual(sAll.sold, 120);
assert(near(sAll.perDay, 120 / 59));
const empty = h.periodStats([], 7, now);
assert.strictEqual(empty.median, null);
assert.strictEqual(empty.sold, 0);

// Price bands: cent bands for cheap cards, wider for dear items, never more than asked for.
assert.strictEqual(h.niceBinWidth(0.04, 0.12, 9), 0.01);
assert.strictEqual(h.niceBinWidth(1.00, 3.50, 9), 0.5);
const bins = h.priceBins([{ p: 0.04, v: 1 }, { p: 0.05, v: 2 }, { p: 0.05, v: 3 }, { p: 0.12, v: 4 }], 9);
assert.strictEqual(bins.length, 9);
assert(near(bins[0].from, 0.04));
assert.strictEqual(bins[0].v, 1);
assert.strictEqual(bins[1].v, 5);
assert.strictEqual(bins[8].v, 4);
assert.strictEqual(bins.reduce((n, b) => n + b.v, 0), 10);
const wide = h.priceBins([{ p: 1.0, v: 1 }, { p: 3.5, v: 1 }], 9);
assert(wide.length <= 9 && wide.length >= 2);
assert.strictEqual(wide.reduce((n, b) => n + b.v, 0), 2);
assert.deepStrictEqual(h.priceBins([], 9), []);
assert.strictEqual(h.priceBins([{ p: 0.07, v: 5 }], 9).length, 1);

// Share of units sold at or above a price, by volume.
const sold = [{ p: 0.05, v: 10 }, { p: 0.08, v: 5 }, { p: 0.10, v: 5 }];
assert(near(h.shareAtOrAbove(sold, 0.08), 0.5));
assert(near(h.shareAtOrAbove(sold, 0.11), 0));
assert(near(h.shareAtOrAbove(sold, 0.01), 1));
assert.strictEqual(h.shareAtOrAbove([], 0.08), null);

// Money text in the formats Steam uses around the world.
assert(near(h.parseMoney('A$ 0.07'), 0.07));
assert(near(h.parseMoney('0,07€'), 0.07));
assert(near(h.parseMoney('1.234,56 pуб.'), 1234.56));
assert(near(h.parseMoney('$1,234.56'), 1234.56));
assert.strictEqual(h.parseMoney('Starting at:'), null);
assert(near(h.parseStartingAt('Starting at: A$ 0.07\nVolume: 234 sold in the last 24 hours'), 0.07));
assert(near(h.parseStartingAt('Starting at: 0,07€'), 0.07));
assert.strictEqual(h.parseStartingAt('View in Community Market'), null);

// Steam's fees: buyer pays 0.08, seller gets 0.06; the floor is 0.03 for 0.01.
const w = { pct: 0.05, min: 1, base: 0, pub: 0.10 };
assert.strictEqual(h.amountToSend(6, w), 8);
assert.strictEqual(h.receivedForBuyerPays(8, w), 6);
assert.strictEqual(h.receivedForBuyerPays(3, w), 1);
assert.strictEqual(h.receivedForBuyerPays(100, w), 88);
assert.strictEqual(h.amountToSend(h.receivedForBuyerPays(1000, w), w) <= 1000, true);
assert.strictEqual(h.amountToSend(h.receivedForBuyerPays(1000, w) + 1, w) > 1000, true);

// Formatting.
assert.strictEqual(h.money('A$ ', '', 0.07), 'A$0.07');
assert.strictEqual(h.money('', '€', 1.5), '1.50€');
assert.strictEqual(h.fmtRate(12.4), '12');
assert.strictEqual(h.fmtRate(2.26), '2.3');
assert.strictEqual(h.fmtRate(0.333), '0.33');
assert.strictEqual(h.fmtTrend(0.123), '+12%');
assert.strictEqual(h.fmtTrend(-0.05), '-5%');
assert.strictEqual(h.fmtTrend(null), '');

// Nearest point by time.
assert.strictEqual(h.nearestIndex(pts, pts[1].t), 1);
assert.strictEqual(h.nearestIndex(pts, pts[1].t + h.DAY * 1.6), 2);
assert.strictEqual(h.nearestIndex(pts, pts[0].t - h.DAY * 5), 0);

console.log('helpers ok:', names.length, 'exports tested');
