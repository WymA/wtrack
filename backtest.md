# WTrack backtesting

The backtester shares WTrack's pure V1 A/B/C and V2 D indicators and setup rules, uses split-adjusted Alpaca IEX daily bars, and only simulates trades. It never submits orders.

## Open Backtest

Locally, run `pnpm install`, put Alpaca market-data credentials in the ignored `.dev.vars` file, and start WTrack with `pnpm dev`. Choose **Backtest** in the top menu or open `http://localhost:8787/admin/backtest.html`. `pnpm backtest` is an alias for starting the same WTrack server.

On the deployed Worker, the same menu, page, and APIs run simulations directly in WTrack, using the deployed Alpaca secrets. No local server or additional startup command is required. Backtest requests never contact Alpaca's order API. Protect `/admin` and `/admin/*` with Cloudflare Access; there is no application-level login.

## Configure and run

### Terminal command

Run directly without starting `pnpm dev`:

```sh
pnpm backtest:run
pnpm backtest:run --config backtest.config.json --output-dir backtest-data/logs
pnpm backtest:run --url https://your-worker.example
```

By default, the command starts its own local Worker on an available loopback port, waits for readiness, runs the backtest, and shuts it down on completion, failure, or interruption. It uses `.dev.vars` credentials and the same persistent `.wrangler/` history cache as `pnpm dev`. No separate server command is needed. With `--url`, it connects to the specified existing Worker without starting or stopping it.

The command reads the specified JSON file (default: `backtest.config.json`) and sends it as a draft to the Worker API, not the online saved configuration. `today` is resolved by the Worker when the run starts. It never saves settings or submits orders. `pnpm backtest` still starts the local Worker for the web UI.

The terminal and timestamped `.log` show completed trades and open positions first, with the metrics summary at the end. The accompanying `.json` contains the original requested config and full API response, including the resolved config, equity curve, and cache/download details. Logs default to ignored `backtest-data/logs`; custom output directories should also be kept out of Git. Failed runs exit with a nonzero status and write the error to the text log. Use `pnpm backtest:run --help` for options. Deployed Workers behind Cloudflare Access require access from the terminal; the command does not bypass access controls.

Net profit is bold green for gains and bold red for losses in a terminal; text logs and redirected output remain plain. `FORCE_COLOR=1` enables color for redirected output, and `NO_COLOR` disables it. The command selectively suppresses `DEP0040` from Wrangler's bundled `whatwg-url` dependency; other warnings remain visible.

### Online configuration

[`backtest.config.json`](./backtest.config.json) supplies the initial deployment defaults. The Backtest page shows strategy explanation cards with entry checkboxes and a JSON editor. Both edit only the current draft. **Run backtest** uses that draft without saving it.

There is one online configuration: no filenames, selectors, or file imports. **Reload saved config** discards unsaved edits. Click **Save config** to persist the validated draft in the Backtest Durable Object, overriding the bundled seed across restarts and deployments. Saving never rewrites repository files or changes the signal scanner/paper-trading settings. Local and deployed saved settings are independent. `today` remains relative and resolves when a backtest runs.

**Run backtest** updates missing cached data before simulating. **Refresh cached bars** re-downloads the configured universe and VOO, replacing each ticker's cache with the requested history window only after a successful, nonempty download. Neither operation saves config edits.

| Configuration | Choices and units |
| --- | --- |
| `strategy.setups` | Any combination of V1 `Setup A`, `Setup B` (right-side), `Setup C` (left-side), and V2 `Setup D` (ranked momentum). Defaults remain A/B/C; select D explicitly. |
| `strategy.momentumStop` | D only: `fixed-percent` (default, 8% below fill) or `atr` (2.5x signal-day ATR14 below fill). |
| `strategy.watchlist` | 1-200 unique uppercase ticker symbols. VOO is added for the entry regime gate and performance benchmark. |
| `dateWindow` | `start` and `end` as `YYYY-MM-DD`; `end` also accepts `today`, using New York time. An in-progress daily bar is excluded before 4 p.m. New York time. |
| `portfolio` | Starting capital in USD and maximum open positions across all strategies. V1 sizing: `risk-percent`, `fixed-dollar`, or `equity-percent`; 1 means 1%. D uses equal-weight slots (`equity / maxOpenPositions`) instead. All entries are capped by cash. |
| `stops.initial` | V1: `swing-low` with a bar `lookback`; `fixed-percent` with a percentage `value`; or `ema-buffer` with an `ema` (`ema20`, `ema50`, `ema100`, `ema200`) and `bufferPercent`. |
| `stops.leftSideFailurePercent` | Setup C's hard-stop percentage below the touched support. Its separate close-confirmed failure check applies on the entry day and following session. |
| `profitTaking` | V1: a `fixed-percent` target or `risk-multiple` target with a `value`; `partialPercent` sells 1-100% of the original position at the target. D does not use these targets. |
| `trailingExitEma` | V1: `disabled`, `ema50`, or `ema100`. Requires two consecutive closes below the selected EMA; C arms these exits after reclaiming EMA50. Does not override D's automatic trailing rules. |
| `costs` | Adverse `slippagePercent` per side and USD `commissionPerOrder`. Partial trims incur a separate commission. |

