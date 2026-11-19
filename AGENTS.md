# Instructions

- Keep `README.md` concise and user-facing; put repository-specific architecture, coding constraints, and agent workflow guidance in these instructions.
- This repository contains a TypeScript Cloudflare Worker for daily, long-only stock signals, optional Alpaca paper trading, and an integrated historical backtester. Never add live-trading behavior. The backtester only simulates trades and must never call order-submission code.
- Keep pure strategy and indicator logic in `strategy-core/`. The Worker adapters in `src/` and simulator in `src/backtest/` must use this shared core. Backtest runtime code must remain Worker-compatible: no Node.js HTTP server, filesystem, process environment, or node:sqlite imports.
- Keep Worker Alpaca market-data access in `src/data.ts`, webhook delivery in `src/notifications.ts`, and HTTP/Cron orchestration in `src/index.ts`. Backtests use `fetchHistoricalDailyBars` for split-adjusted history and a dedicated SQLite-backed `Backtest` Durable Object for caching and simulation, separate from `PaperTrading`.
- Admin assets live under `public/admin/`: `index.html`, `admin.js`, and `backtest.html`. Use `/admin/` when fetching the Admin directory through `ASSETS` to avoid canonical index redirects. Home, Admin, and Backtest share the top menu and theme through `public/site-header.js`.
- Preserve the 300-daily-bar minimum, SPY market-regime gate for entries, and exit checks for all watchlist tickers regardless of that gate.
- The backtest defaults live in `backtest.config.json` and are bundled with the Worker. Start WTrack with `pnpm dev` (or its `pnpm backtest` alias), then use the Backtest top-menu entry at `/admin/backtest.html`. The same UI and same-origin `/admin/backtest/*` APIs work on the deployed Worker. Wrangler persists local Durable Object state under ignored `.wrangler/`; deployed backtest data lives in Cloudflare Durable Object SQLite.
- Use pnpm for dependency management and scripts. After code changes, run `pnpm install`, `pnpm typecheck`, and `pnpm test`.
- Access control is intentionally omitted at the Worker application layer. Do not add an `ADMIN_TOKEN` gate unless requested; continue validating user input and surfacing failures.
- Never put credentials in source, Wrangler config, or committed documentation. Use `.dev.vars` locally and Wrangler secrets for deployed environments; `.dev.vars` is ignored by Git.
- When this repository is connected to Cloudflare Workers through the GitHub connector/deployment integration, pushes are deployed by that integration; do not ask the user to run `pnpm deploy` manually. Use manual deployment only when explicitly requested or when that integration is not configured.

# Development instructions

- Use pnpm for installing dependencies and running package scripts.
- If pnpm is unavailable, install it first with `npm install --global pnpm`.
- Install dependencies with `pnpm install`.
- Run the Worker locally with `pnpm dev`; type-check with `pnpm typecheck`.
- Do not use npm or another package manager for project dependencies.