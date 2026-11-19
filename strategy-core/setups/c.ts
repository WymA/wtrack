import { hasUpwardSlope } from "../shared.ts";
import type { Bar, IndicatorSeries, SupportStrategyDefinition } from "../types.ts";

export function evaluateSupportTouch(
  priorBars: readonly Bar[],
  indicators: IndicatorSeries,
  session: Pick<Bar, "open" | "low">
): { support: number; price: number } | null {
  const index = priorBars.length - 1;
  if (!hasUpwardSlope(indicators.ema200, index)) return null;
  const yesterday = priorBars[index];
  if (!yesterday) return null;
  const levels = [indicators.ema100[index], indicators.ema200[index]]
    .filter((level) => level !== undefined && yesterday.close > level)
    .sort((left, right) => right - left);
  for (const support of levels) {
    const limit = support * 1.005;
    if (session.low <= limit) return { support, price: Math.min(session.open, limit) };
  }
  return null;
}

export function supportFailure(close: number, support: number, percent = 3): boolean {
  return close < support * (1 - percent / 100);
}

export const strategyC = {
  id: "Setup C",
  code: "C",
  name: "Support Touch",
  timing: "intraday",
  description: "Left-side entry: rising 200 EMA and yesterday's close above the 100 or 200 EMA; buy an intraday touch within 0.5% above prior-session support. Uses a support-failure stop; standard EMA exits arm only after a 50 EMA reclaim.",
  evaluate: evaluateSupportTouch
} as const satisfies SupportStrategyDefinition;
