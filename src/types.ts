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

export type SignalType = "Setup A" | "Setup B" | "Exit Tier 2" | "Exit Tier 3";

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
}

export interface Env {
  STOCK_TRACKER_KV: KVNamespace;
  ALPACA_API_KEY: string;
  ALPACA_API_SECRET_KEY: string;
  WEBHOOK_URL: string;
  ADMIN_TOKEN: string;
  TELEGRAM_CHAT_ID?: string;
}
