import type {
  StrategyExecutionConfig, StrategyPositionContext, StrategyPositionRules, StrategyPositionState
} from "./types.ts";
import { recentSwingLow } from "./shared.ts";

export function initialPositionState(): StrategyPositionState {
  return { leftSideFailureClosesRemaining: 0, standardExitsArmed: true, wideTrailing: false };
}

export function configuredTarget(config: StrategyExecutionConfig, entryPrice: number, stopPrice: number): number {
  return config.profitTaking.type === "fixed-percent"
    ? entryPrice * (1 + config.profitTaking.value / 100)
    : entryPrice + (entryPrice - stopPrice) * config.profitTaking.value;
}

export function initializeConfiguredPosition(context: StrategyPositionContext): StrategyPositionRules | null {
  const { config, entryPrice, instrument } = context;
  const initial = config.stops.initial;
  let stopPrice: number;
  if (initial.type === "swing-low") {
    stopPrice = recentSwingLow(instrument.bars, initial.lookback);
  } else if (initial.type === "fixed-percent") {
    stopPrice = entryPrice * (1 - initial.value / 100);
  } else {
    const ema = instrument.indicators[initial.ema].at(-1);
    if (ema === undefined) return null;
    stopPrice = ema * (1 - initial.bufferPercent / 100);
  }
  return {
    stopPrice,
    targetPrice: configuredTarget(config, entryPrice, stopPrice),
    state: initialPositionState()
  };
}

export const configuredPosition = {
  description: "Configured V1 sizing, initial stop, partial profit target, and optional EMA trailing exit.",
  sizing: "configured",
  markAtOpen: false,
  retainPendingEntry: false,
  allowEntryDayTarget: true,
  stopReason: "Initial stop",
  initialize: initializeConfiguredPosition
} as const;
