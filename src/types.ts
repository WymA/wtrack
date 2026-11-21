import type { SignalType } from "./strategy-types";
import type { EntrySetup } from "../strategy-core/types";
export type { Bar, IndicatorSeries, SignalType } from "./strategy-types";

export interface StockAlert {
  ticker: string;
  type: SignalType;
  date: string;
  close: number;
  stopLoss: number;
  ema20: number;
  ema50: number;
  ema100: number;
  ema200: number;
  strategy?: EntrySetup;
  momentumScore?: number | null;
  percentileRank?: number | null;
}

export interface Env {
  WTRACK_KV: KVNamespace;
  PAPER_TRADING: DurableObjectNamespace;
  BACKTEST: DurableObjectNamespace;
  ASSETS: Fetcher;
  ALPACA_API_KEY: string;
  ALPACA_API_SECRET_KEY: string;
  WEBHOOK_URL?: string | null;
  TELEGRAM_CHAT_ID?: string;
}