Entry badges are **A/B/C/D**. Exit badges are **A1** for protective stops, **A2** for the 50 EMA exit, and **A3** for the 100 EMA exit; hover over a trade badge for its full reason. Profit targets and momentum rotation retain descriptive labels. Existing colors and V1 execution rules are unchanged.

### Strategy D (V2)

D ranks the watchlist by `(126-day return + 63-day return) / (2 * ATR20 / close)`. ATR uses Wilder smoothing. Stocks with at least 300 bars and valid scores participate in ranking, including those failing entry conditions; ties use ticker order. Top-15% entry and top-30% retention cutoffs round up, with at least one stock in a nonempty ranked universe.

Entries require VOO above EMA200, positive 63/126-day returns, a rising EMA200, `close > EMA20 > EMA50 > EMA200`, and a close no more than 8% above EMA20. Highest-score candidates fill equal-weight slots at the next trading open, before V1 close candidates when mixed together. One position per ticker is shared across strategies.

D has its own hard stop and two-close EMA50 trailing exit. Once a session high reaches a 25% gain, EMA100 trailing is permanently latched for that position. At Friday's close, positions held for at least 15 elapsed trading sessions also exit if below EMA20 and outside the top 30%; execution is at the next trading open, allowing for holidays. Stops remain active regardless of VOO. D has no fixed profit target.

The scanner uses the same rules with an alert-only virtual position ledger, assuming next-open entries and an 8% stop. It replays missed completed sessions with sufficient indicator warm-up and keeps checking tracked symbols removed from the watchlist. D alerts include score, high-is-best percentile, reference stop, and EMAs. They never enter automated paper trading; selecting ATR stops or saving settings here affects only backtests.

Results include the requested date window and actual simulated trading period, return, ending equity, drawdown, win rate, profit factor, completed trades, and remaining open positions. VOO is automatically downloaded and cached for both the market-entry filter and simulation calendar, and as a buy-and-hold benchmark for the same simulated period: first session's open to last session's close, using split-adjusted prices without dividends or trading costs. Its return is shown as unavailable if either boundary price is invalid or there are no simulated sessions.

## Data and execution assumptions

History is stored in the dedicated `BACKTEST` SQLite-backed Durable Object, independently of paper trading. Wrangler persists local data under ignored `.wrangler/`; deployed data stays in Cloudflare and is shared by this WTrack deployment. These caches are separate, and the previous standalone `backtest-data/` cache is not imported or deleted.

Downloads include 600 calendar days of warm-up before the start date; every simulated ticker and VOO must have at least 300 prior daily bars. Newly listed tickers may not have enough history. Regular runs reuse the cache and incrementally fetch missing dates; refresh after historical price adjustments. A deployment permits one simulation or refresh at a time; concurrent submissions return an actionable error. Large universes and long windows are subject to your Cloudflare plan's runtime and subrequest limits.

Close-confirmed right-side signals execute at the next trading session's open. Setup C evaluates intraday touches against the prior session's EMA levels. VOO gates entries, not exit checks: V1 requires VOO above EMA50 and EMA200; V2/D requires only EMA200. Daily OHLC bars cannot establish intraday ordering: when a stop and target both cross on a later bar, the stop is assumed first, and Setup C cannot take profit from its entry bar's high.

## Project layout

| Path | Purpose |
| --- | --- |
| `strategy-core/strategy.ts` | Shared registry and evaluation facade for all strategies. |
| `strategy-core/setups/` | Separate A/B/C/D entry rules and strategy-card descriptions; D also owns shared momentum ranking and position-exit logic. |
| `strategy-core/exits.ts` | Shared EMA exit rules. |
| `src/backtest/` | Worker-compatible Backtest Durable Object, config validation, SQLite cache, and simulator. |
| `src/data.ts` | Shared server-side Alpaca market-data client, including historical downloads. |
| `public/admin/index.html` | WTrack Admin page. |
| `public/admin/admin.js` | Admin actions and paper-trading controls. |
| `public/admin/backtest.html` | Integrated Backtest UI, using the shared WTrack top menu and theme. |
| `src/backtest/configs.ts` | One validated online configuration persisted in Durable Object SQLite. |
| `src/momentum-signals.ts` | Alert-only D position tracking and completed-session replay in Worker KV. |
| `backtest.config.json` | User-editable deployment seed; saved overrides take precedence. |
| `.wrangler/` | Ignored local Worker and Durable Object state. |

The same-origin endpoints are `GET /admin/backtest/config` (saved settings and strategy descriptions), `GET /admin/backtest/cache`, `POST /admin/backtest/save` (`config`), `POST /admin/backtest/run`, and `POST /admin/backtest/refresh`. Run/refresh accept a draft `config`, or use the saved configuration when omitted. POST requests validate the request origin and configuration; failures are displayed in the UI.

WTrack deployment through a configured GitHub connector remains automatic. The `BACKTEST` binding and its SQLite Durable Object migration are declared in `wrangler.toml`.
