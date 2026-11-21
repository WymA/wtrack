# WTrack

WTrack is a TypeScript Cloudflare Worker that scans a stock watchlist for long-only signals and sends optional webhook alerts. It can optionally submit simulated orders to an Alpaca paper account; it never places live trades. The dashboard shows scan results and market snapshots.

## Requirements

- Node.js 22.13 or newer and pnpm
- Alpaca API credentials for market data
- A Cloudflare account to deploy the Worker

## Run locally

Install dependencies and create `.dev.vars` from `.dev.vars.example`, then add your Alpaca credentials:

```sh
pnpm install
pnpm dev
```

The local dashboard is served at `http://localhost:8787`. Use `pnpm typecheck` and `pnpm test` to check changes.

Edit [`public/watchlist.json`](./public/watchlist.json) to change the stock watchlist. The file is the source of truth; the dashboard and scans use it.

## Backtest

Choose **Backtest** in the top menu, or open `/admin/backtest.html`. It runs inside WTrack with `pnpm dev` and on the deployed Worker; no separate server is needed. It simulates trades using split-adjusted Alpaca IEX daily bars and never submits orders.

Select A/B/C or the new V2 momentum strategy D using the explanation cards, or edit the configuration online. **Run backtest** previews the draft; only **Save config** persists it, and **Reload saved config** discards unsaved edits. [`backtest.config.json`](./backtest.config.json) supplies deployment defaults; saved settings and cached history live separately for local and deployed WTrack. See [`backtest.md`](./backtest.md) for details.

For terminal results, run `pnpm backtest:run`; it starts and stops its own local Worker, reads `backtest.config.json`, and writes a report and full JSON results under `backtest-data/logs`. Use `--config <file>` for another config or `--url https://your-worker.example` for an existing Worker; `pnpm backtest:run --help` lists options. Runs do not save settings.

## Deploy

Set production credentials as Wrangler secrets; do not put secret values in source or `wrangler.toml`:

```sh
pnpm exec wrangler secret put ALPACA_API_KEY
pnpm exec wrangler secret put ALPACA_API_SECRET_KEY
```

Notifications are optional. Set `WEBHOOK_URL` for a webhook, and set `TELEGRAM_CHAT_ID` when using Telegram.

Paper trading is off by default. Protect `/admin` and `/admin/*`, including Backtest, with Cloudflare Access; the Worker does not authenticate these routes itself.

If this repository is connected to Cloudflare Workers through the GitHub connector/deployment integration, pushes to its configured branch deploy automatically; no manual deployment is needed. Otherwise, deploy with:

```sh
pnpm deploy
```

See [`strategy.md`](./strategy.md) for strategy details.
