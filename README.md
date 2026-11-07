# Steam Inventory Sale History

A userscript for the Steam Community inventory page. It puts an item's Community Market sale
history above the card grid, so you can price what you sell from what it has actually sold for.

Steam already draws this chart, but only on each item's market page, one item at a time. This
script fetches the same data for whichever item you click and keeps the whole pricing loop in one
place: look at the history, pick a price, list.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) in your browser. On Opera, use the
   Chrome Web Store listing; Opera offers its Chrome-store helper first.
2. Open the script's raw file and Violentmonkey shows its install page:
   https://raw.githubusercontent.com/Joyariyb/steam-sale-history/main/steam-sale-history.user.js
3. Open your inventory on steamcommunity.com and click a card.

The script's header names that raw file as its update source, so Violentmonkey picks up new
versions on its own.

## What it shows

- **A strip above the grid** on every marketable item: a 30-day sparkline, the median, the trend
  against the 30 days before, and sales per day. Click it to expand; the choice is remembered.
- **The chart**: median sale price over time, with units sold as bars along the bottom. Ranges
  7d, 30d, 1y and All. Hover a point for its date, price and units sold.
- **Sales by price**: a bar per price band, bright at or above your asking price, with the share
  of sales at or above it.
- **Price chips**: lowest current listing, 7-day median, 30-day median, 30-day high. Clicking one
  moves the asking price there.
- **Asking price**: the amber line on the chart. Drag it, click a point on the chart to ask that
  price, type into the box, or use a chip.
- **List**: posts the listing to Steam at the asking price and names what you receive after fees.
  Steam still asks you to confirm in its mobile app.
- **Grid hover**: rest the mouse on a tile and a small card shows its sparkline, median, trend
  and sales per day.

## How it works

- Sale history comes from Steam's own `/market/pricehistory/` endpoint on your login, the same
  source the market page's chart uses. Each item's history is cached for fifteen minutes.
- The lowest current listing is read from the "Starting at" line Steam writes into its own item
  panel, so it costs no extra request.
- Listing posts to `/market/sellitem/` the way Steam's own sell dialog does. The price sent is
  what you receive; the buyer's price is worked out with Steam's fee rules.
- Steam rate-limits history lookups. Clicking through cards at a normal pace is fine; after a
  burst the panel says so and waits a moment.

## Development

The file is the whole script. Its pure helpers sit between the `--- pure helpers ---` markers and
have tests:

```
node --check steam-sale-history.user.js
node test/helpers.test.js steam-sale-history.user.js
```

To ship a change, bump `@version` in the header and push. Violentmonkey only updates when the
version number rises.
