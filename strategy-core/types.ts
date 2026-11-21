export interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorSeries {
  ema20: number[];
  ema50: number[];
  ema100: number[];
  ema200: number[];
  atr14?: number[];
  atr20?: number[];
}

interface StrategyMetadata {
  id: string;
  code: string;
  name: string;
}

export interface MarketInstrument {
  ticker: string;
  bars: readonly Bar[];
  indicators: IndicatorSeries;
}

export interface RankedCandidate {
  ticker: string;
  score: number;
  rank: number;
  percentileRank: number;
  atr14: number;
}

export interface MomentumPosition {
  entryDate: string;
  entryPrice: number;
  stopPrice: number;
  wideTrailing: boolean;
}

export type MomentumStopType = "fixed-percent" | "atr";
export type EmaName = "ema20" | "ema50" | "ema100" | "ema200";
export type StopConfig =
  | { type: "swing-low"; lookback: number }
  | { type: "fixed-percent"; value: number }
  | { type: "ema-buffer"; ema: EmaName; bufferPercent: number };

export interface StrategyExecutionConfig {
  strategy: { momentumStop: MomentumStopType };
  stops: { initial: StopConfig; leftSideFailurePercent: number };
  profitTaking: { type: "fixed-percent" | "risk-multiple"; value: number; partialPercent: number };
  trailingExitEma: "disabled" | "ema50" | "ema100";
}

export type StrategyTiming = "close" | "intraday" | "ranked-close";
export type StrategyEntryContext =
  | { timing: "close"; instrument: MarketInstrument; benchmark?: MarketInstrument }
  | { timing: "intraday"; instrument: MarketInstrument; session: Pick<Bar, "open" | "low">; benchmark?: MarketInstrument }
  | { timing: "ranked-close"; universe: readonly MarketInstrument[]; benchmark: MarketInstrument };

export interface StrategyEntryCandidate {
  ticker: string;
  price?: number;
  support?: number;
  atr14?: number;
  score?: number;
  rank?: number;
  percentileRank?: number;
  data?: Record<string, string | number | boolean>;
}

export interface StrategyPositionState {
  support?: number;
  leftSideFailureClosesRemaining: number;
  standardExitsArmed: boolean;
  wideTrailing: boolean;
  [key: string]: string | number | boolean | undefined;
}

export interface StrategyPosition {
  entryDate: string;
  entryPrice: number;
  stopPrice: number;
  state: StrategyPositionState;
}

export interface StrategyPositionContext {
  entryDate: string;
  entryPrice: number;
  instrument: MarketInstrument;
  candidate: StrategyEntryCandidate;
  config: StrategyExecutionConfig;
}

export interface StrategyPositionRules {
  stopPrice: number;
  targetPrice: number;
  state: StrategyPositionState;
}

export interface StrategyUniverseState {
  ranks: readonly RankedCandidate[];
  retainedTickers: ReadonlySet<string>;
}

export interface StrategyExitContext {
  position: StrategyPosition;
  instrument: MarketInstrument;
  universeState: StrategyUniverseState;
  config: StrategyExecutionConfig;
}

export interface StrategyExitEvaluation {
  signal: ExitSignal | "Hard Stop" | "Momentum Rotation" | null;
  reason: string | null;
  immediate: boolean;
  state: StrategyPositionState;
}

export interface StrategyDefinition extends StrategyMetadata {
  timing: StrategyTiming;
  entry: {
    description: string;
    regimePasses(benchmark: MarketInstrument): boolean;
    evaluate(context: StrategyEntryContext): StrategyEntryCandidate[];
  };
  exit: {
    description: string;
    needsUniverse: boolean;
    prepare(universe: readonly MarketInstrument[]): StrategyUniverseState;
    evaluate(context: StrategyExitContext): StrategyExitEvaluation;
  };
  position: {
    description: string;
    sizing: "configured" | "equal-weight";
    markAtOpen: boolean;
    retainPendingEntry: boolean;
    allowEntryDayTarget: boolean;
    stopReason: string;
    initialize(context: StrategyPositionContext): StrategyPositionRules | null;
  };
}

export interface CloseStrategyDefinition extends StrategyDefinition { timing: "close" }
export interface SupportStrategyDefinition extends StrategyDefinition { timing: "intraday" }
export interface RankedStrategyDefinition extends StrategyDefinition { timing: "ranked-close" }
export type EntrySetup = typeof import("./strategy.ts").strategies[number]["id"];
export type RightSideSetup = Extract<
  typeof import("./strategy.ts").strategies[number], { timing: "close" }
>["id"];
export type ExitSignal = "Exit Tier 2" | "Exit Tier 3";
export type SignalType = EntrySetup | ExitSignal | "Hard Stop" | "Momentum Rotation";
