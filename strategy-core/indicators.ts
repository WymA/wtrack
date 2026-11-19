import type { Bar, IndicatorSeries } from "./types.ts";

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
    ema200: calculateEma(closes, 200),
    atr14: calculateAtr(bars, 14),
    atr20: calculateAtr(bars, 20)
  };
}

export function calculateAtr(bars: readonly Bar[], period: number): number[] {
  if (!Number.isInteger(period) || period <= 0) throw new RangeError("ATR period must be a positive integer.");
  const result = Array<number>(bars.length).fill(Number.NaN);
  let total = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const previousClose = bars[index - 1]?.close ?? bar.close;
    const range = Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    if (index < period) total += range;
    if (index === period - 1) result[index] = total / period;
    else if (index >= period) result[index] = (result[index - 1]! * (period - 1) + range) / period;
  }
  return result;
}
