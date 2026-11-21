import { hasUpwardSlope } from "../shared.ts";
import { v1RegimePasses } from "../market.ts";
import { configuredPosition, configuredTarget, initializeConfiguredPosition } from "../positions.ts";
import { emptyUniverseState, evaluateConfiguredExit } from "../exits.ts";
import type {
  Bar, IndicatorSeries, StrategyEntryCandidate, StrategyEntryContext, StrategyExitContext,
  StrategyExitEvaluation, StrategyPositionContext, StrategyPositionRules, SupportStrategyDefinition
} from "../types.ts";

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

export function evaluateEntry(context: StrategyEntryContext): StrategyEntryCandidate[] {
  if (context.timing !== "intraday") return [];
  const { ticker, bars, indicators } = context.instrument;
  const entry = evaluateSupportTouch(bars, indicators, context.session);
  return entry ? [{ ticker, ...entry }] : [];
}

export function evaluateExit(context: StrategyExitContext): StrategyExitEvaluation {
  const { position, instrument, config } = context;
  const state = { ...position.state };
  const bar = instrument.bars.at(-1);
  if (!bar) return { signal: null, reason: null, immediate: false, state };
  let failure = false;
  if (state.support !== undefined && state.leftSideFailureClosesRemaining > 0 &&
    supportFailure(bar.close, state.support, config.stops.leftSideFailurePercent)) {
    failure = true;
  } else {
    if (state.leftSideFailureClosesRemaining > 0) state.leftSideFailureClosesRemaining -= 1;
    const ema50 = instrument.indicators.ema50.at(-1);
    if (ema50 !== undefined && bar.close > ema50) state.standardExitsArmed = true;
  }
  const trailing = evaluateConfiguredExit({ ...context, position: { ...position, state } });
  return trailing.reason ? trailing : {
    signal: failure ? "Hard Stop" : null,
    reason: failure ? "Left-side failure" : null,
    immediate: false,
    state
  };
}

export function initializePosition(context: StrategyPositionContext): StrategyPositionRules | null {
  const support = context.candidate.support;
  if (support === undefined) return null;
  const configured = initializeConfiguredPosition(context);
  if (!configured) return null;
  const stopPrice = Math.max(configured.stopPrice, support * (1 - context.config.stops.leftSideFailurePercent / 100));
  return {
    stopPrice,
    targetPrice: configuredTarget(context.config, context.entryPrice, stopPrice),
    state: { ...configured.state, support, leftSideFailureClosesRemaining: 2, standardExitsArmed: false }
  };
}

export const prepareUniverse = emptyUniverseState;

export const strategyC = {
  id: "Setup C",
  code: "C",
  name: "Support Touch",
  timing: "intraday",
  entry: {
    description: "Left-side entry: rising 200 EMA and yesterday's close above the 100 or 200 EMA; buy an intraday touch within 0.5% above prior-session support. Uses a support-failure stop; standard EMA exits arm only after a 50 EMA reclaim.",
    regimePasses: v1RegimePasses,
    evaluate: evaluateEntry
  },
  exit: {
    description: "Protective stop and two-session support failure; optional EMA trailing arms only after reclaiming EMA50. No profit target from the intraday entry bar's high.",
    needsUniverse: false,
    prepare: prepareUniverse,
    evaluate: evaluateExit
  },
  position: {
    ...configuredPosition,
    description: "Configured V1 sizing and target, with a support-failure floor on the initial stop.",
    allowEntryDayTarget: false,
    initialize: initializePosition
  }
} as const satisfies SupportStrategyDefinition;
