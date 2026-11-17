# Stock Tracker Cloudflare Worker

A TypeScript Cloudflare Worker that scans a configured US-stock watchlist for long-only EMA setups and exit signals, with optional Discord-compatible webhook or Telegram alerts. Scheduled scans can submit simulated orders to Alpaca paper trading; it never submits live orders. Signals are informational, not investment advice.

The root URL serves a static Bootstrap dashboard that follows the system light/dark preference by default, with a manual theme toggle. It shows triggered signals separately above the full watchlist, along with the latest saved close, EMAs, scan status, and last scheduled run result. Newly added symbols display placeholders until scanned.

The market cards show SPY (an S&P 500 ETF) and QQQ (a Nasdaq-100 ETF) as proxies, not actual index levels or live quotes. The prices and changes use Alpaca IEX daily bars: change is the latest close minus the previous available close, and percentage change is relative to that previous close. Each card shows the bar's session date and the snapshot save time. New fields appear after the next scan.

## Requirements

- Node.js and pnpm
- A Cloudflare account with Workers, KV, and Durable Objects enabled
- Alpaca paper-account API credentials (market data uses the free IEX feed)
- Optional: a Discord webhook URL or Telegram bot `sendMessage` URL for notifications

If pnpm is unavailable, install it first with `npm install --global pnpm`.

## Initialize the project

```sh
pnpm install
pnpm cf-typegen
pnpm typecheck
pnpm test
```

Create the KV namespace and copy its returned ID into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`:

```sh
pnpm exec wrangler kv namespace create WTRACK_KV
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in the credentials. `.dev.vars` is gitignored. Start the Worker with:

```sh
pnpm dev
```

Edit [`public/watchlist.json`](./public/watchlist.json) to configure the watchlist. The file contains a `watchlist` array of ticker symbols. Local scans use this asset; deploy after changes to update production. The watchlist is publicly readable.

## Deploy

Set production secrets. Wrangler prompts for each value; do not put secret values in `wrangler.toml`:

```sh
pnpm exec wrangler secret put ALPACA_API_KEY
pnpm exec wrangler secret put ALPACA_API_SECRET_KEY
```

Notifications are optional. If `WEBHOOK_URL` is unset or empty, scans still save signals to the dashboard but send no notifications and do not mark alerts as sent. To enable notifications, set `WEBHOOK_URL` with `pnpm exec wrangler secret put WEBHOOK_URL`. For Telegram, also set `TELEGRAM_CHAT_ID`. A configured webhook that fails still causes the scan to report an error.

After editing the watchlist file, deploy:

```sh
pnpm deploy
```

The file is now the sole watchlist source. Existing KV `watchlist` and `holdings` keys are ignored and left unchanged; copy any wanted symbols into the file before deploying. KV remains in use for scan snapshots, scheduled-run status, and notification history.

The configured cron triggers run at 10:15 and 16:30 America/New_York on weekdays, with paired UTC triggers for daylight saving time. The morning scan uses the previous completed market session, not the unfinished current-day candle. The close scan uses the current session. Scans skip trading when the required market session is unavailable; early-close sessions are still scanned at 16:30.

## Strategy

See [strategy.md](./strategy.md) for the signal definitions. Although that document describes alert-only operation and also describes Setup C, this application additionally executes Setup A and B on paper and does not implement Setup C.

### Paper execution

Paper trading starts OFF. Protect `/admin` and all `/admin/*` paths on every hostname with a Cloudflare Access application. The Worker does not independently authenticate the switch; an unprotected hostname allows anyone to change it. Do not use an Access bypass policy. After deploying, use the Admin switch to turn paper trading ON.

The switch is stored in the Durable Object alongside the order ledger, rather than eventually consistent KV, and applies to scheduled scans. Switching OFF prevents new submissions once the switch operation completes; already-open Alpaca orders remain open and existing positions are not closed. A scan already submitting orders finishes before the OFF operation returns. Manual Admin scans remain read-only. The Worker uses only `https://paper-api.alpaca.markets/v2` for orders.

Entry orders are day limit orders for up to $1,000 at 3% above the signal close, with at most five open or pending strategy positions. Fractional shares are used when supported. Exit signals submit a day limit order for the full strategy-owned position at 3% below the signal close. Limit orders can remain unfilled, and the 5-day low is a reference only, not an automatic stop. Orders submitted after the close are queued for the next regular session. At 10:15, unfilled orders from the previous signal session are canceled and replaced for the remaining quantity at the same limit. Alpaca may reject or delay cancellation or orders; inspect Worker logs and the paper account when a scheduled run fails.

A SQLite-backed Durable Object stores the paper account identity and order ledger, serializes execution, and reconciles order fills against Alpaca. It manages only positions entered by this application; existing positions are not adopted. Do not manually trade strategy-managed symbols or change paper accounts without reconciling the ledger: a mismatch stops automated trading. An uncertain submission is not blindly retried, to avoid duplicate orders. Keep the Durable Object data when deploying; deleting it loses ownership history. The maximum applies only to this strategy, not unrelated account positions.

Paper fills are simulated and may differ from live trading. A canceled or rejected order, stale data, API failure, or ownership mismatch can leave a position without an exit; monitor scheduled-run status and Alpaca directly. The strategy does not guarantee a fill or a stop-loss.

## Admin tools

The `/admin` page provides the paper-trading switch and buttons to run a scan, check Worker health, and read the watchlist. Protect the page and its actions using Cloudflare Access; the Worker does not independently authenticate callers.

The Admin order table reads the strategy's stored order ledger, including unconfirmed intents; it does not include unrelated Alpaca orders. Signal date is not order submission time. Statuses and filled quantities reflect the last scheduled reconciliation and may be stale, including while trading is OFF. Check Alpaca for current order status.

The watchlist supports up to 200 ticker entries; symbols are normalized and duplicates removed. Each scan checks all listed symbols for exit signals, regardless of the SPY entry filter, and checks for entry setups when the filter passes. SPY and QQQ are fetched for the market cards even when they are not on the watchlist; only SPY is used for the entry filter.

### Run a scheduled event locally

Start Wrangler with `pnpm exec wrangler dev`, then invoke the local scheduled-event endpoint:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=30+21+*+*+1-5&time=<epoch-milliseconds>"
```

Set `time` to a weekday timestamp at 16:30 in `America/New_York` so the Worker passes its scheduled-time gate. For an immediate scan on a deployed Worker, open the Admin page and select **Scan**; this runs the scan but does not record a scheduled event.

## Commands

- `pnpm dev` — run the local Worker.
- `pnpm cf-typegen` — regenerate Cloudflare binding types after changing `wrangler.toml`.
- `pnpm typecheck` — type-check the project.
- `pnpm test` — run strategy and indicator tests.
- `pnpm deploy` — deploy with Wrangler.
