# Stock Tracker Cloudflare Worker

A TypeScript Cloudflare Worker that scans a configured US-stock watchlist for long-only stacked EMA setups, checks exits for held positions, and sends alerts to Discord-compatible webhooks or Telegram. It sends alerts only and never places trades. Signals are informational, not investment advice.

The root URL serves a static Bootstrap dashboard, using the default light theme with a light/dark mode toggle. It shows the latest saved close, EMAs, five-day low, scan status, and entry/exit signals.

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

Initialize the local watchlist and holdings in the local KV store:

```sh
pnpm exec wrangler kv key put watchlist '["AAPL","MSFT","NVDA"]' --binding WTRACK_KV --local
pnpm exec wrangler kv key put holdings '[]' --binding WTRACK_KV --local
```

The HTTP endpoints are read-only. Update the lists with Wrangler KV commands.

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
pnpm exec wrangler kv key put holdings '[]' --binding WTRACK_KV --remote
pnpm deploy
```

The configured cron triggers run at `20:30` and `21:30 UTC` on weekdays. The Worker runs the scan only at `16:30 America/New_York` (30 minutes after the regular US market close), so the active trigger adjusts for daylight saving time. It skips scans without a current-session SPY bar, such as on a market holiday. Early-close sessions are not separately scheduled.

## Strategy

See [strategy-v1.md](./strategy-v1.md) for the complete, versioned strategy and alert criteria.

## HTTP API

No endpoint currently requires authentication. Anyone who can reach the Worker can trigger scans and read the watchlist or holdings. Do not expose it publicly until you add an access-control mechanism.

- `GET /` — static dashboard.
- `GET /ping` — health check.
- `GET /watchlist` — read the watchlist and latest saved scan snapshot for the dashboard.
- `GET /holdings` — read held tickers.
- `GET /scan` — manual scan endpoint, intentionally not linked from the dashboard.

The combined watchlist and holdings limit is 200 unique symbols.

## Commands

- `pnpm dev` — run the local Worker.
- `pnpm cf-typegen` — regenerate Cloudflare binding types after changing `wrangler.toml`.
- `pnpm typecheck` — type-check the project.
- `pnpm test` — run strategy and indicator tests.
- `pnpm deploy` — deploy with Wrangler.
