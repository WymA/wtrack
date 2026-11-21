import { calculateIndicators } from "../strategy-core/indicators.ts";
import {
  evaluateRankedSetups, evaluateStrategyExit, getStrategy, isRankedSetup, prepareStrategyUniverse,
  REQUIRED_DAILY_BARS, strategies
} from "../strategy-core/strategy.ts";
import { initialPositionState } from "../strategy-core/positions.ts";
import type {
  EntrySetup, MarketInstrument, RankedCandidate, StrategyEntryCandidate, StrategyExecutionConfig,
  StrategyPosition, StrategyPositionState
} from "../strategy-core/types.ts";
import type { Bar, StockAlert } from "./types";

export const MOMENTUM_STATE_KEY = "momentum-signal-state";

const ALERT_CONFIG: StrategyExecutionConfig = {
  strategy: { momentumStop: "fixed-percent" },
  stops: { initial: { type: "fixed-percent", value: 8 }, leftSideFailurePercent: 3 },
  profitTaking: { type: "risk-multiple", value: 2, partialPercent: 50 },
  trailingExitEma: "ema50"
};

interface TrackedSignal {
  ticker: string;
  setup: EntrySetup;
  candidate: StrategyEntryCandidate;
  signalDate: string;
  entry: StrategyPosition | null;
  exitPending: boolean;
}

export interface MomentumSignalState {
  date: string;
  positions: TrackedSignal[];
  alerts: StockAlert[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidState(): never {
  throw new Error("Stored momentum signal state is invalid.");
}

export function parseMomentumState(value: string | null): MomentumSignalState {
  if (value === null) return { date: "", positions: [], alerts: [] };
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || typeof parsed.date !== "string" ||
    !Array.isArray(parsed.positions) || !Array.isArray(parsed.alerts)) return invalidState();
  const positions = parsed.positions.map((position): TrackedSignal => {
    if (!isRecord(position) || typeof position.ticker !== "string" ||
      typeof position.signalDate !== "string" || typeof position.exitPending !== "boolean") return invalidState();
    const setup = position.setup ?? "Setup D";
    if (typeof setup !== "string" || !isRankedSetup(setup as EntrySetup)) return invalidState();
    const candidate = position.candidate ?? { ticker: position.ticker, atr14: position.atr14 };
    if (!isRecord(candidate) || candidate.ticker !== position.ticker ||
      (!position.candidate && !Number.isFinite(position.atr14)) ||
      ["price", "support", "atr14", "score", "rank", "percentileRank"]
        .some((key) => candidate[key] !== undefined && !Number.isFinite(candidate[key]))) return invalidState();
    if (candidate.data !== undefined && (!isRecord(candidate.data) ||
      Object.values(candidate.data).some((value) => typeof value !== "boolean" && typeof value !== "string" &&
        (typeof value !== "number" || !Number.isFinite(value))))) return invalidState();
    let entry: StrategyPosition | null = null;
    if (position.entry !== null) {
      if (!isRecord(position.entry) || typeof position.entry.entryDate !== "string" ||
        !Number.isFinite(position.entry.entryPrice) || !Number.isFinite(position.entry.stopPrice)) return invalidState();
      const state = position.entry.state ?? {
        ...initialPositionState(), wideTrailing: position.entry.wideTrailing
      };
      if (!isRecord(state) || typeof state.wideTrailing !== "boolean" ||
        typeof state.standardExitsArmed !== "boolean" || !Number.isFinite(state.leftSideFailureClosesRemaining) ||
        (state.support !== undefined && !Number.isFinite(state.support)) ||
        Object.values(state).some((value) => value !== undefined && typeof value !== "boolean" &&
          typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))) return invalidState();
      entry = {
        entryDate: position.entry.entryDate,
        entryPrice: position.entry.entryPrice as number,
        stopPrice: position.entry.stopPrice as number,
        state: state as StrategyPositionState
      };
    }
    return {
      ticker: position.ticker, setup: setup as EntrySetup, candidate: candidate as unknown as StrategyEntryCandidate,
      signalDate: position.signalDate, entry, exitPending: position.exitPending
    };
  });
  return { date: parsed.date, positions, alerts: parsed.alerts as StockAlert[] };
}

function alertFor(
  instrument: MarketInstrument,
  setup: EntrySetup,
  type: StockAlert["type"],
  stopLoss: number,
  rank: RankedCandidate | undefined
): StockAlert {
  const bar = instrument.bars.at(-1)!;
  const indicators = instrument.indicators;
  return {
    ticker: instrument.ticker, type, strategy: setup,
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
      ...position, candidate: { ...position.candidate },
      entry: position.entry ? { ...position.entry, state: { ...position.entry.state } } : null
    }))
  };
  const active = strategies.filter((strategy) => strategy.timing === "ranked-close").map((strategy) => strategy.id);
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
    const universeStates = prepareStrategyUniverse(universe, active);
    const ranksBySetup = new Map([...universeStates].map(([setup, context]) => [
      setup, new Map(context.ranks.map((rank) => [rank.ticker, rank]))
    ]));
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
        const signalBars = (data[position.ticker] ?? [])
          .filter((bar) => bar.timestamp.slice(0, 10) <= position.signalDate).slice(-REQUIRED_DAILY_BARS);
        const rules = getStrategy(position.setup).position.initialize({
          entryDate: session, entryPrice: price, candidate: position.candidate, config: ALERT_CONFIG,
          instrument: { ticker: position.ticker, bars: signalBars, indicators: calculateIndicators(signalBars) }
        });
        if (!rules || price <= rules.stopPrice) continue;
        position.entry = {
          entryDate: session, entryPrice: price, stopPrice: rules.stopPrice, state: rules.state
        };
      }
      const rank = ranksBySetup.get(position.setup)?.get(position.ticker);
      if (instrument.bars.at(-1)!.low <= position.entry.stopPrice) {
        alerts.push(alertFor(instrument, position.setup, "Hard Stop", position.entry.stopPrice, rank));
        continue;
      }
      const exit = evaluateStrategyExit(position.setup, {
        position: position.entry, instrument, config: ALERT_CONFIG,
        universeState: universeStates.get(position.setup)!
      });
      position.entry.state = exit.state;
      if (exit.signal) {
        alerts.push(alertFor(instrument, position.setup, exit.signal, position.entry.stopPrice, rank));
        if (exit.immediate) continue;
        position.exitPending = true;
      }
      remaining.push(position);
    }
    state.positions = remaining;
    for (const candidate of evaluateRankedSetups(universe, voo, active)) {
      if (state.positions.some((position) => position.ticker === candidate.ticker)) continue;
      const instrument = instruments.get(candidate.ticker)!;
      const { setup, ...entryCandidate } = candidate;
      const rules = getStrategy(setup).position.initialize({
        entryDate: session, entryPrice: instrument.bars.at(-1)!.close,
        candidate: entryCandidate, config: ALERT_CONFIG, instrument
      });
      if (!rules) continue;
      alerts.push(alertFor(instrument, setup, setup, rules.stopPrice, ranksBySetup.get(setup)?.get(candidate.ticker)));
      state.positions.push({
        ticker: candidate.ticker, setup, candidate: entryCandidate, signalDate: session,
        entry: null, exitPending: false
      });
    }
    state.date = session;
    state.alerts = alerts;
  }
  return state;
}
