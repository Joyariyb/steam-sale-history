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

## Steam Card Trader

`steam-card-trader.user.js` is a second script in this repo: the Sale History panel above, plus a
buy side for flipping cards and a ranking of the booster packs worth making. It is a separate
install, so the original keeps working untouched.
Run one of the two at a time. If both are on, Card Trader pauses itself in the inventory and says
so.

Install it the same way, from its own raw file:
https://raw.githubusercontent.com/Joyariyb/steam-sale-history/main/steam-card-trader.user.js

On first run it copies your Rules and saved prices over from Sale History.

### The scanner

Open https://steamcommunity.com/market/#card-trader, or press **Card Trader** at the bottom left
of any market page, then **Scan**. A scan takes the most-traded cards in your price range and
looks up each one's order book and sale history. It lists the cards where a buy order still pays
after Steam's fees:

- **Buy now**: a listing is already cheap enough to buy and resell.
- **Top bid**: one cent over the best buy order still pays, so you are next when someone sells
  into the orders.
- **Low bid**: only a lower price pays. Steam fills the oldest order first, so this one waits
  behind every order already at or above it and fills only on a dip.

Each row gives the price to bid, how many copies to try, the price to sell at, the profit after
fees, how many sell a day, the cheapest listing against the month's median, how long the whole
trip should take, and what the money in one card would earn in a month. Click a heading to sort.
**Open** opens the card in a new tab with Steam's buy box showing.

**Settings** holds the least profit worth an order, the sell target, the price range, how many
cards a scan covers and the gap between lookups. **What you paid** lists what each card cost you.

### On a card's page

A small panel at the bottom right works the order out again from that page's live numbers, in
your wallet's currency. Arriving from the scanner's **Open**, it puts the price and quantity into
Steam's buy box for you; on any other visit a button in the panel does it. You check it and place
the order yourself: the script never presses Steam's button. Your open buy orders are read from
Steam here, which is how the inventory later knows what a card cost.

### In the inventory

- **Paid**: under the ask. Filled in from your buy orders, or type it. A card with a paid price
  never opens below the lowest ask that still clears it by a cent after fees, and the panel warns
  if you go under it by hand.
- **Price all**: looks up every marketable item in the inventory, one request at a time, and
  lists each with its price and what it pays you. Tiles get their price badges. Click a row to
  select that card, then List as usual.

### On the Booster Pack Creator

Open https://steamcommunity.com/tradingcards/boostercreator/ and a panel under Steam's own
creator ranks every game you can make a pack of by what one pack is worth once its gems are paid
for. Press **Rank my packs**. It looks up what gems sell for, then each game's pack, one lookup
each, spaced like the scanner's: a hundred games take about six minutes. Keep the tab in view
while it runs.

- **Gems**: what a pack costs, and what those gems would fetch sold as a Sack of Gems (1000 gems)
  to its best buy order, after fees. Making a pack only pays if the pack is worth more than that.
- **Sell now**: the pack sold straight to its best buy order, less Steam's fees and the gems. The
  table is ranked by this.
- **List it**: the same if you list one cent under the cheapest listing and someone buys it.
  Packs of little-known games are often listed far above anything that sells, so do not go by
  this column alone.
- **Sold, 7 days**: for the top ten rows, how many packs sold in the last week, and their median
  price.
- Each row says whether the pack **Pays**, pays **Only listed**, **Breaks even** or **Loses
  money**. A game you made a pack of in the last day is greyed, with the time Steam gives for the
  next one, and the panel notices as soon as you make one. Click a game for its pack's market
  page. Click a heading to sort.
- If some of your gems are untradable, the panel says so: a pack made from them cannot be sold,
  so choose tradable gems when you make one.

It is research only: it never makes, lists or buys a pack. Make the pack with Steam's own button,
then sell it from the inventory. Prices are kept for an hour, so ranking again within the hour
only looks up the price of gems. A pack's market name is usually `<appid>-<game> Booster Pack`.
When a game has been renamed since its cards came out, the panel finds its pack by searching the
market instead.

### How an order is worked out

- **Sell price**: the price the dearest quarter of the last 30 days' units sold at or above, on
  three or more days. If the last 10 days fell short of that, the lower figure is used.
- **Most worth paying**: what that sale leaves after fees, less the profit you asked for.
- **Waits**: a top bid is timed by how often cards sold at or under the best buy order. A low
  bid is timed by the orders ahead of it and how often cards sold that low. Selling is timed by
  the listings at or under the sell price and how often cards sold that high. Steam also holds a
  card bought on the market for 7 days. These are estimates from one month of history.

Steam adds 15% on top of what the seller receives, and each of its two fees is at least one cent,
so cards under about 10 cents cannot clear the fees. The scan range starts at 15 for that reason.

### Lookups, rate limits and VPNs

- Scanner lookups are sent without your Steam sign-in, three seconds apart by default. If Steam
  refuses them, the scan waits 2, 5, then 15 minutes, then stops.
- The scan runs in the tab. Keep it in view: browsers slow a hidden tab to about one lookup a
  minute. A stopped scan picks up where it left off if restarted within the hour.
- Lookups go wherever the browser sends them, so with a browser VPN on they come from the VPN's
  address, not yours. Steam then answers in that country's currency. The ranking still holds, and
  each card's page works the exact price out in your own currency.
- Steam's Subscriber Agreement forbids using a proxy to hide where you are, and forbids scripts
  that act for you. That is why nothing here places an order, and why the card panel warns when
  a VPN still looks to be on. Turn it off before buying.

### Not yet tried on a signed-in account

The scanner and the card panel were tested on the live market signed out, and the inventory
changes against a mock page. Three things need a signed-in look: Steam's buy box taking the price,
reading your buy orders, and loading a large inventory in full for **Price all**. If the price
does not go in, the panel says so and shows the number to type.

The Booster Pack Creator panel was tested against a mock of the creator page, built the way
Steam's own page script sets it up, with some prices captured from the live market. Where it sits
on the real page, and that it reads your games and gems there, still need a signed-in look.

## Development

Each file is a whole script. Its pure helpers sit between the `--- pure helpers ---` markers and
have tests:

```
node --check steam-sale-history.user.js
node test/helpers.test.js steam-sale-history.user.js

node --check steam-card-trader.user.js
node test/helpers.test.js steam-card-trader.user.js
node test/trader.test.js steam-card-trader.user.js
```

To ship a change, bump `@version` in the header and push. Violentmonkey only updates when the
version number rises.
