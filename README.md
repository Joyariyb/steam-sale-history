# Steam Inventory Sale History

A userscript for the Steam Community inventory page. It puts an item's Community Market sale
history above the card grid, so you can price what you sell from what it has actually sold for.

Steam already draws this chart, but only on each item's market page, one item at a time. This
script fetches the same data for whichever item you click and prices it for you: each card opens
at the highest price it has held in the last 30 days, so selling is two clicks. Click the card,
click List.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) in your browser. On Opera, use the
   Chrome Web Store listing; Opera offers its Chrome-store helper first.
2. Open the script's raw file and Violentmonkey shows its install page:
   https://raw.githubusercontent.com/Joyariyb/steam-sale-history/main/steam-sale-history.user.js
3. Open your inventory on steamcommunity.com and click a card.

The script's header names that raw file as its update source, so Violentmonkey picks up new
versions on its own.

## What it shows

- **The ask**: the price the card opens on, with the reason beside it: how many units sold at or
  above it, on how many days, and when last. Type over it, or change it with a chip, a bar, or
  the chart. "reset" goes back to the default.
- **Gem value**: a small violet tag under the ask, read from the "This item is worth" line in
  Steam's own item panel, so you can weigh selling against turning the card into gems.
- **List**: posts the listing to Steam at the ask and names what you receive after fees. Steam
  still asks you to confirm in its mobile app. With more than one copy, **List all** lists every
  copy on the loaded pages, one request at a time.
- **The chart**: median sale price over time, with units sold as bars along the bottom. Ranges
  7d, 30d, 1y and All. Hover a point for its date, price and units sold. Outliers are hollow dots
  and do not stretch the scale. The amber line is the ask: drag it, or click a point to ask that
  price.
- **Sales by price**: a bar per price band over the last 30 days. Click a bar to ask that price.
  Bars above the held high are grey.
- **Price chips**: cheapest listing, 30-day median, 7-day high, held high, raw high.
- **Placement**: on a wide window the panel sits in the page margin to the left of the grid and
  stays in view as you scroll, so the cards and Steam's own item panel keep their place. With
  less than 400px of margin it goes above the grid instead. Rules has a switch for this.
- **Collapsed strip**: a sparkline, the reason for the price and its own List button, so you can
  sell without expanding. The choice is remembered.
- **Tiles**: a tile shows its price once its history has been fetched (clicked or hovered), and a
  tick once listed. Rest the mouse on a tile for its sparkline, held high, median and sales per
  day.
- **Session tally**: how many you have listed since the page loaded and what they pay you.

## How a card is priced

The **held high** is the highest price that at least 5% of the last 30 days' units sold at or
above (never fewer than three units), with real volume on two or more separate days. A single
spike, or a surge that lasted one day, falls outside that and is set aside as an outlier.

- If the cheapest current listing is above the held high, the market has moved up, and the ask
  is one cent under that listing.
- If nothing has held that high in the last 10 days, the panel warns you and names the 7-day
  high. The ask stays where it is.
- Steam's history is one median price per hour, not single sales, so "highest" means the highest
  hourly median.

**Rules**, in the panel's header, changes all of this: the price a card opens on (30-day held
high, 7-day held high, cheapest listing), how much is set aside as outliers (top 2%, 5% or 10%),
and switches for the two rules above, auto-advance, the keyboard, and remembering a price you set
by hand for a card.

## Keyboard

- **Enter** lists the selected card at the ask.
- **Left / Right** move to the previous or next marketable, unlisted card on the page.
- **1 to 5** pick a price chip.

After a listing, the next unlisted card is selected, so a run of cards is one click or one Enter
each. Keys are ignored while you type in a field or a Steam dialog is open.

## How it works

- Sale history comes from Steam's own `/market/pricehistory/` endpoint on your login, the same
  source the market page's chart uses. Each item's history is cached for fifteen minutes.
- The lowest current listing is read from the "Starting at" line Steam writes into its own item
  panel, so it costs no extra request.
- Listing posts to `/market/sellitem/` the way Steam's own sell dialog does. The price sent is
  what you receive; the buyer's price is worked out with Steam's fee rules.
- Rules and the open/closed choice are kept in the browser's local storage for steamcommunity.com.
- Steam rate-limits history lookups, which is why tiles are only priced once you have clicked or
  hovered them. Clicking through cards at a normal pace is fine; after a
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
