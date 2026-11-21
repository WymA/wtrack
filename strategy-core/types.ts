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
  description: string;
}

export interface CloseStrategyDefinition extends StrategyMetadata {
  timing: "close";
  evaluate(bars: readonly Bar[], indicators: IndicatorSeries): boolean;
}

export interface SupportStrategyDefinition extends StrategyMetadata {
  timing: "intraday";
  evaluate(
    priorBars: readonly Bar[],
    indicators: IndicatorSeries,
    session: Pick<Bar, "open" | "low">
  ): { support: number; price: number } | null;
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

export interface RankedStrategyDefinition extends StrategyMetadata {
  timing: "ranked-close";
  evaluate(universe: readonly MarketInstrument[], voo: MarketInstrument): RankedCandidate[];
}

export interface MomentumPosition {
  entryDate: string;
  entryPrice: number;
  stopPrice: number;
  wideTrailing: boolean;
}

export type MomentumStopType = "fixed-percent" | "atr";
export type StrategyDefinition = CloseStrategyDefinition | SupportStrategyDefinition | RankedStrategyDefinition;
export type EntrySetup = typeof import("./strategy.ts").strategies[number]["id"];
export type RightSideSetup = Extract<
  typeof import("./strategy.ts").strategies[number], { timing: "close" }
>["id"];
export type ExitSignal = "Exit Tier 2" | "Exit Tier 3";
export type SignalType = EntrySetup | ExitSignal | "Hard Stop" | "Momentum Rotation";
