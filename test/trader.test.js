// Runs the buy-side helpers of Steam Card Trader against known inputs.
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('// --- pure helpers ---');
const end = src.indexOf('// --- end helpers ---');
assert(start > 0 && end > start, 'helper markers present');
const names = ['DAY', 'MIN_ASK', 'RECENT_DAYS', 'HOLD_DAYS', 'CARD_FEES', 'amountToSend', 'receivedForBuyerPays', 'currencyOf',
  'centsText', 'apiPoints', 'popcount', 'priceLevels', 'packLevels', 'unpackLevels', 'unitsOf', 'flow', 'heldPrice',
  'medianLevel', 'bookLevels', 'askToClear', 'planFlip', 'fmtDays', 'daysText', 'fmtSpan', 'moneyLike', 'parseMoney'];
const h = new Function(src.slice(start, end) + '\nreturn { ' + names.join(', ') + ' };')();
const w = h.CARD_FEES;

// Money in a named currency, and a fallback for one that is not in the table.
assert.strictEqual(h.centsText(21, 17), 'A$0.17');
assert.strictEqual(h.centsText(3, 5), '0.05€');
assert.strictEqual(h.centsText(1, 116), '$1.16');
assert.strictEqual(h.currencyOf(999)[2], 'currency 999');

// The new market's history rows, bad rows dropped, seconds turned into milliseconds.
const pts = h.apiPoints([
  { time: 1795752000, price_median: 0.1368, purchases: 8 },
  { time: 0, price_median: 0.2, purchases: 1 },
  { time: 1795755600, price_median: 'x', purchases: 1 },
  { time: 1795755600, price_median: 0.1593, purchases: '24' },
]);
assert.deepStrictEqual(pts, [{ t: 1795752000000, p: 0.1368, v: 8 }, { t: 1795755600000, p: 0.1593, v: 24 }]);
assert.deepStrictEqual(h.apiPoints(null), []);

assert.strictEqual(h.popcount(0), 0);
assert.strictEqual(h.popcount(0b1011), 3);
assert.strictEqual(h.popcount(1 << 29), 1);

// Levels: prices rounded to the cent, units summed, the last ten days counted apart, one bit a day.
const now = Date.UTC(2026, 10, 27, 12);
const at = (daysAgo, p, v) => ({ t: now - daysAgo * h.DAY - 3600000, p, v });
const levels = h.priceLevels([
  at(0, 0.141, 5), at(0, 0.139, 3), at(1, 0.17, 10), at(12, 0.17, 20), at(12, 0.16, 7),
  at(29, 0.13, 4), at(30, 0.5, 99), at(3, 0.2, 0),
], now);
assert.deepStrictEqual(levels, [
  { c: 13, v: 4, r: 0, m: 1 << 29 },
  { c: 14, v: 8, r: 8, m: 1 },
  { c: 16, v: 7, r: 0, m: 1 << 12 },
  { c: 17, v: 30, r: 10, m: (1 << 1) | (1 << 12) },
]);
assert.deepStrictEqual(h.unpackLevels(h.packLevels(levels)), levels);
assert.strictEqual(h.unitsOf(levels, 'v'), 49);
assert.strictEqual(h.unitsOf(levels, 'r'), 18);

// Flow either side of a price.
assert.deepStrictEqual(h.flow(levels, 16, 1), { units: 37, days: 2 });
assert.deepStrictEqual(h.flow(levels, 14, -1), { units: 12, days: 2 });
assert.deepStrictEqual(h.flow(levels, 99, 1), { units: 0, days: 0 });
assert.strictEqual(h.medianLevel(levels), 17);
assert.strictEqual(h.medianLevel([]), null);

