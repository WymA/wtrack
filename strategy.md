# Trading Strategies

Daily, long-only US equity signal rules (alert-only; no automated order execution or shorting).
The pure indicators and setup rules are shared by WTrack's signal scanner and integrated backtester from `strategy-core/`.
Display badges use A/B/C/D for entries and A1/A2/A3 for protective-stop/50-EMA/100-EMA exits. Internal V1 signal identifiers retain their existing names. A1 also identifies V2 hard stops; momentum rotation retains its descriptive label.

---

## Strategy V1

### 1. Indicators & Definitions
- **Timeframe:** Daily (`1D`) OHLC candles (minimum 300 bars).
- **EMAs:** `20`, `50`, `100`, and `200` calculated with `EMA[t] = Close[t] × 2/(N+1) + EMA[t-1] × (1 - 2/(N+1))`.
- **Rising EMA:** `EMA[today] > EMA[5 trading days ago]`.

### 2. Market Entry Filter
- Scan for **new buy setups** only when `SPY` closes above both its `50 EMA` and `200 EMA`.
- **Exit alerts** always run regardless of `SPY`.

### 3. Buy Setups

#### Setup A: Stacked Pullback (Right-Side)
1. **Stack:** `20 EMA > 50 EMA > 100 EMA > 200 EMA`.
2. **Trend:** Both `50 EMA` and `200 EMA` are rising.
3. **Pullback:** In the prior `1–3` trading days, daily `Low <= 20 EMA` and `Low > 99%` of that day's `50 EMA`.
4. **Trigger:** Today closes green (`Close > Open`), `Close > 20 EMA`, and `Close > High[yesterday]`.

#### Setup B: Deep Value Reclaim (Right-Side)
1. **Trend:** `200 EMA` is rising.
2. **Deep Test:** Within the prior `15` trading days, daily `Low <= 101%` of the `100 EMA` or `200 EMA`, and that day's `Close` was no more than `3%` below its `200 EMA`.
3. **Reclaim:** Today's `Close` is above both `20 EMA` and `50 EMA`.
4. **Cross:** `20 EMA` crossed above `50 EMA` within the last `5` trading days.

#### Setup C: Support Touch (Left-Side)
*Anticipatory entry at major support without waiting for a green close.*
1. **Trend:** `200 EMA` is rising.
2. **Setup:** Yesterday's `Close` was above the target support (`100 EMA` or `200 EMA`).
3. **Trigger:** Price drops intraday within `0.5%` of the `100 EMA` or `200 EMA` *(if scanning only at market close, alert when `Close` is within `2%` above support to place a next-day limit order)*.
4. **Risk Rule:** Place a hard stop-loss `2%–3%` below the target EMA.

### 4. Exit Alerts
- **Tier 2 (Standard):** `2` consecutive daily closes below `50 EMA`.
- **Tier 3 (Standard):** `2` consecutive daily closes below `100 EMA` *(may trigger on the same day as Tier 2)*.
- **Setup C Stop (Left-Side Only):** Immediate alert on a single daily close `> 3%` below the entry EMA on the entry day or the next day. Once price reclaims the `50 EMA`, switch to standard Tier 2/3 rules.

### 5. Alert Payload
Include for every alert:
- Ticker & signal type (`Setup A`, `Setup B`, `Setup C`, `Tier 2`, `Tier 3`, or `Setup C Stop`)
- Current `Close`
- `5-day` lowest `Low` (reference stop level)
- Current `20`, `50`, `100`, and `200` EMA values

### 6. Adding strategies

Each entry lives in its own `strategy-core/setups/` module with an ID, compact code, name, explanation, timing, and pure evaluator. A/B use `CloseStrategyDefinition`; C uses `SupportStrategyDefinition` for prior-session support entries; D uses `RankedStrategyDefinition` with watchlist and SPY context. Import and register new definitions in the ordered `strategies` array in `strategy-core/strategy.ts`; registration order defines close-signal priority.

