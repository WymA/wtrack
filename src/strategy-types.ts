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
}

export type RightSideSetup = "Setup A" | "Setup B";
export type EntrySetup = RightSideSetup | "Setup C";
export type ExitSignal = "Exit Tier 2" | "Exit Tier 3";
export type SignalType = RightSideSetup | ExitSignal;
