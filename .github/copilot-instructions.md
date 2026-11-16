# GitHub Copilot instructions

- This repository is a TypeScript Cloudflare Worker for daily, long-only stock-signal alerts. It does not place trades.
- Use pnpm for dependency management and scripts. Run `pnpm install`, `pnpm typecheck`, and `pnpm test` when changing code.
- Keep the strategy calculations in `src/indicators.ts` and `src/strategy.ts`, Alpaca market-data access in `src/data.ts`, webhook delivery in `src/notifications.ts`, and HTTP/Cron orchestration in `src/index.ts`.
- Preserve the 300-daily-bar minimum, SPY market-regime gate for entries, and exit checks for holdings regardless of that gate.
- Require the bearer `ADMIN_TOKEN` for scan, watchlist, and holdings endpoints. Validate user input and surface failures; do not silently substitute defaults for malformed stored data.
- Never put credentials in source, Wrangler config, or committed documentation. Use `.dev.vars` locally and Wrangler secrets for deployed environments; `.dev.vars` is ignored by Git.
- Do not add code that submits, modifies, or cancels trades.
