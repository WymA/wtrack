import type { Bar, IndicatorSeries, SignalType } from "./types";

const MIN_HISTORY = 6;

function hasUpwardSlope(values: readonly number[], index: number): boolean {
  const current = values[index];
  const fiveDaysAgo = values[index - 5];
  return current !== undefined && fiveDaysAgo !== undefined && current > fiveDaysAgo;
}

export function marketRegimePasses(spyBars: readonly Bar[], spy: IndicatorSeries): boolean {
  const index = spyBars.length - 1;
  const latest = spyBars[index];
  const ema50 = spy.ema50[index];
  const ema200 = spy.ema200[index];
  return latest !== undefined && ema50 !== undefined && ema200 !== undefined &&
    latest.close > ema50 && latest.close > ema200;
}

export function evaluateBuySetup(
  bars: readonly Bar[],
  indicators: IndicatorSeries
): "Setup A" | "Setup B" | null {
  const index = bars.length - 1;
  if (index < MIN_HISTORY - 1) return null;

  const today = bars[index];
  const yesterday = bars[index - 1];
  const ema20 = indicators.ema20[index];
  const ema50 = indicators.ema50[index];
  const ema100 = indicators.ema100[index];
  const ema200 = indicators.ema200[index];

  if (
    today === undefined || yesterday === undefined ||
    ema20 === undefined || ema50 === undefined ||
    ema100 === undefined || ema200 === undefined
  ) {
    return null;
  }

  const perfectStack = ema20 > ema50 && ema50 > ema100 && ema100 > ema200;
  const trendSlopesUp =
    hasUpwardSlope(indicators.ema50, index) &&
    hasUpwardSlope(indicators.ema200, index);
  const recentPullbackToValue = bars.slice(Math.max(0, index - 3), index).some((bar, offset) => {
    const barIndex = Math.max(0, index - 3) + offset;
    const pullbackEma20 = indicators.ema20[barIndex];
    const pullbackEma50 = indicators.ema50[barIndex];
    return pullbackEma20 !== undefined && pullbackEma50 !== undefined &&
      bar.low <= pullbackEma20 && bar.low > pullbackEma50 * 0.99;
  });
  const bullishTrigger =
    today.close > today.open &&
    today.close > ema20 &&
    today.close > yesterday.high;

  if (perfectStack && trendSlopesUp && recentPullbackToValue && bullishTrigger) {
    return "Setup A";
  }

  const macroTrendUp = hasUpwardSlope(indicators.ema200, index);
  const recentDeepPullback = bars
    .slice(Math.max(0, index - 15), index)
    .some((bar, offset) => {
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

  if (macroTrendUp && recentDeepPullback && reclaimedShortTermAverages && recentBullishCross) {
    return "Setup B";
  }

  return null;
}

export function evaluateExitSignals(
  bars: readonly Bar[],
  indicators: IndicatorSeries
): SignalType[] {
  const index = bars.length - 1;
  if (index < 1) return [];

  const today = bars[index];
  const yesterday = bars[index - 1];
  const ema50Today = indicators.ema50[index];
  const ema50Yesterday = indicators.ema50[index - 1];
  const ema100Today = indicators.ema100[index];
  const ema100Yesterday = indicators.ema100[index - 1];
  if (
    today === undefined || yesterday === undefined ||
    ema50Today === undefined || ema50Yesterday === undefined ||
    ema100Today === undefined || ema100Yesterday === undefined
  ) {
    return [];
  }

  const signals: SignalType[] = [];
  if (today.close < ema50Today && yesterday.close < ema50Yesterday) {
    signals.push("Exit Tier 2");
  }
  if (today.close < ema100Today && yesterday.close < ema100Yesterday) {
    signals.push("Exit Tier 3");
  }
  return signals;
}
