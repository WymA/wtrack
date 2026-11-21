import { describe, expect, it } from "vitest";
import { calculateAtr, calculateIndicators } from "../strategy-core/indicators";
import {
  evaluateMomentumExit, evaluateRankedSetups, marketRegimePasses, momentumHardStop,
  momentumRegimePasses, rankMomentumUniverse
} from "../strategy-core/strategy";
import type { Bar, MarketInstrument, MomentumPosition } from "../strategy-core/types";
import { runSimulation } from "../src/backtest/simulator";
import { validateConfig } from "../src/backtest/config";
import { advanceMomentumSignals, parseMomentumState } from "../src/momentum-signals";

function bars(count = 340, slope = 0.2, end = "2025-01-17"): Bar[] {
  const dates: string[] = [];
  const day = new Date(`${end}T12:00:00Z`);
  while (dates.length < count) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return dates.map((date, index) => {
    const close = 100 + index * slope;
    return { timestamp: `${date}T00:00:00Z`, open: close - 0.1, high: close + 1, low: close - 1, close, volume: 1000 };
  });
}

function instrument(ticker: string, values = bars()): MarketInstrument {
  return { ticker, bars: values, indicators: calculateIndicators(values) };
}

function settings(values: Bar[], end = 306) {
  return validateConfig({
    strategy: { setups: ["Setup D"], watchlist: ["S1"] },
    dateWindow: { start: values[300]!.timestamp.slice(0, 10), end: values[end]!.timestamp.slice(0, 10) },
    portfolio: { startingCapital: 100_000, maxOpenPositions: 1, sizing: { type: "fixed-dollar", value: 5 } },
    stops: { initial: { type: "fixed-percent", value: 1 }, leftSideFailurePercent: 3 },
    profitTaking: { type: "fixed-percent", value: 0.1, partialPercent: 100 },
    trailingExitEma: "disabled",
    costs: { slippagePercent: 0, commissionPerOrder: 0 }
  });
}

describe("Strategy V2 indicators and ranking", () => {
  it("uses gap-aware true ranges, a simple ATR seed, and Wilder smoothing", () => {
    const values = bars(3);
    Object.assign(values[0]!, { high: 11, low: 9, close: 10 });
    Object.assign(values[1]!, { high: 15, low: 14, close: 14.5 });
    Object.assign(values[2]!, { high: 16, low: 14, close: 15 });
    const atr = calculateAtr(values, 2);
    expect(atr[0]).toBeNaN();
    expect(atr.slice(1)).toEqual([3.5, 2.75]);
    expect(() => calculateAtr(values, 0)).toThrow(RangeError);
  });

  it("calculates the specified score, ranks the whole universe, and does not promote ineligible stocks", () => {
    const universe = Array.from({ length: 7 }, (_, index) => instrument(`S${index + 1}`, bars(340, (index + 1) / 10)));
    const ranked = rankMomentumUniverse(universe);
    const best = universe[6]!;
    const close = best.bars[339]!.close;
    const expected = ((close / best.bars[213]!.close - 1) + (close / best.bars[276]!.close - 1)) / (2 * 2 / close);
    expect(ranked[0]!.score).toBeCloseTo(expected);
    expect(ranked[0]).toMatchObject({ ticker: "S7", rank: 1, percentileRank: 100 });
    expect(evaluateRankedSetups(universe, instrument("VOO"), ["Setup D"]).map((item) => item.ticker)).toEqual(["S7", "S6"]);
    best.indicators.ema20[339] = close / 1.09;
    expect(evaluateRankedSetups(universe, instrument("VOO"), ["Setup D"]).map((item) => item.ticker)).toEqual(["S6"]);
  });

  it("uses the V2 200-EMA gate independently of V1 and resolves tied scores deterministically", () => {
    const voo = instrument("VOO");
    voo.indicators.ema50[339] = voo.bars[339]!.close + 1;
    expect(marketRegimePasses(voo.bars, voo.indicators)).toBe(false);
    expect(momentumRegimePasses(voo)).toBe(true);
    const universe = [instrument("ZZZ"), instrument("AAA")];
    expect(evaluateRankedSetups(universe, voo, ["Setup D"]).map((item) => item.ticker)).toEqual(["AAA"]);
    voo.indicators.ema200[339] = voo.bars[339]!.close + 1;
    expect(evaluateRankedSetups(universe, voo, ["Setup D"])).toEqual([]);
    expect(rankMomentumUniverse([instrument("SHORT", bars(299))])).toEqual([]);
    const flat = bars().map((bar) => ({ ...bar, open: 100, close: 100, high: 100, low: 100 }));
    expect(rankMomentumUniverse([instrument("FLAT", flat)])).toEqual([]);
  });
});

