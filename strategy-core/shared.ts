import type { Bar, IndicatorSeries } from "./types.ts";

export function hasUpwardSlope(values: readonly number[], index: number): boolean {
  const current = values[index];
  const fiveDaysAgo = values[index - 5];
  return current !== undefined && fiveDaysAgo !== undefined && current > fiveDaysAgo;
}

export function closeContext(bars: readonly Bar[], indicators: IndicatorSeries) {
  const index = bars.length - 1;
  if (index < 5) return null;
  const today = bars[index];
  const yesterday = bars[index - 1];
  const ema20 = indicators.ema20[index];
  const ema50 = indicators.ema50[index];
  const ema100 = indicators.ema100[index];
  const ema200 = indicators.ema200[index];
  if (today === undefined || yesterday === undefined || ema20 === undefined ||
    ema50 === undefined || ema100 === undefined || ema200 === undefined) return null;
  return { index, today, yesterday, ema20, ema50, ema100, ema200 };
}
