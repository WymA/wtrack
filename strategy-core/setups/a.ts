import { closeContext, hasUpwardSlope } from "../shared.ts";
import { v1RegimePasses } from "../market.ts";
import { configuredPosition, initializeConfiguredPosition } from "../positions.ts";
import { emptyUniverseState, evaluateConfiguredExit } from "../exits.ts";
import type { CloseStrategyDefinition, StrategyEntryCandidate, StrategyEntryContext } from "../types.ts";

export function evaluateEntry(entry: StrategyEntryContext): StrategyEntryCandidate[] {
  if (entry.timing !== "close") return [];
  const { ticker, bars, indicators } = entry.instrument;
  const context = closeContext(bars, indicators);
  if (!context) return [];
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
  return perfectStack && trendSlopesUp && recentPullbackToValue && bullishTrigger ? [{ ticker }] : [];
}

export const evaluateExit = evaluateConfiguredExit;
export const initializePosition = initializeConfiguredPosition;
export const prepareUniverse = emptyUniverseState;

export const strategyA = {
  id: "Setup A",
  code: "A",
  name: "Stacked Pullback",
  timing: "close",
  entry: {
    description: "Right-side entry: bullish 20/50/100/200 EMA stack, rising 50 and 200 EMAs, a pullback to the 20 EMA within 3 sessions, then a green close above the 20 EMA and yesterday's high. Enters next session's open.",
    regimePasses: v1RegimePasses,
    evaluate: evaluateEntry
  },
  exit: {
    description: "Configured protective stop and partial profit target; optional two-close EMA50 or EMA100 trailing exit.",
    needsUniverse: false,
    prepare: prepareUniverse,
    evaluate: evaluateExit
  },
  position: { ...configuredPosition, initialize: initializePosition }
} as const satisfies CloseStrategyDefinition;
