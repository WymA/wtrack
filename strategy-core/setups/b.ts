import { closeContext, hasUpwardSlope } from "../shared.ts";
import type { Bar, CloseStrategyDefinition, IndicatorSeries } from "../types.ts";

export const strategyB = {
  id: "Setup B",
  code: "B",
  name: "Deep Value Reclaim",
  timing: "close",
  description: "Right-side entry: rising 200 EMA, a pullback near the 100 or 200 EMA within 15 sessions without closing more than 3% below the 200 EMA, then a reclaim above the 20/50 EMAs with a bullish cross in the last 5 sessions. Enters next session's open.",
  evaluate(bars: readonly Bar[], indicators: IndicatorSeries): boolean {
    const context = closeContext(bars, indicators);
    if (!context) return false;
    const { index, today, ema20, ema50 } = context;
    const macroTrendUp = hasUpwardSlope(indicators.ema200, index);
    const recentDeepPullback = bars.slice(Math.max(0, index - 15), index).some((bar, offset) => {
      const barIndex = Math.max(0, index - 15) + offset;
      const pullbackEma100 = indicators.ema100[barIndex];
      const pullbackEma200 = indicators.ema200[barIndex];
      return pullbackEma100 !== undefined && pullbackEma200 !== undefined &&
        (bar.low <= pullbackEma100 * 1.01 || bar.low <= pullbackEma200 * 1.01) &&
        bar.close >= pullbackEma200 * 0.97;
    });
    const reclaimedShortTermAverages = today.close > ema20 && today.close > ema50;
    const recentBullishCross = Array.from(
      { length: Math.min(5, index + 1) },
      (_, offset) => index - Math.min(4, index) + offset
    ).some((crossIndex) => {
      if (crossIndex <= 0) return false;
      const current20 = indicators.ema20[crossIndex];
      const current50 = indicators.ema50[crossIndex];
      const previous20 = indicators.ema20[crossIndex - 1];
      const previous50 = indicators.ema50[crossIndex - 1];
      return current20 !== undefined && current50 !== undefined &&
        previous20 !== undefined && previous50 !== undefined &&
        previous20 <= previous50 && current20 > current50;
    });
    return macroTrendUp && recentDeepPullback && reclaimedShortTermAverages && recentBullishCross;
  }
} as const satisfies CloseStrategyDefinition;
