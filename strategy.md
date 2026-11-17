# Strategy v1

Daily, long-only EMA signal rules (alert-only; no automated order execution or shorting).

## 1. Indicators & Definitions
- **Timeframe:** Daily (`1D`) OHLC candles (minimum 300 bars).
- **EMAs:** `20`, `50`, `100`, and `200` calculated with `EMA[t] = Close[t] × 2/(N+1) + EMA[t-1] × (1 - 2/(N+1))`.
- **Rising EMA:** `EMA[today] > EMA[5 trading days ago]`.

## 2. Market Entry Filter
- Scan for **new buy setups** only when `SPY` closes above both its `50 EMA` and `200 EMA`.
- **Exit alerts** always run regardless of `SPY`.

## 3. Buy Setups

### Setup A: Stacked Pullback (Right-Side)
1. **Stack:** `20 EMA > 50 EMA > 100 EMA > 200 EMA`.
2. **Trend:** Both `50 EMA` and `200 EMA` are rising.
3. **Pullback:** In the prior `1–3` trading days, daily `Low <= 20 EMA` and `Low > 99%` of that day's `50 EMA`.
4. **Trigger:** Today closes green (`Close > Open`), `Close > 20 EMA`, and `Close > High[yesterday]`.

### Setup B: Deep Value Reclaim (Right-Side)
1. **Trend:** `200 EMA` is rising.
2. **Deep Test:** Within the prior `15` trading days, daily `Low <= 101%` of the `100 EMA` or `200 EMA`, and that day's `Close` was no more than `3%` below its `200 EMA`.
3. **Reclaim:** Today's `Close` is above both `20 EMA` and `50 EMA`.
4. **Cross:** `20 EMA` crossed above `50 EMA` within the last `5` trading days.

### Setup C: Support Touch (Left-Side)
*Anticipatory entry at major support without waiting for a green close.*
1. **Trend:** `200 EMA` is rising.
2. **Setup:** Yesterday's `Close` was above the target support (`100 EMA` or `200 EMA`).
3. **Trigger:** Price drops intraday within `0.5%` of the `100 EMA` or `200 EMA` *(if scanning only at market close, alert when `Close` is within `2%` above support to place a next-day limit order)*.
4. **Risk Rule:** Place a hard stop-loss `2%–3%` below the target EMA.

## 4. Exit Alerts
- **Tier 2 (Standard):** `2` consecutive daily closes below `50 EMA`.
- **Tier 3 (Standard):** `2` consecutive daily closes below `100 EMA` *(may trigger on the same day as Tier 2)*.
- **Setup C Stop (Left-Side Only):** Immediate alert on a single daily close `> 3%` below the entry EMA on the entry day or the next day. Once price reclaims the `50 EMA`, switch to standard Tier 2/3 rules.

## 5. Alert Payload
Include for every alert:
- Ticker & signal type (`Setup A`, `Setup B`, `Setup C`, `Tier 2`, `Tier 3`, or `Setup C Stop`)
- Current `Close`
- `5-day` lowest `Low` (reference stop level)
- Current `20`, `50`, `100`, and `200` EMA values