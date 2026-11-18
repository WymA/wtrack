import type { Bar, IndicatorSeries } from "./strategy-types";

export function calculateEma(values: readonly number[], period: number): number[] {
  if (!Number.isInteger(period) || period <= 0) {
    throw new RangeError("EMA period must be a positive integer.");
  }
  if (values.length === 0) return [];

  const smoothing = 2 / (period + 1);
  const firstValue = values[0];
  if (firstValue === undefined) return [];

  const result = [firstValue];
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    const previousEma = result[index - 1];
    if (value === undefined || previousEma === undefined) {
      throw new Error("Cannot calculate EMA from incomplete values.");
    }
    result.push(value * smoothing + previousEma * (1 - smoothing));
  }

  return result;
}

export function calculateIndicators(bars: readonly Bar[]): IndicatorSeries {
  const closes = bars.map((bar) => bar.close);
  return {
    ema20: calculateEma(closes, 20),
    ema50: calculateEma(closes, 50),
    ema100: calculateEma(closes, 100),
    ema200: calculateEma(closes, 200)
  };
}