// Held price: enough units, on enough separate days.
const spread = [
  { c: 10, v: 60, r: 30, m: 0b1111111111 },
  { c: 12, v: 30, r: 10, m: 0b0000001110 },
  { c: 15, v: 9, r: 0, m: 1 << 20 },
  { c: 30, v: 1, r: 0, m: 1 << 25 },
];
assert.strictEqual(h.heldPrice(spread, 0.05, 2, 'v'), 15);   // 5 of 100 needed: the spike at 30 is one unit, 15 adds a second day
assert.strictEqual(h.heldPrice(spread, 0.25, 3, 'v'), 12);
assert.strictEqual(h.heldPrice(spread, 0.25, 2, 'r'), 12);   // 10 of 40 recent units, on three recent days
assert.strictEqual(h.heldPrice(spread, 0.5, 2, 'r'), 10);
assert.strictEqual(h.heldPrice([{ c: 10, v: 2, r: 2, m: 1 }], 0.25, 1, 'v'), null);   // fewer than three units
assert.strictEqual(h.heldPrice([{ c: 10, v: 50, r: 50, m: 1 }], 0.25, 2, 'v'), null); // all on one day
assert.strictEqual(h.heldPrice([], 0.25, 2, 'v'), null);

// The compact book, cut to a number of levels.
assert.deepStrictEqual(h.bookLevels([13, 1021, 12, 5132, 11, 0, 'x', 4]), [{ c: 13, q: 1021 }, { c: 12, q: 5132 }]);
assert.deepStrictEqual(h.bookLevels([17, 5, 18, 72, 19, 490], 2), [{ c: 17, q: 5 }, { c: 18, q: 72 }]);
assert.deepStrictEqual(h.bookLevels(null), []);

// The cheapest ask that clears a cost, against Steam's fee steps.
assert.strictEqual(h.askToClear(3, 1, w), 6);
assert.strictEqual(h.askToClear(10, 1, w), 13);
assert.strictEqual(h.askToClear(20, 1, w), 24);
assert.strictEqual(h.askToClear(100, 1, w), 116);
assert.strictEqual(h.askToClear(13, 0, w), 15);
for (let cost = 3; cost <= 400; cost++) {
  const ask = h.askToClear(cost, 2, w);
  assert(h.receivedForBuyerPays(ask, w) >= cost + 2, `ask clears cost ${cost}`);
  assert(h.receivedForBuyerPays(ask - 1, w) < cost + 2, `ask is the cheapest that does, cost ${cost}`);
}

// Plans. A month of steady sales at 17 to 18 with a few at 13; fees leave 16 of an 18 ask.
const steady = [
  { c: 13, v: 150, r: 50, m: 0x3fffffff },
  { c: 16, v: 1500, r: 500, m: 0x3fffffff },
  { c: 17, v: 2400, r: 800, m: 0x3fffffff },
  { c: 18, v: 1800, r: 600, m: 0x3fffffff },
];
const opt = { minProfit: 2, share: 0.25, maxQty: 5 };
const asks = [{ c: 17, q: 5 }, { c: 18, q: 72 }, { c: 19, q: 490 }];

// One cent over the best order still pays: top.
let plan = h.planFlip({ bids: [{ c: 13, q: 1021 }, { c: 12, q: 5132 }], asks, levels: steady }, opt, w);
assert.strictEqual(plan.sell, 18);
assert.strictEqual(plan.net, 16);
assert.strictEqual(plan.maxPay, 14);
assert.strictEqual(plan.kind, 'top');
assert.strictEqual(plan.buy, 14);
assert.strictEqual(plan.profit, 2);
assert.strictEqual(plan.ahead, 0);
assert.strictEqual(plan.fillDays, 1 / (150 / 30));
assert.strictEqual(plan.sellDays, (5 + 72 + 1) / (1800 / 30));
assert.strictEqual(plan.cycle, plan.fillDays + h.HOLD_DAYS + plan.sellDays);
assert.strictEqual(plan.qty, 5);
assert.strictEqual(plan.median, 17);

// The best order is already at the most worth paying: wait behind everything at or above it.
plan = h.planFlip({ bids: [{ c: 15, q: 300 }, { c: 14, q: 900 }, { c: 13, q: 2000 }], asks, levels: steady }, opt, w);
assert.strictEqual(plan.kind, 'wait');
assert.strictEqual(plan.buy, 14);
assert.strictEqual(plan.ahead, 1200);
assert.strictEqual(plan.fillDays, 1201 / (150 / 30));