describe("Strategy V2 exits", () => {
  const position: MomentumPosition = { entryDate: "2024-01-01", entryPrice: 100, stopPrice: 70, wideTrailing: false };

  it("latches winner trailing at an intraday 25% gain and requires two closes below the selected EMA", () => {
    const values = bars(2);
    Object.assign(values[0]!, { close: 96, high: 97, low: 95 });
    Object.assign(values[1]!, { close: 95, high: 97, low: 94 });
    const indicators = { ema20: [110, 110], ema50: [100, 100], ema100: [90, 90], ema200: [60, 60] };
    expect(evaluateMomentumExit(position, values, indicators, true).signal).toBe("Exit Tier 2");
    values[1]!.high = 125;
    expect(evaluateMomentumExit(position, values, indicators, true)).toEqual({ signal: null, wideTrailing: true });
    values[1]!.high = 97;
    expect(evaluateMomentumExit({ ...position, wideTrailing: true }, values, indicators, true).signal).toBeNull();
    values[0]!.close = 89;
    values[1]!.close = 88;
    expect(evaluateMomentumExit({ ...position, wideTrailing: true }, values, indicators, true).signal).toBe("Exit Tier 3");
    values[1]!.low = 69;
    expect(evaluateMomentumExit(position, values, indicators, true).signal).toBe("Hard Stop");
    expect(momentumHardStop(100, 2)).toBe(92);
    expect(momentumHardStop(100, 2, "atr")).toBe(95);
  });

  it("rotates only on Friday after 15 complete sessions, below EMA20 and outside the top 30%", () => {
    const values = bars(16).map((bar) => ({ ...bar, close: 95, high: 96, low: 94 }));
    const indicators = { ema20: Array(16).fill(100), ema50: Array(16).fill(90), ema100: Array(16).fill(80), ema200: Array(16).fill(70) };
    const held = { ...position, entryDate: values[0]!.timestamp.slice(0, 10) };
    expect(evaluateMomentumExit(held, values, indicators, false).signal).toBe("Momentum Rotation");
    expect(evaluateMomentumExit(held, values, indicators, true).signal).toBeNull();
    expect(evaluateMomentumExit({ ...held, entryDate: values[1]!.timestamp.slice(0, 10) }, values, indicators, false).signal).toBeNull();
    expect(evaluateMomentumExit(held, values.slice(0, -1), indicators, false).signal).toBeNull();
  });
});

describe("Strategy V2 simulation chronology", () => {
  it.each([true, false])("uses VOO instead of conflicting SPY data for simulated and alert-only D entries (VOO passing: %s)", (passes) => {
    const rising = bars();
    const blocked = rising.map((bar) => ({ ...bar, open: 80, high: 81, low: 79, close: 80 }));
    const source = { VOO: passes ? rising : blocked, SPY: passes ? blocked : rising, S1: bars() };
    const result = runSimulation(settings(source.VOO), source);
    expect(result.openTrades.map((trade) => trade.setup)).toEqual(passes ? ["Setup D"] : []);
    const state = advanceMomentumSignals(parseMomentumState(null), source.VOO[300]!.timestamp.slice(0, 10), ["S1"], source);
    expect(state.alerts.map((alert) => alert.type)).toEqual(passes ? ["Setup D"] : []);
  });

  it("fills score-ranked equal-weight slots at the next open and ignores V1 sizing/targets without look-ahead", () => {
    const source: Record<string, Bar[]> = { VOO: bars() };
    for (let index = 1; index <= 7; index += 1) source[`S${index}`] = bars(340, index / 10);
    const config = settings(source.VOO!);
    config.strategy.watchlist = Array.from({ length: 7 }, (_, index) => `S${index + 1}`);
    config.portfolio.maxOpenPositions = 2;
    const result = runSimulation(config, source);
    expect(result.trades).toEqual([]);
    expect(result.openTrades.map((trade) => trade.ticker)).toEqual(["S7", "S6"]);
    for (const trade of result.openTrades) {
      expect(trade.entryDate).toBe(source.VOO![301]!.timestamp.slice(0, 10));
      expect(trade.remainingShares * trade.entryPrice).toBeCloseTo(50_000);
    }
    const futureChanged = Object.fromEntries(Object.entries(source).map(([ticker, values]) => [
      ticker, values.map((bar, index) => index > 306 ? { ...bar, close: 1, high: 2, low: 0.5 } : bar)
    ]));
    expect(runSimulation(config, futureChanged)).toEqual(result);
  });

  it("allows D entries when VOO is above EMA200 but below EMA50 and waits for a missing ticker's next open", () => {
    const source = { VOO: bars(), S1: bars() };
    for (let index = 300; index < source.VOO.length; index += 1) {
      Object.assign(source.VOO[index]!, { open: 150, high: 151, low: 149, close: 150 });
    }
    const voo = instrument("VOO", source.VOO.slice(0, 301));
    expect(marketRegimePasses(voo.bars, voo.indicators)).toBe(false);
    expect(momentumRegimePasses(voo)).toBe(true);
    const expectedDate = source.S1[302]!.timestamp.slice(0, 10);
    source.S1.splice(301, 1);
    const result = runSimulation(settings(source.VOO), source);
    expect(result.openTrades[0]).toMatchObject({ setup: "Setup D", entryDate: expectedDate });
  });

  it.each([["fixed-percent", 82.8], ["atr", 85]] as const)(
    "applies the %s hard stop to the actual fill, using signal-day ATR even when VOO turns down",
    (mode, stop) => {
      const source = { VOO: bars(), S1: bars() };
      const config = settings(source.VOO);
      config.strategy.momentumStop = mode;
      Object.assign(source.S1[301]!, { open: 90, high: 91, low: 80, close: 85 });
      for (let index = 301; index < source.VOO.length; index += 1) {
        Object.assign(source.VOO[index]!, { open: 80, high: 81, low: 79, close: 80 });
      }
      const result = runSimulation(config, source);
      expect(result.trades[0]).toMatchObject({
        setup: "Setup D", entryPrice: 90, exitReason: "Hard Stop",
        exitDate: source.S1[301]!.timestamp.slice(0, 10)
      });
      expect(result.trades[0]!.exitPrice).toBeCloseTo(stop);
    }
  );

  it("executes a Friday momentum rotation on the next trading open, not Friday's close", () => {
    const source: Record<string, Bar[]> = { VOO: bars() };
    for (let index = 1; index <= 7; index += 1) source[`S${index}`] = bars(340, index / 10);
    const config = settings(source.VOO!, 321);
    config.strategy.watchlist = Array.from({ length: 7 }, (_, index) => `S${index + 1}`);
    Object.assign(source.S7![319]!, { open: 310, high: 311, low: 309, close: 310 });
    for (let index = 1; index <= 6; index += 1) {
      Object.assign(source[`S${index}`]![319]!, { open: 1000, high: 1001, low: 999, close: 1000 });
    }
    const trade = runSimulation(config, source).trades[0];
    expect(new Date(source.VOO![319]!.timestamp).getUTCDay()).toBe(5);
    expect(trade).toMatchObject({
      ticker: "S7", exitReason: "Momentum Rotation",
      exitDate: source.VOO![320]!.timestamp.slice(0, 10),
      exitPrice: source.S7![320]!.open
    });
  });
});

