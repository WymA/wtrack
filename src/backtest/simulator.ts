import {
  calculateIndicators
} from "../../strategy-core/indicators.ts";
import {
  evaluateBuySetup,
  evaluateExitSignals,
  evaluateIntradaySetups,
  evaluateMomentumExit,
  evaluateRankedSetups,
  isIntradaySetup,
  isRankedSetup,
  isRightSideSetup,
  marketRegimePasses,
  recentSwingLow,
  momentumHardStop,
  rankMomentumUniverse,
  supportFailure
} from "../../strategy-core/strategy.ts";
import type { Bar, EntrySetup, IndicatorSeries, MarketInstrument } from "../../strategy-core/types.ts";
import type { BacktestConfig } from "./config.ts";

export interface CompletedTrade {
  ticker: string;
  setup: EntrySetup;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPercent: number;
  exitReason: string;
}

export interface OpenTrade {
  ticker: string;
  setup: EntrySetup;
  entryDate: string;
  entryPrice: number;
  lastClose: number;
  remainingShares: number;
  unrealizedPnl: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  period: {
    start: string | null;
    end: string | null;
    tradingDays: number;
  };
  benchmark: {
    ticker: "VOO";
    returnPercent: number | null;
  };
  metrics: {
    startingCapital: number;
    endingEquity: number;
    netProfit: number;
    returnPercent: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRatePercent: number;
    profitFactor: number | null;
    maxDrawdownPercent: number;
    openPositions: number;
  };
  trades: CompletedTrade[];
  openTrades: OpenTrade[];
  equityCurve: Array<{ date: string; equity: number }>;
}

interface Instrument {
  bars: Bar[];
  indicators: IndicatorSeries;
  indexByDate: Map<string, number>;
}

interface EntryCandidate {
  ticker: string;
  setup: EntrySetup;
  signalDate: string;
  signalIndex: number;
  support?: number;
  atr14?: number;
}

interface Position {
  ticker: string;
  setup: EntrySetup;
  entryDate: string;
  entryPrice: number;
  totalShares: number;
  remainingShares: number;
  stopPrice: number;
  targetPrice: number;
  support?: number;
  realizedPnl: number;
  exitShares: number;
  exitValue: number;
  targetReached: boolean;
  leftSideFailureClosesRemaining: number;
  standardExitsArmed: boolean;
  wideTrailing: boolean;
}

interface PendingExit {
  reason: string;
}

export type BacktestData = Record<string, Bar[]>;

function dateOf(bar: Bar): string {
  return bar.timestamp.slice(0, 10);
}

function indicatorPrefix(indicators: IndicatorSeries, end: number): IndicatorSeries {
  return {
    ema20: indicators.ema20.slice(0, end),
    ema50: indicators.ema50.slice(0, end),
    ema100: indicators.ema100.slice(0, end),
    ema200: indicators.ema200.slice(0, end),
    ...(indicators.atr14 ? { atr14: indicators.atr14.slice(0, end) } : {}),
    ...(indicators.atr20 ? { atr20: indicators.atr20.slice(0, end) } : {})
  };
}

function indexMap(bars: readonly Bar[]): Map<string, number> {
  return new Map(bars.map((bar, index) => [dateOf(bar), index]));
}

function buildInstrument(bars: Bar[]): Instrument {
  return { bars, indicators: calculateIndicators(bars), indexByDate: indexMap(bars) };
}

function positionEquity(
  cash: number,
  positions: Map<string, Position>,
  lastCloses: Map<string, number>
): number {
  let equity = cash;
  for (const [ticker, position] of positions) {
    equity += position.remainingShares * (lastCloses.get(ticker) ?? position.entryPrice);
  }
  return equity;
}

function fillPrice(rawPrice: number, side: "buy" | "sell", slippagePercent: number): number {
  const slippage = slippagePercent / 100;
  return side === "buy" ? rawPrice * (1 + slippage) : rawPrice * (1 - slippage);
}

