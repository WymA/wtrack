import type {
  Bar, ExitSignal, IndicatorSeries, StrategyExitContext, StrategyExitEvaluation, StrategyUniverseState
} from "./types.ts";

export function emptyUniverseState(): StrategyUniverseState {
  return { ranks: [], retainedTickers: new Set() };
}

export function evaluateConfiguredExit(context: StrategyExitContext): StrategyExitEvaluation {
  const { position, instrument, config } = context;
  const signal = config.trailingExitEma === "disabled" || !position.state.standardExitsArmed
    ? null
    : evaluateExitSignals(instrument.bars, instrument.indicators)
      .find((signal) => signal === (config.trailingExitEma === "ema50" ? "Exit Tier 2" : "Exit Tier 3")) ?? null;
  return {
    signal,
    reason: signal ? `EMA trailing exit (${config.trailingExitEma})` : null,
    immediate: false,
    state: position.state
  };
}

export function evaluateExitSignals(bars: readonly Bar[], indicators: IndicatorSeries): ExitSignal[] {
  const index = bars.length - 1;
  if (index < 1) return [];
  const today = bars[index];
  const yesterday = bars[index - 1];
  const ema50Today = indicators.ema50[index];
  const ema50Yesterday = indicators.ema50[index - 1];
  const ema100Today = indicators.ema100[index];
  const ema100Yesterday = indicators.ema100[index - 1];
  if (today === undefined || yesterday === undefined ||
    ema50Today === undefined || ema50Yesterday === undefined ||
    ema100Today === undefined || ema100Yesterday === undefined) return [];
  const signals: ExitSignal[] = [];
  if (today.close < ema50Today && yesterday.close < ema50Yesterday) signals.push("Exit Tier 2");
  if (today.close < ema100Today && yesterday.close < ema100Yesterday) signals.push("Exit Tier 3");
  return signals;
}
