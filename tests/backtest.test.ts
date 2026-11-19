import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getCachedBars, openCache, updateCachedBars } from "../src/backtest/cache.ts";
import { currentSessionIsComplete, validateConfig } from "../src/backtest/config.ts";
import { runSimulation } from "../src/backtest/simulator.ts";
import { Backtest } from "../src/backtest/server";
import { calculateIndicators } from "../strategy-core/indicators.ts";
import type { Bar } from "../strategy-core/types.ts";
import type { Env } from "../src/types";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createStorage() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  const storage = {
    sql: {
      exec(query: string, ...bindings: (string | number | null)[]) {
        const rows = sqlite.prepare(query).all(...bindings);
        return { toArray: () => rows };
      }
    },
    transactionSync<T>(callback: () => T): T {
      sqlite.exec("BEGIN");
      try {
        const result = callback();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as DurableObjectStorage;
  return openCache(storage);
}

function backtestRequest(action: string, body?: unknown, origin = "https://wtrack.example") {
  return new Request(`https://wtrack.example/admin/backtest/${action}`, body === undefined ? {} : {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function createBacktest(storage = createStorage()) {
  return new Backtest({ storage } as DurableObjectState, {
    ALPACA_API_KEY: "test-key", ALPACA_API_SECRET_KEY: "test-secret"
  } as Env);
}

function mockBars(bars: Bar[] | Record<string, Bar[]>) {
  const fetcher = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(input.toString());
    const ticker = url.searchParams.get("symbols")!;
    const start = url.searchParams.get("start")!.slice(0, 10);
    const end = url.searchParams.get("end")!.slice(0, 10);
    return Response.json({
      bars: { [ticker]: (Array.isArray(bars) ? bars : bars[ticker] ?? []).filter((bar) => {
        const date = bar.timestamp.slice(0, 10);
        return date >= start && date <= end;
      }).map((bar) => ({
        t: bar.timestamp, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume
      })) },
      next_page_token: null
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

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
  it("reports actual trading dates and benchmarks VOO from the same first open to last close", () => {
    const dates = ["2024-01-05", "2024-01-08", "2024-01-12", "2024-01-16"];
    const bars = dates.map((date) => ({ ...makeBars(1)[0]!, timestamp: `${date}T00:00:00Z` }));
    const voo = bars.map((bar, index) => ({
      ...bar, open: 100, close: [500, 105, 110, 900][index]!
    }));
    const result = runSimulation(config("2024-01-06", "2024-01-14"), { SPY: bars, VOO: voo, XYZ: bars });
    expect(result.period).toEqual({ start: "2024-01-08", end: "2024-01-12", tradingDays: 2 });
    expect(result.benchmark.ticker).toBe("VOO");
    expect(result.benchmark.returnPercent).toBeCloseTo(10);
  });

  it("does not compare a shorter VOO period when a boundary session is missing", () => {
    const bars = makeBars(307);
    const settings = config(bars[302]!.timestamp.slice(0, 10), bars[306]!.timestamp.slice(0, 10));
    for (const voo of [bars.slice(0, 306), bars.slice(303), []]) {
      const result = runSimulation(settings, { SPY: bars, VOO: voo, XYZ: bars });
      expect(result.benchmark.returnPercent).toBeNull();
    }
  });

  it("reports no trading period or benchmark when the date window contains no sessions", () => {
    const bars = makeBars(307);
    const result = runSimulation(config("2023-01-01", "2023-01-02"), { SPY: bars, VOO: bars, XYZ: bars });
    expect(result.period).toEqual({ start: null, end: null, tradingDays: 0 });
    expect(result.benchmark.returnPercent).toBeNull();
  });

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
      const database = createStorage();
      database.sql.exec("INSERT INTO daily_bars VALUES ('XYZ', '2024-01-02', 10, 11, 9, 10, 100)");

      await expect(updateCachedBars(
        database,
        ["XYZ"],
        "2024-01-03",
        "2024-01-10",
        async () => { throw new Error("Alpaca unavailable."); },
        true
      )).rejects.toThrow("Alpaca unavailable.");

      expect(getCachedBars(database, "XYZ", "2024-01-01", "2024-01-10")).toHaveLength(1);
    });

    it("tracks requested coverage independently of weekends and only downloads new dates", async () => {
      const database = createStorage();
      const fetcher = vi.fn(async () => [makeBars(1)[0]!]);
      await updateCachedBars(database, ["XYZ"], "2024-01-03", "2024-01-10", fetcher);
      await updateCachedBars(database, ["XYZ"], "2024-01-03", "2024-01-12", fetcher);
      expect(fetcher.mock.calls).toHaveLength(2);
      expect(fetcher).toHaveBeenLastCalledWith("XYZ", "2024-01-10", "2024-01-12");
    });
  });
});

describe("Worker backtest service", () => {
  it("persists one online config only through Save and retains relative today dates across reloads", async () => {
    const storage = createStorage();
    const service = createBacktest(storage);
    const settings = config("2024-01-03", "2024-01-10");
    settings.dateWindow.end = "today";
    settings.strategy.setups = ["Setup A"];
    const saved = await service.fetch(backtestRequest("save", { config: settings }));
    expect(saved.status).toBe(200);
    const restarted = createBacktest(storage);
    const loaded = await restarted.fetch(backtestRequest("config"));
    expect(await loaded.json()).toMatchObject({
      config: settings,
      strategies: [expect.objectContaining({ code: "A", description: expect.any(String) }),
        expect.objectContaining({ code: "B" }), expect.objectContaining({ code: "C" }),
        expect.objectContaining({ code: "D" })]
    });
    const defaults = await (await restarted.fetch(backtestRequest("config"))).json() as { config: typeof settings };
    expect(defaults.config.strategy.setups).toEqual(["Setup A"]);
    const invalid = await restarted.fetch(backtestRequest("save", { config: {} }));
    expect(invalid.status).toBe(400);
    expect(await (await restarted.fetch(backtestRequest("config"))).json())
      .toMatchObject({ config: settings });
  });

  it("uses an explicitly saved default config without changing the bundled deployment seed", async () => {
    const service = createBacktest();
    const settings = config("2024-01-03", "2024-01-10");
    settings.strategy.setups = ["Setup B"];
    expect((await service.fetch(backtestRequest("save", { config: settings }))).status).toBe(200);
    expect(await (await service.fetch(backtestRequest("config"))).json()).toMatchObject({ config: settings });
    expect(await (await createBacktest().fetch(backtestRequest("config"))).json())
      .toMatchObject({ config: { strategy: { setups: ["Setup A", "Setup B", "Setup C"] } } });
  });

  it("serves defaults and cache status without a separate Node server", async () => {
    const service = createBacktest();
    const defaults = await service.fetch(backtestRequest("config"));
    expect(defaults.status).toBe(200);
    expect(defaults.headers.get("cache-control")).toBe("no-store");
    expect(await defaults.json()).toMatchObject({ config: { strategy: { setups: ["Setup A", "Setup B", "Setup C"] } } });
    expect(await (await service.fetch(backtestRequest("cache"))).json()).toEqual({ tickers: [] });
  });

  it("fetches history, runs the shared simulation, and reuses cached bars for a covered window", async () => {
    const service = createBacktest();
    const bars = makeBars(307);
    const fetcher = mockBars(bars);
    const settings = config(bars[302]!.timestamp.slice(0, 10), bars[306]!.timestamp.slice(0, 10));
    const response = await service.fetch(backtestRequest("run", { config: settings }));
    expect(response.status).toBe(200);
    const result = await response.json() as { result: ReturnType<typeof runSimulation>; cache: unknown[] };
    expect(result.result).toEqual(runSimulation(settings, { SPY: bars, VOO: bars, XYZ: bars }));
    expect(result.cache).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await (await service.fetch(backtestRequest("config"))).json()).toMatchObject({
      config: { strategy: { setups: ["Setup A", "Setup B", "Setup C"] } }
    });
    expect(fetcher.mock.calls.map(([input]) => new URL(input.toString()).searchParams.get("symbols")))
      .toEqual(["SPY", "VOO", "XYZ"]);
    for (const [input] of fetcher.mock.calls) {
      expect(new URL(input.toString()).searchParams.get("adjustment")).toBe("split");
    }
    settings.dateWindow.end = bars[305]!.timestamp.slice(0, 10);
    expect((await service.fetch(backtestRequest("run", { config: settings }))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not require indicator warm-up for a benchmark that is not traded", async () => {
    const service = createBacktest();
    const bars = makeBars(307);
    const voo = bars.slice(302);
    mockBars({ SPY: bars, XYZ: bars, VOO: voo });
    const response = await service.fetch(backtestRequest("run", {
      config: config(bars[302]!.timestamp.slice(0, 10), bars[306]!.timestamp.slice(0, 10))
    }));
    expect(response.status).toBe(200);
    const value = await response.json() as { result: ReturnType<typeof runSimulation> };
    expect(value.result.benchmark.returnPercent).toBeCloseTo((voo.at(-1)!.close / voo[0]!.open - 1) * 100);
  });

  it("excludes the current incomplete session from the integrated simulation", async () => {
    const service = createBacktest();
    const bars = makeBars(307);
    const end = bars[306]!.timestamp.slice(0, 10);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${end}T15:00:00Z`));
    mockBars(bars);
    const response = await service.fetch(backtestRequest("run", {
      config: config(bars[302]!.timestamp.slice(0, 10), end)
    }));
    const value = await response.json() as { result: ReturnType<typeof runSimulation> };
    expect(response.status).toBe(200);
    expect(value.result.equityCurve.at(-1)?.date).toBe(bars[305]!.timestamp.slice(0, 10));
    expect(value.result.period.end).toBe(bars[305]!.timestamp.slice(0, 10));
    expect(value.result.benchmark.returnPercent).toBeCloseTo((bars[305]!.close / bars[302]!.open - 1) * 100);
  });

  it("rejects insufficient warm-up history and surfaces upstream failures", async () => {
    const service = createBacktest();
    const bars = makeBars(307);
    const settings = config(bars[298]!.timestamp.slice(0, 10), bars[306]!.timestamp.slice(0, 10));
    mockBars(bars);
    const insufficient = await service.fetch(backtestRequest("run", { config: settings }));
    expect(insufficient.status).toBe(502);
    expect(await insufficient.json()).toMatchObject({ error: expect.stringContaining("at least 300") });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Alpaca unavailable.")));
    const failure = await service.fetch(backtestRequest("refresh", { config: settings }));
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({ error: "Alpaca unavailable." });
    const cache = await (await service.fetch(backtestRequest("cache"))).json() as { tickers: unknown[] };
    expect(cache.tickers).toHaveLength(3);
  });

  it("rejects cross-origin requests, invalid config, malformed JSON, and oversized input before fetching data", async () => {
    const service = createBacktest();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect((await service.fetch(backtestRequest("run", {}, "https://other.example"))).status).toBe(403);
    expect((await service.fetch(backtestRequest("run", { config: {} }))).status).toBe(400);
    for (const body of ["{", "x".repeat(1_000_001)]) {
      const response = await service.fetch(new Request("https://wtrack.example/admin/backtest/run", {
        method: "POST", headers: { origin: "https://wtrack.example" }, body
      }));
      expect(response.status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not interleave simulations and refreshes", async () => {
    const service = createBacktest();
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("Upstream unavailable.");
    }));
    const running = service.fetch(backtestRequest("run", {}));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect((await service.fetch(backtestRequest("refresh", {}))).status).toBe(409);
    release();
    expect((await running).status).toBe(502);
  });
});