export function runSimulation(config: BacktestConfig, source: BacktestData): BacktestResult {
  const instruments = new Map<string, Instrument>();
  for (const [ticker, bars] of Object.entries(source)) {
    instruments.set(ticker, buildInstrument(bars));
  }
  const voo = instruments.get("VOO");
  if (!voo) throw new Error("Cached VOO bars are required to run a backtest.");
  const rightSideSetups = config.strategy.setups.filter(isRightSideSetup);
  const hasIntradaySetups = config.strategy.setups.some(isIntradaySetup);
  const hasRankedSetups = config.strategy.setups.some(isRankedSetup);

  const dates = voo.bars
    .map(dateOf)
    .filter((date) => date >= config.dateWindow.start && date <= config.dateWindow.end);
  const positions = new Map<string, Position>();
  const pendingExits = new Map<string, PendingExit>();
  let pendingEntries: EntryCandidate[] = [];
  const trades: CompletedTrade[] = [];
  const equityCurve: BacktestResult["equityCurve"] = [];
  const lastCloses = new Map<string, number>();
  let cash = config.portfolio.startingCapital;

  const closePosition = (
    position: Position,
    date: string,
    rawPrice: number,
    reason: string,
    fraction = 1
  ): void => {
    const shares = fraction === 1
      ? position.remainingShares
      : Math.min(position.remainingShares, position.totalShares * fraction);
    if (shares <= 0) return;
    const price = fillPrice(rawPrice, "sell", config.costs.slippagePercent);
    const commission = config.costs.commissionPerOrder;
    const entryCommission = config.costs.commissionPerOrder * shares / position.totalShares;
    const proceeds = shares * price - commission;
    position.realizedPnl += shares * (price - position.entryPrice) - commission - entryCommission;
    position.exitShares += shares;
    position.exitValue += shares * price;
    position.remainingShares -= shares;
    cash += proceeds;

    if (position.remainingShares <= position.totalShares * 1e-10) {
      trades.push({
        ticker: position.ticker,
        setup: position.setup,
        entryDate: position.entryDate,
        exitDate: date,
        entryPrice: position.entryPrice,
        exitPrice: position.exitValue / position.exitShares,
        shares: position.totalShares,
        pnl: position.realizedPnl,
        returnPercent: position.realizedPnl / (position.totalShares * position.entryPrice) * 100,
        exitReason: reason
      });
      positions.delete(position.ticker);
      pendingExits.delete(position.ticker);
    }
  };

  const openPosition = (candidate: EntryCandidate, date: string, rawPrice: number): void => {
    if (positions.has(candidate.ticker) || positions.size >= config.portfolio.maxOpenPositions) return;
    const instrument = instruments.get(candidate.ticker);
    const signalBar = instrument?.bars[candidate.signalIndex];
    if (!instrument || !signalBar) return;

    const entryPrice = fillPrice(rawPrice, "buy", config.costs.slippagePercent);
    const initialStop = config.stops.initial;
    let stopPrice: number;
    if (candidate.setup === "Setup D") {
      stopPrice = momentumHardStop(entryPrice, candidate.atr14 ?? 0, config.strategy.momentumStop);
      if (stopPrice <= 0) return;
    } else if (initialStop.type === "swing-low") {
      stopPrice = recentSwingLow(
        instrument.bars.slice(0, candidate.signalIndex + 1),
        initialStop.lookback
      );
    } else if (initialStop.type === "fixed-percent") {
      stopPrice = entryPrice * (1 - initialStop.value / 100);
    } else {
      const ema = instrument.indicators[initialStop.ema][candidate.signalIndex];
      if (ema === undefined) return;
      stopPrice = ema * (1 - initialStop.bufferPercent / 100);
    }
    if (candidate.support !== undefined) {
      const failureStop = candidate.support * (1 - config.stops.leftSideFailurePercent / 100);
      stopPrice = Math.max(stopPrice, failureStop);
    }
    const riskPerShare = entryPrice - stopPrice;
    if (riskPerShare <= 0) return;

    const marks = candidate.setup === "Setup D" ? new Map(lastCloses) : lastCloses;
    if (candidate.setup === "Setup D") {
      for (const ticker of positions.keys()) {
        const held = instruments.get(ticker);
        const index = held?.indexByDate.get(date);
        if (held && index !== undefined) marks.set(ticker, held.bars[index]!.open);
      }
    }
    const equity = positionEquity(cash, positions, marks);
    const sizing = config.portfolio.sizing;
    let budget: number;
    if (candidate.setup === "Setup D") {
      budget = equity / config.portfolio.maxOpenPositions;
    } else if (sizing.type === "risk-percent") {
      budget = equity * sizing.value / 100 / riskPerShare * entryPrice;
    } else if (sizing.type === "fixed-dollar") {
      budget = sizing.value;
    } else {
      budget = equity * sizing.value / 100;
    }
    const affordable = Math.max(0, cash - config.costs.commissionPerOrder) / entryPrice;
    const shares = Math.min(budget / entryPrice, affordable);
    if (!Number.isFinite(shares) || shares <= 0) return;

    const riskDistance = entryPrice - stopPrice;
    const targetPrice = candidate.setup === "Setup D" ? Number.POSITIVE_INFINITY
      : config.profitTaking.type === "fixed-percent"
      ? entryPrice * (1 + config.profitTaking.value / 100)
      : entryPrice + riskDistance * config.profitTaking.value;
    const commission = config.costs.commissionPerOrder;
    cash -= shares * entryPrice + commission;
    positions.set(candidate.ticker, {
      ticker: candidate.ticker,
      setup: candidate.setup,
      entryDate: date,
      entryPrice,
      totalShares: shares,
      remainingShares: shares,
      stopPrice,
      targetPrice,
      ...(candidate.support !== undefined ? { support: candidate.support } : {}),
      realizedPnl: 0,
      exitShares: 0,
      exitValue: 0,
      targetReached: false,
      leftSideFailureClosesRemaining: candidate.support !== undefined ? 2 : 0,
      standardExitsArmed: candidate.support === undefined,
      wideTrailing: false
    });
  };

  const processGap = (date: string, ticker: string, bar: Bar): void => {
    const position = positions.get(ticker);
    if (!position) return;
    const pending = pendingExits.get(ticker);
    if (pending) {
      closePosition(position, date, bar.open, pending.reason);
      pendingExits.delete(ticker);
      return;
    }
    if (bar.open <= position.stopPrice) {
      closePosition(position, date, bar.open, position.setup === "Setup D" ? "Hard Stop" : "Initial stop");
      return;
    }
    if (!position.targetReached && bar.open >= position.targetPrice) {
      position.targetReached = true;
      const fraction = config.profitTaking.partialPercent / 100;
      if (fraction === 1) closePosition(position, date, bar.open, "Profit target");
      else if (fraction > 0) closePosition(position, date, bar.open, "Profit target", fraction);
    }
  };

  for (const date of dates) {
    const todaysBars = new Map<string, Bar>();
    for (const [ticker, instrument] of instruments) {
      const index = instrument.indexByDate.get(date);
      if (index !== undefined) {
        const bar = instrument.bars[index];
        if (bar) todaysBars.set(ticker, bar);
      }
    }

    for (const [ticker, bar] of todaysBars) processGap(date, ticker, bar);

    const remainingEntries: EntryCandidate[] = [];
    for (const candidate of pendingEntries) {
      const bar = todaysBars.get(candidate.ticker);
      if (bar) openPosition(candidate, date, bar.open);
      else remainingEntries.push(candidate);
    }
    pendingEntries = remainingEntries;

    const regimeIndex = voo.indexByDate.get(date);
    const regimeBar = regimeIndex === undefined ? undefined : voo.bars[regimeIndex];
    const regime = regimeIndex !== undefined && regimeBar !== undefined
      ? marketRegimePasses(voo.bars.slice(0, regimeIndex + 1), indicatorPrefix(voo.indicators, regimeIndex + 1))
      : false;
    const priorRegimeIndex = regimeIndex === undefined ? undefined : regimeIndex - 1;
    const priorRegimeBar = priorRegimeIndex === undefined || priorRegimeIndex < 0
      ? undefined
      : voo.bars[priorRegimeIndex];
    const priorRegime = priorRegimeIndex !== undefined && priorRegimeIndex >= 0 && priorRegimeBar !== undefined
      ? marketRegimePasses(
        voo.bars.slice(0, priorRegimeIndex + 1),
        indicatorPrefix(voo.indicators, priorRegimeIndex + 1)
      )
      : false;

    if (priorRegime) {
      for (const ticker of config.strategy.watchlist) {
        const instrument = instruments.get(ticker);
        const barIndex = instrument?.indexByDate.get(date);
        const bar = barIndex === undefined ? undefined : instrument?.bars[barIndex];
        if (!instrument || barIndex === undefined || !bar || positions.has(ticker)) continue;

        if (hasIntradaySetups && barIndex > 0) {
          const entries = evaluateIntradaySetups(
            instrument.bars.slice(0, barIndex),
            indicatorPrefix(instrument.indicators, barIndex),
            bar,
            config.strategy.setups
          );
          for (const entry of entries) {
            openPosition({
              ticker,
              setup: entry.setup,
              signalDate: date,
              signalIndex: barIndex - 1,
              support: entry.support
            }, date, entry.price);
          }
        }
      }
    }

    for (const [ticker, bar] of todaysBars) {
      const position = positions.get(ticker);
      if (!position) continue;
      if (bar.low <= position.stopPrice) {
        closePosition(position, date, position.stopPrice, position.setup === "Setup D" ? "Hard Stop" : "Initial stop");
        continue;
      }
      const ambiguousEntryDayHigh = position.support !== undefined && position.entryDate === date;
      if (!position.targetReached && !ambiguousEntryDayHigh && bar.high >= position.targetPrice) {
        position.targetReached = true;
        const fraction = config.profitTaking.partialPercent / 100;
        if (fraction === 1) closePosition(position, date, position.targetPrice, "Profit target");
        else if (fraction > 0) closePosition(position, date, position.targetPrice, "Profit target", fraction);
      }
    }

    const universe: MarketInstrument[] = hasRankedSetups ? config.strategy.watchlist.flatMap((ticker) => {
      const instrument = instruments.get(ticker);
      const index = instrument?.indexByDate.get(date);
      return instrument && index !== undefined ? [{
        ticker,
        bars: instrument.bars.slice(0, index + 1),
        indicators: indicatorPrefix(instrument.indicators, index + 1)
      }] : [];
    }) : [];
    const momentumRanks = hasRankedSetups ? rankMomentumUniverse(universe) : [];
    const momentumWinners = new Set(momentumRanks
      .filter((rank) => rank.rank <= Math.ceil(momentumRanks.length * 0.3)).map((rank) => rank.ticker));
    const nextEntries: EntryCandidate[] = [];
    for (const ticker of config.strategy.watchlist) {
      const instrument = instruments.get(ticker);
      const barIndex = instrument?.indexByDate.get(date);
      const bar = barIndex === undefined ? undefined : instrument?.bars[barIndex];
      if (!instrument || barIndex === undefined || !bar) continue;
      const position = positions.get(ticker);

      if (position?.setup === "Setup D") {
        const exit = evaluateMomentumExit(
          position, instrument.bars.slice(0, barIndex + 1),
          indicatorPrefix(instrument.indicators, barIndex + 1), momentumWinners.has(ticker)
        );
        position.wideTrailing = exit.wideTrailing;
        if (exit.signal) {
          const reason = exit.signal === "Exit Tier 2" ? "EMA trailing exit (ema50)"
            : exit.signal === "Exit Tier 3" ? "EMA trailing exit (ema100)" : exit.signal;
          pendingExits.set(ticker, { reason });
        }
      } else if (position) {
        const wasStandardExitArmed = position.standardExitsArmed;
        if (position.support !== undefined &&
          position.leftSideFailureClosesRemaining > 0 &&
          supportFailure(bar.close, position.support, config.stops.leftSideFailurePercent)) {
          pendingExits.set(ticker, { reason: "Left-side failure" });
        } else {
          if (position.leftSideFailureClosesRemaining > 0) {
            position.leftSideFailureClosesRemaining -= 1;
          }
          const ema50 = instrument.indicators.ema50[barIndex];
          if (position.support !== undefined && ema50 !== undefined && bar.close > ema50) {
            position.standardExitsArmed = true;
          }
        }
        if ((wasStandardExitArmed || position.standardExitsArmed) &&
          config.trailingExitEma !== "disabled" && barIndex > 0) {
          const exits = evaluateExitSignals(
            instrument.bars.slice(0, barIndex + 1),
            indicatorPrefix(instrument.indicators, barIndex + 1)
          );
          const requiredSignal = config.trailingExitEma === "ema50" ? "Exit Tier 2" : "Exit Tier 3";
          if (exits.includes(requiredSignal)) {
            pendingExits.set(ticker, { reason: `EMA trailing exit (${config.trailingExitEma})` });
          }
        }
      } else if (regime && rightSideSetups.length > 0) {
        const setup = evaluateBuySetup(
          instrument.bars.slice(0, barIndex + 1),
          indicatorPrefix(instrument.indicators, barIndex + 1),
          rightSideSetups
        );
        if (setup) {
          nextEntries.push({
            ticker,
            setup,
            signalDate: date,
            signalIndex: barIndex
          });
        }
      }
      lastCloses.set(ticker, bar.close);
    }

    const rankedEntries = hasRankedSetups && regimeIndex !== undefined
      ? evaluateRankedSetups(universe, {
        ticker: "VOO",
        bars: voo.bars.slice(0, regimeIndex + 1),
        indicators: indicatorPrefix(voo.indicators, regimeIndex + 1)
      }, config.strategy.setups).map((candidate) => ({
        ticker: candidate.ticker, setup: candidate.setup, signalDate: date,
        signalIndex: instruments.get(candidate.ticker)!.indexByDate.get(date)!,
        atr14: candidate.atr14
      }))
      : [];
    pendingEntries = [...remainingEntries.filter((candidate) => isRankedSetup(candidate.setup)), ...rankedEntries, ...nextEntries];
    const equity = positionEquity(cash, positions, lastCloses);
    equityCurve.push({ date, equity });
  }

  const lastDate = dates.at(-1);
  const firstDate = dates[0];
  const vooBars = source.VOO ?? [];
  const benchmarkEntry = firstDate ? vooBars.find((bar) => dateOf(bar) === firstDate) : undefined;
  const benchmarkExit = lastDate ? vooBars.find((bar) => dateOf(bar) === lastDate) : undefined;
  const benchmarkReturn = benchmarkEntry && benchmarkExit &&
    Number.isFinite(benchmarkEntry.open) && benchmarkEntry.open > 0 &&
    Number.isFinite(benchmarkExit.close) && benchmarkExit.close > 0
    ? (benchmarkExit.close / benchmarkEntry.open - 1) * 100
    : null;
  const openTrades: OpenTrade[] = [];
  if (lastDate) {
    for (const [ticker, position] of positions) {
      const lastClose = lastCloses.get(ticker) ?? position.entryPrice;
      openTrades.push({
        ticker,
        setup: position.setup,
        entryDate: position.entryDate,
        entryPrice: position.entryPrice,
        lastClose,
        remainingShares: position.remainingShares,
        unrealizedPnl: (lastClose - position.entryPrice) * position.remainingShares
      });
    }
  }

  const endingEquity = positionEquity(cash, positions, lastCloses);
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const losses = trades.filter((trade) => trade.pnl < 0).length;
  const grossProfit = trades.reduce((total, trade) => total + Math.max(0, trade.pnl), 0);
  const grossLoss = -trades.reduce((total, trade) => total + Math.min(0, trade.pnl), 0);
  let peak = config.portfolio.startingCapital;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, (peak - point.equity) / peak * 100);
  }

  return {
    config,
    period: {
      start: firstDate ?? null,
      end: lastDate ?? null,
      tradingDays: dates.length
    },
    benchmark: {
      ticker: "VOO",
      returnPercent: benchmarkReturn
    },
    metrics: {
      startingCapital: config.portfolio.startingCapital,
      endingEquity,
      netProfit: endingEquity - config.portfolio.startingCapital,
      returnPercent: (endingEquity / config.portfolio.startingCapital - 1) * 100,
      closedTrades: trades.length,
      wins,
      losses,
      winRatePercent: trades.length ? wins / trades.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
      maxDrawdownPercent,
      openPositions: openTrades.length
    },
    trades,
    openTrades,
    equityCurve
  };
}
