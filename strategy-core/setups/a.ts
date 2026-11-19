import { closeContext, hasUpwardSlope } from "../shared.ts";
import type { Bar, CloseStrategyDefinition, IndicatorSeries } from "../types.ts";

export const strategyA = {
  id: "Setup A",
  code: "A",
  name: "Stacked Pullback",
  timing: "close",
  description: "Right-side entry: bullish 20/50/100/200 EMA stack, rising 50 and 200 EMAs, a pullback to the 20 EMA within 3 sessions, then a green close above the 20 EMA and yesterday's high. Enters next session's open.",
  evaluate(bars: readonly Bar[], indicators: IndicatorSeries): boolean {
    const context = closeContext(bars, indicators);
    if (!context) return false;
    const { index, today, yesterday, ema20, ema50, ema100, ema200 } = context;
    const perfectStack = ema20 > ema50 && ema50 > ema100 && ema100 > ema200;
    const trendSlopesUp = hasUpwardSlope(indicators.ema50, index) && hasUpwardSlope(indicators.ema200, index);
    const recentPullbackToValue = bars.slice(Math.max(0, index - 3), index).some((bar, offset) => {
      const barIndex = Math.max(0, index - 3) + offset;
      const pullbackEma20 = indicators.ema20[barIndex];
      const pullbackEma50 = indicators.ema50[barIndex];
      return pullbackEma20 !== undefined && pullbackEma50 !== undefined &&
        bar.low <= pullbackEma20 && bar.low > pullbackEma50 * 0.99;
    });
    const bullishTrigger = today.close > today.open && today.close > ema20 && today.close > yesterday.high;
    return perfectStack && trendSlopesUp && recentPullbackToValue && bullishTrigger;
  }
} as const satisfies CloseStrategyDefinition;
