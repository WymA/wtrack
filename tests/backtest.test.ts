import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getCachedBars, updateCachedBars } from "../backtest/cache.ts";
import { currentSessionIsComplete, validateConfig } from "../backtest/config.ts";
import { runSimulation } from "../backtest/simulator.ts";
import { calculateIndicators } from "../strategy-core/indicators.ts";
import type { Bar } from "../strategy-core/types.ts";

function makeBars(count: number): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
    const close = 100 + index * 0.1;
    return {
      timestamp: `${date}T00:00:00Z`,
      open: close - 0.2,
      high: close + 0.5,
      low: close - 0.3,
      close,
      volume: 1000
    };
  });
}

function config(start: string, end: string) {
  return validateConfig({
    strategy: { setups: ["Setup C"], watchlist: ["XYZ"] },
    dateWindow: { start, end },
    portfolio: {
      startingCapital: 100_000,
      maxOpenPositions: 5,
      sizing: { type: "fixed-dollar", value: 10_000 }
    },
    stops: {
      initial: { type: "fixed-percent", value: 5 },
      leftSideFailurePercent: 3
    },
    profitTaking: { type: "fixed-percent", value: 0.1, partialPercent: 100 },
    trailingExitEma: "disabled",
    costs: { slippagePercent: 0, commissionPerOrder: 0 }
  });
}

describe("backtest configuration", () => {
  it("resolves today to the New York calendar date", () => {
    const validated = validateConfig({
      strategy: { setups: [], watchlist: ["XYZ"] },
      dateWindow: { start: "2024-01-01", end: "today" },
      portfolio: {
        startingCapital: 1000,
        maxOpenPositions: 1,
        sizing: { type: "equity-percent", value: 50 }
      },
      stops: {
        initial: { type: "fixed-percent", value: 5 },
        leftSideFailurePercent: 3
      },
      profitTaking: { type: "risk-multiple", value: 2, partialPercent: 50 },
      trailingExitEma: "ema50",
      costs: { slippagePercent: 0, commissionPerOrder: 0 }
    }, new Date("2026-11-18T12:00:00Z"));

    expect(validated.dateWindow.end).toBe("2026-11-18");
  });

  it("does not treat an in-progress New York daily bar as a completed close", () => {
    expect(currentSessionIsComplete(new Date("2026-11-18T20:59:00Z"))).toBe(false);
    expect(currentSessionIsComplete(new Date("2026-11-18T21:00:00Z"))).toBe(true);
  });
});

describe("runSimulation", () => {
  it("does not credit a target touched on the Setup C entry bar", () => {
    const spyBars = makeBars(307);
    const stockBars = makeBars(307);
    const touchIndex = 304;
    const priorStockBars = stockBars.slice(0, touchIndex);
    const ema100 = calculateIndicators(priorStockBars).ema100.at(-1);
    expect(ema100).toBeDefined();
    const stockBar = stockBars[touchIndex];
    if (!stockBar) throw new Error("Missing test bar.");
    stockBar.low = ema100! * 1.004;
    const spyBar = spyBars[touchIndex];
    if (!spyBar) throw new Error("Missing SPY test bar.");
    spyBar.close = 90;

    const backtestConfig = config(
      stockBars[302]?.timestamp.slice(0, 10) ?? "",
      stockBar.timestamp.slice(0, 10)
    );
    const result = runSimulation(backtestConfig, { SPY: spyBars, XYZ: stockBars });

    expect(stockBar.high).toBeGreaterThan(ema100! * 1.005 * 1.001);
    expect(result.trades).toHaveLength(0);
    expect(result.openTrades).toMatchObject([{
      ticker: "XYZ",
      setup: "Setup C",
      entryDate: stockBar.timestamp.slice(0, 10)
    }]);
  });

  it("arms standard EMA exits for Setup C only after a 50 EMA reclaim", () => {
    const spyBars = makeBars(313);
    const stockBars = makeBars(313);
    const touchIndex = 304;
    const priorIndicators = calculateIndicators(stockBars.slice(0, touchIndex));
    const support = priorIndicators.ema100.at(-1);
    const touchBar = stockBars[touchIndex];
    if (!touchBar || support === undefined) throw new Error("Missing Setup C test data.");
    touchBar.low = support * 1.004;
    const originalIndicators = calculateIndicators(stockBars);
    touchBar.close = (originalIndicators.ema50[touchIndex] ?? touchBar.close) - 0.2;
    touchBar.open = touchBar.close - 0.1;
    touchBar.high = touchBar.close + 0.1;

    for (let index = touchIndex + 1; index <= 307; index += 1) {
      const bar = stockBars[index];
      const priorEma50 = calculateIndicators(stockBars.slice(0, index)).ema50.at(-1);
      if (!bar || priorEma50 === undefined) throw new Error("Missing EMA test data.");
      bar.close = priorEma50 - 0.5;
      bar.open = bar.close - 0.1;
      bar.low = bar.close - 0.1;
      bar.high = bar.close + 0.1;
    }

    const reclaimBar = stockBars[308];
    const reclaimEma50 = calculateIndicators(stockBars.slice(0, 308)).ema50.at(-1);
    if (!reclaimBar || reclaimEma50 === undefined) throw new Error("Missing reclaim test data.");
    reclaimBar.close = reclaimEma50 + 1;
    reclaimBar.open = reclaimBar.close - 0.1;
    reclaimBar.low = reclaimBar.close - 0.2;
    reclaimBar.high = reclaimBar.close + 0.1;

    for (let index = 309; index <= 310; index += 1) {
      const bar = stockBars[index];
      const priorEma50 = calculateIndicators(stockBars.slice(0, index)).ema50.at(-1);
      if (!bar || priorEma50 === undefined) throw new Error("Missing post-reclaim EMA data.");
      bar.close = priorEma50 - 0.5;
      bar.open = bar.close - 0.1;
      bar.low = bar.close - 0.1;
      bar.high = bar.close + 0.1;
    }

    const backtestConfig = config(
      stockBars[302]?.timestamp.slice(0, 10) ?? "",
      stockBars[312]?.timestamp.slice(0, 10) ?? ""
    );
    backtestConfig.profitTaking.value = 50;
    backtestConfig.trailingExitEma = "ema50";
    const result = runSimulation(backtestConfig, { SPY: spyBars, XYZ: stockBars });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      setup: "Setup C",
      exitDate: stockBars[311]?.timestamp.slice(0, 10),
      exitReason: "EMA trailing exit (ema50)"
    });
  });

  describe("updateCachedBars", () => {
    it("preserves the existing ticker cache when a full refresh request fails", async () => {
      const database = new DatabaseSync(":memory:");
      database.exec(`
        CREATE TABLE daily_bars (
          ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
          low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
          PRIMARY KEY (ticker, date)
        );
        INSERT INTO daily_bars VALUES ('XYZ', '2024-01-02', 10, 11, 9, 10, 100);
      `);

      await expect(updateCachedBars(
        database,
        ["XYZ"],
        "2024-01-03",
        "2024-01-10",
        async () => { throw new Error("Alpaca unavailable."); },
        true
      )).rejects.toThrow("Alpaca unavailable.");

      expect(getCachedBars(database, "XYZ", "2024-01-01", "2024-01-10")).toHaveLength(1);
      database.close();
    });
  });
});
