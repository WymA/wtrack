# Stock Tracker Cloudflare Worker

A TypeScript Cloudflare Worker that scans a configured US-stock watchlist for long-only stacked EMA setups, checks exits for held positions, and sends alerts to Discord-compatible webhooks or Telegram. It sends alerts only and never places trades. Signals are informational, not investment advice.

## Requirements

- Node.js and pnpm
- A Cloudflare account with Workers and KV enabled
- Alpaca Market Data API credentials (uses the free IEX feed)
- A Discord webhook URL or Telegram bot `sendMessage` URL

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

Set the watchlist and holdings locally through the HTTP endpoints. The request body replaces the existing list:

```powershell
$body = @{ tickers = @("AAPL", "MSFT", "NVDA") } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/watchlist `
  -ContentType "application/json" -Body $body
```

Use `/holdings` in place of `/watchlist` to manage held positions.

## Deploy

Set production secrets. Wrangler prompts for each value; do not put secret values in `wrangler.toml`:

```sh
pnpm exec wrangler secret put ALPACA_API_KEY
pnpm exec wrangler secret put ALPACA_API_SECRET_KEY
pnpm exec wrangler secret put WEBHOOK_URL
```

For Telegram, also set `TELEGRAM_CHAT_ID`. For Discord, set `WEBHOOK_URL` to the webhook URL. Initialize the production watchlist in KV, then deploy:

```sh
pnpm exec wrangler kv key put watchlist '["AAPL","MSFT","NVDA"]' --binding WTRACK_KV --remote
pnpm deploy
```

The configured schedule runs weekdays at `21:30 UTC`. This is a fixed UTC time; the US market close shifts with daylight saving time. The scanner skips a run if SPY has no bar for the current New York date, such as on a market holiday.

## Strategy

See [strategy-v1.md](./strategy-v1.md) for the complete, versioned strategy and alert criteria.

## HTTP API

No endpoint currently requires authentication. Do not expose this Worker publicly until you add an access-control mechanism; anyone who can reach it can trigger scans and update the watchlist or holdings.

- `GET /scan` — manually run a scan and return its results.
- `GET /watchlist` / `POST /watchlist` — read or replace the watchlist.
- `GET /holdings` / `POST /holdings` — read or replace held tickers.
- `GET /` — health response.

POST requests use `{"tickers":["AAPL","MSFT"]}`. The combined watchlist and holdings limit is 200 unique symbols.

## Commands

- `pnpm dev` — run the local Worker.
- `pnpm cf-typegen` — regenerate Cloudflare binding types after changing `wrangler.toml`.
- `pnpm typecheck` — type-check the project.
- `pnpm test` — run strategy and indicator tests.
- `pnpm deploy` — deploy with Wrangler.