// A listing has dipped under what is worth paying: buy it now, no more than are listed there.
plan = h.planFlip({ bids: [{ c: 12, q: 40 }], asks: [{ c: 14, q: 3 }, { c: 17, q: 60 }], levels: steady }, opt, w);
assert.strictEqual(plan.kind, 'now');
assert.strictEqual(plan.buy, 14);
assert.strictEqual(plan.avail, 3);
assert.strictEqual(plan.qty, 3);
assert.strictEqual(plan.fillDays, 0);
assert.strictEqual(plan.profit, 2);

// No buy orders at all: bid the floor.
plan = h.planFlip({ bids: [], asks, levels: steady }, opt, w);
assert.strictEqual(plan.kind, 'top');
assert.strictEqual(plan.buy, h.MIN_ASK);

// The last ten days no longer reach the month's price: sell at what they did reach.
const faded = [
  { c: 13, v: 900, r: 900, m: 0x3ff },
  { c: 14, v: 400, r: 400, m: 0x3ff },
  { c: 18, v: 3000, r: 0, m: 0x3ffffc00 },
];
plan = h.planFlip({ bids: [{ c: 8, q: 10 }], asks: [{ c: 13, q: 50 }], levels: faded }, { minProfit: 1, share: 0.25, maxQty: 5 }, w);
assert.strictEqual(plan.sell, 14);
assert.strictEqual(plan.kind, 'top');
assert.strictEqual(plan.buy, 9);

// Nothing clears the fees on a penny card, and nothing can be said with no sales or no listings.
const penny = [{ c: 4, v: 5000, r: 1500, m: 0x3fffffff }, { c: 5, v: 4000, r: 1500, m: 0x3fffffff }];
assert.strictEqual(h.planFlip({ bids: [{ c: 3, q: 9 }], asks: [{ c: 5, q: 9 }], levels: penny }, opt, w), null);
assert.strictEqual(h.planFlip({ bids: [], asks, levels: [] }, opt, w), null);
assert.strictEqual(h.planFlip({ bids: [{ c: 13, q: 1 }], asks: [], levels: steady }, opt, w), null);

// A price nothing sold at in the month is never filled.
plan = h.planFlip({ bids: [{ c: 15, q: 5 }], asks, levels: steady.slice(1) }, opt, w);
assert.strictEqual(plan.kind, 'wait');
assert.strictEqual(plan.fillDays, Infinity);
assert.strictEqual(plan.perMonth, 0);

assert.strictEqual(h.fmtDays(0), 'now');
assert.strictEqual(h.fmtDays(2.54), '2.5 d');
assert.strictEqual(h.fmtDays(14.4), '14 d');
assert.strictEqual(h.fmtDays(200), '90+ d');
assert.strictEqual(h.fmtDays(Infinity), 'never');

assert.strictEqual(h.daysText(0.2), 'under a day');
assert.strictEqual(h.daysText(1.2), 'about 1 day');
assert.strictEqual(h.daysText(11.6), 'about 12 days');
assert.strictEqual(h.daysText(400), 'over 90 days');

assert.strictEqual(h.fmtSpan(4), '4 s');
assert.strictEqual(h.fmtSpan(76), '1 min');
assert.strictEqual(h.fmtSpan(1200), '20 min');
assert.strictEqual(h.fmtSpan(4800), '1 h 20 min');
assert.strictEqual(h.fmtSpan(7200), '2 h');

// A new amount in the text a price box already holds, read back the way the script reads it.
assert.strictEqual(h.moneyLike('A$ 0.17', 13), 'A$ 0.13');
assert.strictEqual(h.moneyLike('0,17€', 13), '0,13€');
assert.strictEqual(h.moneyLike('$1,234.50 USD', 105), '$1.05 USD');
assert.strictEqual(h.moneyLike('', 42), '0.42');
assert.strictEqual(h.moneyLike('5', 42), '0.42');
for (const old of ['A$ 0.17', '0,17€', 'CDN$ 12.00', '']) {
  assert.strictEqual(Math.round(h.parseMoney(h.moneyLike(old, 256)) * 100), 256, `reads back from "${old}"`);
}

console.log('trader helpers: all passed');
