# Strategy v1

Daily, long-only EMA trend-following signals. This strategy does not define short entries or place trades.

## Indicators

- Use daily OHLC candles and at least 300 bars.
- Calculate 20, 50, 100, and 200 EMAs with `EMA[t] = Close[t] × 2/(N+1) + EMA[t-1] × (1 - 2/(N+1))`.
- An EMA is rising when its value today is greater than its value five trading days ago.

## Entry filter

Consider new buy setups only when SPY closes above both its 50 EMA and 200 EMA. The filter does not suppress exit checks. QQQ is a reference benchmark and does not change this entry filter.

## Setup A: Stacked Pullback

All conditions must hold:

1. The EMAs are stacked `20 > 50 > 100 > 200`.
2. The 50 EMA and 200 EMA are rising.
3. During one of the prior 1–3 trading days, the low reached or fell below the 20 EMA while remaining above `99%` of that day's 50 EMA.
4. Today closes green, above the 20 EMA, and above yesterday's high.

## Setup B: Deep Value Reclaim

All conditions must hold:

1. The 200 EMA is rising.
2. During the prior 15 trading days, the low reached or fell below `101%` of the 100 EMA or 200 EMA, and that day's close was no more than `3%` below its 200 EMA.
3. Today's close is above both the 20 EMA and 50 EMA.
4. The 20 EMA crossed above the 50 EMA within the last five trading days.

## Exit alerts

Check held tickers regardless of the SPY entry filter:

- **Tier 2:** Alert after two consecutive daily closes below their respective 50 EMA values.
- **Tier 3:** Alert after two consecutive daily closes below their respective 100 EMA values.

Both exit alerts may apply to the same ticker on the same day.

## Alert details

Each alert identifies the ticker and setup or exit tier, and reports the current close, the lowest low from the most recent five trading days, and the 20/50/100/200 EMA values.