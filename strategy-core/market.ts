import type { Bar, IndicatorSeries, MarketInstrument } from "./types.ts";

export function marketRegimePasses(bars: readonly Bar[], indicators: IndicatorSeries): boolean {
  const index = bars.length - 1;
  const latest = bars[index];
  const ema50 = indicators.ema50[index];
  const ema200 = indicators.ema200[index];
  return latest !== undefined && ema50 !== undefined && ema200 !== undefined &&
    latest.close > ema50 && latest.close > ema200;
}

export function v1RegimePasses(benchmark: MarketInstrument): boolean {
  return marketRegimePasses(benchmark.bars, benchmark.indicators);
}