The registry supplies entry types, allowed backtest setup IDs, strategy-card descriptions and selection controls, and simulator dispatch. Existing Worker and simulator callers continue to import the `strategy.ts` facade. Shared EMA exits live in `strategy-core/exits.ts`; market-regime and portfolio/risk controls stay separate from entry evaluators.

---

## Strategy V2

### 1. Indicators & Definitions
- **Timeframe:** Daily (`1D`) OHLC candles (minimum 300 bars).
- **EMAs:** `20`, `50`, `100`, and `200` calculated with `EMA[t] = Close[t] × 2/(N+1) + EMA[t-1] × (1 - 2/(N+1))`.
- **Rising EMA:** `EMA[today] > EMA[5 trading days ago]`.
- **Volatility (`ATR%`):** `ATR(20) / Close[today]`.
- **Momentum Score:** `(Return[126d] + Return[63d]) / (2 × ATR%[20d])`, where `Return[Nd] = (Close[today] - Close[N trading days ago]) / Close[N trading days ago]`.

### 2. Market Entry Filter
- Scan for **new buy setups** only when `SPY` closes above its `200 EMA`.
- When `SPY` closes below its `200 EMA`, pause all new entries while continuing to evaluate exit alerts on existing positions.

### 3. Buy Setup

#### Setup D: Volatility-Adjusted Momentum Rotation
1. **Stack:** `Close > 20 EMA > 50 EMA > 200 EMA`.
2. **Trend:** `200 EMA` is rising.
3. **Extension Limit:** Today's `Close` is no more than `8%` above the `20 EMA` (`Close <= 1.08 × 20 EMA`).
4. **Positive Momentum:** Both `63-day` (~3-month) and `126-day` (~6-month) returns are `> 0%`.
5. **Cross-Sectional Rank:** Stock ranks in the **top 15%** of the configured watchlist by `Momentum Score` (prioritized from highest score to lowest to fill equal-weight portfolio slots).

### 4. Exit Alerts
- **Initial Hard Stop:** Price hits `8%` (or `2.5 × ATR(14)`) below entry price.
- **Tier 2 (Standard Trailing):** `2` consecutive daily closes below `50 EMA` *(applies while unrealized gain is `< +25%`)*.
- **Tier 3 (Wide Winner Trailing):** Once a position reaches `>= +25%` unrealized gain, widen trailing exit to `2` consecutive daily closes below `100 EMA`.
- **Momentum Decay Rotation (Weekly):** Evaluated at Friday's close (executed Monday's open)—exit any position held for at least `15` trading days that closes below its `20 EMA` and falls out of the **top 30%** of the watchlist's `Momentum Score`.

### 5. Alert Payload
Include for every alert:
- Ticker & signal type (`Setup D`, `Hard Stop`, `Tier 2`, `Tier 3`, or `Momentum Rotation`)
- Current `Close`
- `Momentum Score` & watchlist percentile rank
- Reference stop level (`8%` / `2.5 × ATR(14)` below entry)
- Current `20`, `50`, `100`, and `200` EMA values

### 6. Implementation conventions

ATR uses Wilder smoothing with a simple true-range seed. Ranking includes all watchlist stocks with at least 300 bars and a valid score, before entry filters; ties are broken by ticker. Rank cutoffs round up to at least one stock for nonempty universes, and reported percentile is high-is-best (100 for the leader).

Backtests enter at the following trading open using equal-weight slots. `strategy.momentumStop` chooses `fixed-percent` (8%, default) or `atr` (2.5x signal-day ATR14); V1 sizing, profit targets and configurable EMA exits do not override D. A session high reaching +25% permanently latches wide trailing. Hard stops take priority when daily OHLC cannot determine intraday ordering. Holding time counts completed trading sessions since entry; Friday rotations execute at the next available trading open.

Scanner D signals track virtual next-open positions in KV, default to the 8% stop, and advance only on completed sessions. Exits continue for tracked symbols even after watchlist removal or a failed SPY gate. This ledger never submits orders and D alerts are excluded from optional A/B paper trading. Backtest configuration changes do not alter scanner settings.