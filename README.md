# Stock Tracker Cloudflare Worker

A TypeScript Cloudflare Worker that scans a configured US-stock watchlist for long-only stacked EMA setups and exit signals, with optional Discord-compatible webhook or Telegram alerts. It never places trades. Signals are informational, not investment advice.

The root URL serves a static Bootstrap dashboard that follows the system light/dark preference by default, with a manual theme toggle. It shows the latest saved close, EMAs, five-day low, scan status, entry/exit signals, and the last scheduled run result.

The market cards show SPY (an S&P 500 ETF) and QQQ (a Nasdaq-100 ETF) as proxies, not actual index levels or live quotes. The prices and changes use Alpaca IEX daily bars: change is the latest close minus the previous available close, and percentage change is relative to that previous close. Each card shows the bar's session date and the snapshot save time. New fields appear after the next scan.

## Requirements

- Node.js and pnpm
- A Cloudflare account with Workers and KV enabled
- Alpaca Market Data API credentials (uses the free IEX feed)
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

Initialize the local watchlist in the local KV store:

```sh
pnpm exec wrangler kv key put watchlist '["AAPL","MSFT","NVDA"]' --binding WTRACK_KV --local
```

The HTTP endpoints are read-only. Update the lists with Wrangler KV commands.

## Deploy

Set production secrets. Wrangler prompts for each value; do not put secret values in `wrangler.toml`:

```sh
pnpm exec wrangler secret put ALPACA_API_KEY
pnpm exec wrangler secret put ALPACA_API_SECRET_KEY
```

Notifications are optional. If `WEBHOOK_URL` is unset or empty, scans still save signals to the dashboard but send no notifications and do not mark alerts as sent. To enable notifications, set `WEBHOOK_URL` with `pnpm exec wrangler secret put WEBHOOK_URL`. For Telegram, also set `TELEGRAM_CHAT_ID`. A configured webhook that fails still causes the scan to report an error.

Initialize the production watchlist in KV, then deploy:

```sh
pnpm exec wrangler kv key put watchlist '["AAPL","MSFT","NVDA"]' --binding WTRACK_KV --remote
pnpm deploy
```

For existing deployments, the first watchlist read or scan merges any saved symbols from the legacy `holdings` KV key into `watchlist`, then removes the old key.

The configured cron triggers run at `21:30 UTC` on weekdays. The Worker runs the scan only at `16:30 America/New_York` (30 minutes after the regular US market close), so the active trigger adjusts for daylight saving time. It skips scans without a current-session SPY bar, such as on a market holiday. Early-close sessions are not separately scheduled.

## Strategy

See [strategy-v1.md](./strategy-v1.md) for the complete, versioned strategy and alert criteria.

## Admin tools

The `/admin` page provides buttons to run a scan, check Worker health, and read the watchlist. The page and its actions have no authentication; anyone who can reach the Worker can use them. Do not expose it publicly until you add an access-control mechanism.

The watchlist supports up to 200 unique symbols. Each scan checks all listed symbols for exit signals, regardless of the SPY entry filter, and checks for entry setups when the filter passes. SPY and QQQ are fetched for the market cards even when they are not on the watchlist; only SPY is used for the entry filter.

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
