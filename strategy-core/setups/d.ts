import { calculateAtr } from "../indicators.ts";
import { evaluateExitSignals } from "../exits.ts";
import { hasUpwardSlope } from "../shared.ts";
import { initialPositionState } from "../positions.ts";
import type {
  Bar, IndicatorSeries, MarketInstrument, MomentumPosition, MomentumStopType,
  RankedCandidate, RankedStrategyDefinition, StrategyEntryContext,
  StrategyExitContext, StrategyExitEvaluation, StrategyPositionContext, StrategyPositionRules, StrategyUniverseState
} from "../types.ts";

export interface MomentumRank extends RankedCandidate {
  eligible: boolean;
}

export function momentumRegimePasses(voo: MarketInstrument): boolean {
  const index = voo.bars.length - 1;
  const close = voo.bars[index]?.close;
  const ema200 = voo.indicators.ema200[index];
  return close !== undefined && ema200 !== undefined && close > ema200;
}

export function rankMomentumUniverse(universe: readonly MarketInstrument[]): MomentumRank[] {
  const scores = universe.flatMap(({ ticker, bars, indicators }) => {
    const index = bars.length - 1;
    const today = bars[index];
    const previous63 = bars[index - 63];
    const previous126 = bars[index - 126];
    if (bars.length < 300 || !today || !previous63 || !previous126 ||
      today.close <= 0 || previous63.close <= 0 || previous126.close <= 0) return [];
    const atr20 = indicators.atr20?.[index] ?? calculateAtr(bars, 20)[index];
    const atr14 = indicators.atr14?.[index] ?? calculateAtr(bars, 14)[index];
    if (!atr20 || !atr14 || !Number.isFinite(atr20) || !Number.isFinite(atr14)) return [];
    const return63 = today.close / previous63.close - 1;
    const return126 = today.close / previous126.close - 1;
    const score = (return126 + return63) / (2 * atr20 / today.close);
    if (!Number.isFinite(score)) return [];
    const ema20 = indicators.ema20[index];
    const ema50 = indicators.ema50[index];
    const ema200 = indicators.ema200[index];
    const eligible = ema20 !== undefined && ema50 !== undefined && ema200 !== undefined &&
      today.close > ema20 && ema20 > ema50 && ema50 > ema200 &&
      today.close <= ema20 * 1.08 && hasUpwardSlope(indicators.ema200, index) &&
      return63 > 0 && return126 > 0;
    return [{ ticker, score, atr14, eligible }];
  }).sort((left, right) => right.score - left.score || left.ticker.localeCompare(right.ticker));
  return scores.map((score, index) => ({
    ...score, rank: index + 1, percentileRank: (1 - index / scores.length) * 100
  }));
}

export function momentumHardStop(entryPrice: number, atr14: number, type: MomentumStopType = "fixed-percent"): number {
  return entryPrice - (type === "atr" ? 2.5 * atr14 : entryPrice * 0.08);
}

export function evaluateMomentumExit(
  position: MomentumPosition,
  bars: readonly Bar[],
  indicators: IndicatorSeries,
  inTop30Percent: boolean
): { signal: StrategyExitEvaluation["signal"]; wideTrailing: boolean } {
  const bar = bars.at(-1);
  if (!bar) return { signal: null, wideTrailing: position.wideTrailing };
  if (bar.low <= position.stopPrice) return { signal: "Hard Stop", wideTrailing: position.wideTrailing };
  const wideTrailing = position.wideTrailing || bar.high >= position.entryPrice * 1.25;
  const trailing = wideTrailing ? "Exit Tier 3" : "Exit Tier 2";
  if (evaluateExitSignals(bars, indicators).includes(trailing)) return { signal: trailing, wideTrailing };
  const sessionsHeld = bars.filter((item) => item.timestamp.slice(0, 10) >= position.entryDate).length - 1;
  const date = bar.timestamp.slice(0, 10);
  if (new Date(`${date}T12:00:00Z`).getUTCDay() === 5 && sessionsHeld >= 15 &&
    bar.close < (indicators.ema20.at(-1) ?? 0) && !inTop30Percent) {
    return { signal: "Momentum Rotation", wideTrailing };
  }
  return { signal: null, wideTrailing };
}

export function evaluateEntry(context: StrategyEntryContext): RankedCandidate[] {
  if (context.timing !== "ranked-close" || !momentumRegimePasses(context.benchmark)) return [];
  const ranked = rankMomentumUniverse(context.universe);
  const cutoff = Math.max(1, Math.ceil(ranked.length * 0.15));
  return ranked.filter((candidate) => candidate.rank <= cutoff && candidate.eligible);
}

export function evaluateExit(context: StrategyExitContext): StrategyExitEvaluation {
  const { position, instrument, universeState } = context;
  const exit = evaluateMomentumExit(
    { ...position, wideTrailing: position.state.wideTrailing },
    instrument.bars,
    instrument.indicators,
    universeState.retainedTickers.has(instrument.ticker)
  );
  return {
    signal: exit.signal,
    reason: exit.signal === "Exit Tier 2" ? "EMA trailing exit (ema50)"
      : exit.signal === "Exit Tier 3" ? "EMA trailing exit (ema100)" : exit.signal,
    immediate: exit.signal === "Hard Stop",
    state: { ...position.state, wideTrailing: exit.wideTrailing }
  };
}

export function initializePosition(context: StrategyPositionContext): StrategyPositionRules | null {
  const stopPrice = momentumHardStop(context.entryPrice, context.candidate.atr14 ?? 0, context.config.strategy.momentumStop);
  return stopPrice > 0 ? {
    stopPrice,
    targetPrice: Number.POSITIVE_INFINITY,
    state: initialPositionState()
  } : null;
}

export function prepareUniverse(universe: readonly MarketInstrument[]): StrategyUniverseState {
  const ranks = rankMomentumUniverse(universe);
  const cutoff = Math.ceil(ranks.length * 0.3);
  return { ranks, retainedTickers: new Set(ranks.filter((rank) => rank.rank <= cutoff).map((rank) => rank.ticker)) };
}

export const strategyD = {
  id: "Setup D",
  code: "D",
  name: "Volatility-Adjusted Momentum Rotation (V2)",
  timing: "ranked-close",
  entry: {
    description: "VOO above its 200 EMA; rising 200 EMA and close > 20 > 50 > 200 EMA, at most 8% above the 20 EMA, positive 63/126-day returns and top-15% volatility-adjusted watchlist momentum. Next-open entries fill equal-weight slots. Uses an 8% or 2.5x ATR(14) stop, 50/100 EMA winner trailing and Friday momentum-decay rotation.",
    regimePasses: momentumRegimePasses,
    evaluate: evaluateEntry
  },
  exit: {
    description: "Hard stop, two-close EMA50 trailing, latched EMA100 trailing after a 25% intraday gain, and Friday rotation after 15 sessions outside the top 30% and below EMA20.",
    needsUniverse: true,
    prepare: prepareUniverse,
    evaluate: evaluateExit
  },
  position: {
    description: "Equal-weight slots; 8% or 2.5x signal-day ATR14 stop; no V1 profit target. Alert-only in the scanner.",
    sizing: "equal-weight",
    markAtOpen: true,
    retainPendingEntry: true,
    allowEntryDayTarget: true,
    stopReason: "Hard Stop",
    initialize: initializePosition
  }
} as const satisfies RankedStrategyDefinition;