describe("alert-only momentum position tracking", () => {
  it("migrates the previous D ledger format without resetting its latched exit state", () => {
    const legacy = {
      date: "2025-01-16",
      positions: [{
        ticker: "S1", signalDate: "2025-01-14", atr14: 2, exitPending: false,
        entry: { entryDate: "2025-01-15", entryPrice: 100, stopPrice: 92, wideTrailing: true }
      }],
      alerts: []
    };
    const state = parseMomentumState(JSON.stringify(legacy));
    expect(state.positions[0]).toMatchObject({
      setup: "Setup D", candidate: { ticker: "S1", atr14: 2 },
      entry: { state: { wideTrailing: true } }
    });
    expect(parseMomentumState(JSON.stringify(state))).toEqual(state);
    const source = { VOO: bars(), S1: bars() };
    const next = advanceMomentumSignals(state, "2025-01-17", ["S1"], source);
    expect(next.positions[0]!.entry!.state.wideTrailing).toBe(true);
  });

  it("remembers next-open fills, checks stops despite the regime, and does not advance twice for one session", () => {
    const source = { VOO: bars(), S1: bars() };
    const signalDate = source.VOO[320]!.timestamp.slice(0, 10);
    const initial = advanceMomentumSignals(parseMomentumState(null), signalDate, ["S1"], source);
    expect(initial.alerts).toMatchObject([{
      ticker: "S1", type: "Setup D", strategy: "Setup D", momentumScore: expect.any(Number), percentileRank: 100
    }]);
    expect(initial.positions[0]!.entry).toBeNull();
    expect(advanceMomentumSignals(initial, signalDate, ["S1"], source)).toBe(initial);
    Object.assign(source.S1[321]!, { open: 90, high: 91, low: 80, close: 85 });
    Object.assign(source.VOO[321]!, { open: 80, high: 81, low: 79, close: 80 });
    const next = advanceMomentumSignals(parseMomentumState(JSON.stringify(initial)),
      source.VOO[321]!.timestamp.slice(0, 10), ["S1"], source);
    expect(next.alerts).toMatchObject([{ type: "Hard Stop", strategy: "Setup D", stopLoss: 82.8 }]);
    expect(next.positions).toEqual([]);
    expect(() => parseMomentumState('{"positions":false}')).toThrow("invalid");
  });

  it("replays missed sessions like daily runs and continues exits after watchlist removal", () => {
    const source = { VOO: bars(), S1: bars() };
    const date = (index: number) => source.VOO[index]!.timestamp.slice(0, 10);
    const initial = advanceMomentumSignals(parseMomentumState(null), date(310), ["S1"], source);
    let daily = initial;
    for (let index = 311; index <= 316; index += 1) {
      daily = advanceMomentumSignals(daily, date(index), ["S1"], source);
    }
    expect(advanceMomentumSignals(initial, date(316), ["S1"], source)).toEqual(daily);
    Object.assign(source.S1[317]!, { open: 90, high: 91, low: 89, close: 90 });
    const removed = advanceMomentumSignals(daily, date(317), [], source);
    expect(removed.alerts).toMatchObject([{ ticker: "S1", type: "Hard Stop", momentumScore: null, percentileRank: null }]);
    expect(removed.positions).toEqual([]);
  });
});
