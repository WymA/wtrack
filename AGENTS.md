# Instructions

- Keep `README.md` concise and user-facing; put repository-specific architecture, coding constraints, and agent workflow guidance in these instructions.
- This repository contains a TypeScript Cloudflare Worker for daily, long-only stock signals, optional Alpaca paper trading, and a local-only historical backtester. Never add live-trading behavior. The backtester only simulates trades.
- Keep pure strategy and indicator logic in `strategy-core/`. The Worker adapters in `src/` and local simulator in `backtest/` must use this shared core. Keep local backtest code and data out of the Worker import graph and `public/` assets.
- Keep Worker Alpaca market-data access in `src/data.ts`, webhook delivery in `src/notifications.ts`, and HTTP/Cron orchestration in `src/index.ts`. The local backtest uses its own data client, SQLite cache, simulator, and UI under `backtest/`.
- Preserve the 300-daily-bar minimum, SPY market-regime gate for entries, and exit checks for all watchlist tickers regardless of that gate.
- The backtest defaults live in `backtest.config.json`. Run the local UI with `pnpm backtest` on Node.js 22.13 or newer. It reads Alpaca keys from `.dev.vars`, stores its SQLite cache under the ignored `backtest-data/` directory, and never submits orders.
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