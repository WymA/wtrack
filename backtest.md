# WTrack backtesting

The backtester shares WTrack's pure Strategy v1 indicators and setup rules, uses split-adjusted Alpaca IEX daily bars, and only simulates trades. It never submits orders.

## Open Backtest

Locally, run `pnpm install`, put Alpaca market-data credentials in the ignored `.dev.vars` file, and start WTrack with `pnpm dev`. Choose **Backtest** in the top menu or open `http://localhost:8787/admin/backtest.html`. `pnpm backtest` is an alias for starting the same WTrack server.

On the deployed Worker, the same menu, page, and APIs run simulations directly in WTrack, using the deployed Alpaca secrets. No local server or additional startup command is required. Backtest requests never contact Alpaca's order API. Protect `/admin` and `/admin/*` with Cloudflare Access; there is no application-level login.

## Configure and run

Edit [`backtest.config.json`](./backtest.config.json) for defaults, which are bundled with WTrack at deployment. The UI's JSON editor overrides them for one run only; **Reload defaults** restores the server's defaults. **Run backtest** updates missing cached data before simulating. **Refresh cached bars** re-downloads the configured universe and SPY, replacing each ticker's cache with the requested history window only after a successful, nonempty download.

| Configuration | Choices and units |
| --- | --- |
| `strategy.setups` | Any combination of `Setup A`, `Setup B` (right-side), and `Setup C` (left-side). |
| `strategy.watchlist` | 1-200 unique uppercase ticker symbols. SPY is added for the entry regime gate. |
| `dateWindow` | `start` and `end` as `YYYY-MM-DD`; `end` also accepts `today`, using New York time. An in-progress daily bar is excluded before 4 p.m. New York time. |
| `portfolio` | Starting capital in USD, maximum open positions, and sizing by `risk-percent`, `fixed-dollar`, or `equity-percent`. Percentage values use 1 for 1%; entries are capped by cash. |
| `stops.initial` | `swing-low` with a bar `lookback`; `fixed-percent` with a percentage `value`; or `ema-buffer` with an `ema` (`ema20`, `ema50`, `ema100`, `ema200`) and `bufferPercent`. |
| `stops.leftSideFailurePercent` | Setup C's hard-stop percentage below the touched support. Its separate close-confirmed failure check applies on the entry day and following session. |
| `profitTaking` | A `fixed-percent` target or `risk-multiple` target with a `value`; `partialPercent` sells 1-100% of the original position at the target. |
| `trailingExitEma` | `disabled`, `ema50`, or `ema100`. EMA exits require two consecutive closes below the selected EMA; Setup C arms these exits after a close above EMA 50. |
| `costs` | Adverse `slippagePercent` per side and USD `commissionPerOrder`. Partial trims incur a separate commission. |

Results include the requested date window and actual simulated trading period, return, ending equity, drawdown, win rate, profit factor, completed trades, and remaining open positions. VOO is automatically downloaded and cached as a buy-and-hold benchmark for the same simulated period: first session's open to last session's close, using split-adjusted prices without dividends or trading costs. Its return is shown as unavailable if either boundary price is missing, rather than silently comparing a shorter period.

## Data and execution assumptions

History is stored in the dedicated `BACKTEST` SQLite-backed Durable Object, independently of paper trading. Wrangler persists local data under ignored `.wrangler/`; deployed data stays in Cloudflare and is shared by this WTrack deployment. These caches are separate, and the previous standalone `backtest-data/` cache is not imported or deleted.

Downloads include 600 calendar days of warm-up before the start date; every simulated ticker and SPY must have at least 300 prior daily bars. Newly listed tickers may not have enough history. Regular runs reuse the cache and incrementally fetch missing dates; refresh after historical price adjustments. A deployment permits one simulation or refresh at a time; concurrent submissions return an actionable error. Large universes and long windows are subject to your Cloudflare plan's runtime and subrequest limits.

Close-confirmed right-side signals execute at the next trading session's open. Setup C evaluates intraday touches against the prior session's EMA levels. SPY gates entries, not exit checks. Daily OHLC bars cannot establish intraday ordering: when a stop and target both cross on a later bar, the stop is assumed first, and Setup C cannot take profit from its entry bar's high.

## Project layout

| Path | Purpose |
| --- | --- |
| `strategy-core/` | Pure indicators and strategy rules shared by the Worker and simulator. |
| `src/backtest/` | Worker-compatible Backtest Durable Object, config validation, SQLite cache, and simulator. |
| `src/data.ts` | Shared server-side Alpaca market-data client, including historical downloads. |
| `public/admin/index.html` | WTrack Admin page. |
| `public/admin/admin.js` | Admin actions and paper-trading controls. |
| `public/admin/backtest.html` | Integrated Backtest UI, using the shared WTrack top menu and theme. |
| `backtest.config.json` | User-editable backtest defaults. |
| `.wrangler/` | Ignored local Worker and Durable Object state. |

The same-origin endpoints are `GET /admin/backtest/config`, `GET /admin/backtest/cache`, `POST /admin/backtest/run`, and `POST /admin/backtest/refresh`. POST requests validate the request origin and configuration; failures are displayed in the UI.

WTrack deployment through a configured GitHub connector remains automatic. The `BACKTEST` binding and its SQLite Durable Object migration are declared in `wrangler.toml`.
