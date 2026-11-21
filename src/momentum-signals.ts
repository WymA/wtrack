import { calculateIndicators } from "../strategy-core/indicators";
import {
  evaluateMomentumExit, evaluateRankedSetups, momentumHardStop, rankMomentumUniverse, REQUIRED_DAILY_BARS
} from "../strategy-core/strategy";
import type { MarketInstrument, MomentumPosition } from "../strategy-core/types";
import type { Bar, StockAlert } from "./types";

export const MOMENTUM_STATE_KEY = "momentum-signal-state";

interface TrackedSignal {
  ticker: string;
  signalDate: string;
  atr14: number;
  entry: MomentumPosition | null;
  exitPending: boolean;
}

export interface MomentumSignalState {
  date: string;
  positions: TrackedSignal[];
  alerts: StockAlert[];
}

export function parseMomentumState(value: string | null): MomentumSignalState {
  if (value === null) return { date: "", positions: [], alerts: [] };
  const parsed = JSON.parse(value) as MomentumSignalState;
  if (!parsed || typeof parsed.date !== "string" || !Array.isArray(parsed.positions) ||
    !Array.isArray(parsed.alerts) || !parsed.positions.every((position) =>
      typeof position.ticker === "string" && typeof position.signalDate === "string" &&
      Number.isFinite(position.atr14) && typeof position.exitPending === "boolean" &&
      (position.entry === null || (typeof position.entry?.entryDate === "string" &&
        Number.isFinite(position.entry.entryPrice) && Number.isFinite(position.entry.stopPrice) &&
        typeof position.entry.wideTrailing === "boolean")))) {
    throw new Error("Stored momentum signal state is invalid.");
  }
  return parsed;
}

function alertFor(
  instrument: MarketInstrument,
  type: StockAlert["type"],
  stopLoss: number,
  rank: ReturnType<typeof rankMomentumUniverse>[number] | undefined
): StockAlert {
  const bar = instrument.bars.at(-1)!;
  const indicators = instrument.indicators;
  return {
    ticker: instrument.ticker, type, strategy: "Setup D",
    date: bar.timestamp.slice(0, 10), close: bar.close, stopLoss,
    ema20: indicators.ema20.at(-1)!, ema50: indicators.ema50.at(-1)!,
    ema100: indicators.ema100.at(-1)!, ema200: indicators.ema200.at(-1)!,
    momentumScore: rank?.score ?? null, percentileRank: rank?.percentileRank ?? null
  };
}

export function advanceMomentumSignals(
  previous: MomentumSignalState,
  date: string,
  watchlist: readonly string[],
  data: Record<string, Bar[]>
): MomentumSignalState {
  if (previous.date >= date) return previous;
  const state: MomentumSignalState = {
    date: previous.date, alerts: [],
    positions: previous.positions.map((position) => ({
      ...position, entry: position.entry ? { ...position.entry } : null
    }))
  };
  const sessions = previous.date
    ? (data.VOO ?? []).map((bar) => bar.timestamp.slice(0, 10)).filter((day) => day > previous.date && day <= date)
    : [date];
  for (const session of sessions) {
    const instruments = new Map<string, MarketInstrument>();
    for (const ticker of new Set(["VOO", ...watchlist, ...state.positions.map((position) => position.ticker)])) {
      const bars = (data[ticker] ?? []).filter((bar) => bar.timestamp.slice(0, 10) <= session).slice(-REQUIRED_DAILY_BARS);
      if (bars.at(-1)?.timestamp.slice(0, 10) !== session) continue;
      instruments.set(ticker, { ticker, bars, indicators: calculateIndicators(bars) });
    }
    const voo = instruments.get("VOO");
    if (!voo) continue;
    const universe = watchlist.flatMap((ticker) => instruments.get(ticker) ? [instruments.get(ticker)!] : []);
    const ranks = rankMomentumUniverse(universe);
    const rankByTicker = new Map(ranks.map((rank) => [rank.ticker, rank]));
    const cutoff = Math.ceil(ranks.length * 0.3);
    const alerts: StockAlert[] = [];
    const remaining: TrackedSignal[] = [];
    for (const position of state.positions) {
      const instrument = instruments.get(position.ticker);
      if (!instrument || position.signalDate >= session) {
        remaining.push(position);
        continue;
      }
      if (position.exitPending) continue;
      if (!position.entry) {
        const price = instrument.bars.at(-1)!.open;
        position.entry = {
          entryDate: session, entryPrice: price, stopPrice: momentumHardStop(price, position.atr14),
          wideTrailing: false
        };
      }
      const rank = rankByTicker.get(position.ticker);
      const exit = evaluateMomentumExit(position.entry, instrument.bars, instrument.indicators, !!rank && rank.rank <= cutoff);
      position.entry.wideTrailing = exit.wideTrailing;
      if (exit.signal) {
        alerts.push(alertFor(instrument, exit.signal, position.entry.stopPrice, rank));
        if (exit.signal === "Hard Stop") continue;
        position.exitPending = true;
      }
      remaining.push(position);
    }
    state.positions = remaining;
    for (const candidate of evaluateRankedSetups(universe, voo, ["Setup D"])) {
      if (state.positions.some((position) => position.ticker === candidate.ticker)) continue;
      const instrument = instruments.get(candidate.ticker)!;
      alerts.push(alertFor(instrument, candidate.setup, momentumHardStop(instrument.bars.at(-1)!.close, candidate.atr14), rankByTicker.get(candidate.ticker)));
      state.positions.push({
        ticker: candidate.ticker, signalDate: session, atr14: candidate.atr14, entry: null, exitPending: false
      });
    }
    state.date = session;
    state.alerts = alerts;
  }
  return state;
}
