Add a local-only backtesting application to this existing WTrack repository while sharing a single standalone strategy core. Choose the cleanest project organization and implementation details yourself while following these requirements:

### 1. Standalone Strategy Core
- Extract all indicator calculations and Strategy v1 rules into a completely standalone, pure module with zero dependencies on Cloudflare Workers, databases, file systems, or network clients.
- Refactor WTrack to consume this shared module so live signal tracking and backtesting always execute the exact same strategy logic.

### 2. Strict Local Isolation
- Keep the backtesting application and its stored data completely separate from the Cloudflare Worker entry point so deploying WTrack never bundles or uploads any backtest code or local data.
- Ignore local data and secret files from version control, and provide a single script command to run the backtester locally.

### 3. Single User-Editable Configuration
- Centralize all tunable backtest parameters into a single, clearly documented configuration file so I can easily adjust:
  - **Strategy Selection & Universe:** Toggle which setups are active (e.g., right-side setups only, left-side setup only, or all combined) and define the target stock watchlist.
  - **Date Window:** Set the simulation start date and end date (supporting up to the present trading day).
  - **Portfolio & Order Sizing:** Configure starting capital, maximum open positions, and position sizing rules (by risk percentage per trade, fixed dollar amount, or percentage of equity).
  - **Stop-Loss & Profit Limits:** Configure initial stop-loss rules (recent swing low, fixed percentage, or EMA buffer), immediate failure stops for left-side entries, profit-taking targets (fixed percentage or risk-multiple targets with optional partial trims), and EMA trailing exits.
  - **Trading Costs:** Configure slippage and per-order commission assumptions.

### 4. Local Historical Data Cache
- Store historical daily market bars in a local SQLite database using the existing local Alpaca API credentials.
- Automatically fetch sufficient warm-up history prior to the backtest start date so the 200 EMA is accurate from day one, ensure prices are split-adjusted, support incremental updates for new dates, and allow refreshing cached tickers cleanly.

### 5. Simulation Engine & Lightweight Local UI
- Simulate trades chronologically without look-ahead bias: execute signals confirmed at market close on the next trading day's open, and evaluate left-side support entries intraday against the prior day's EMA levels.
- Provide a lightweight, zero-build local web interface with dark mode support where I can run backtests, override config defaults, refresh cached market data, and inspect overall performance metrics alongside a completed trade log.