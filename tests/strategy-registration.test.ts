import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Bar, RankedStrategyDefinition, StrategyEntryCandidate, StrategyEntryContext,
  StrategyExitContext, StrategyExitEvaluation, StrategyPositionContext
} from "../strategy-core/types.ts";
import type { Env, StockAlert } from "../src/types";

vi.mock("../strategy-core/setups/a.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../strategy-core/setups/a.ts")>();
  return {
    ...original,
    strategyA: {
      ...original.strategyA,
      entry: {
        ...original.strategyA.entry,
        regimePasses: () => true,
        evaluate: (context: StrategyEntryContext) => context.timing === "close" ? [{ ticker: context.instrument.ticker }] : []
      },
      exit: {
        ...original.strategyA.exit,
        needsUniverse: true,
        prepare: (universe: readonly { ticker: string }[]) => ({
          ranks: [], retainedTickers: new Set(universe.map(({ ticker }) => ticker))
        }),
        evaluate: (context: StrategyExitContext): StrategyExitEvaluation => ({
          signal: context.universeState.retainedTickers.has(context.instrument.ticker) ? "Exit Tier 2" : null,
          reason: context.universeState.retainedTickers.has(context.instrument.ticker) ? "Universe prepared" : null,
          immediate: false, state: context.position.state
        })
      }
    }
  };
});

vi.mock("../strategy-core/setups/d.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../strategy-core/setups/d.ts")>();
  const { initialPositionState } = await import("../strategy-core/positions.ts");
  return {
    ...original,
    strategyD: {
      ...original.strategyD,
      id: "Setup E",
      code: "E",
      name: "Registered test strategy",
      entry: {
        description: "Custom ranked entries.",
        regimePasses: () => true,
        evaluate(context: StrategyEntryContext): StrategyEntryCandidate[] {
          return context.timing === "ranked-close"
            ? context.universe.map(({ ticker }) => ({ ticker, data: { stopDistance: 3 } }))
            : [];
        }
      },
      exit: {
        ...original.strategyD.exit,
        description: "Custom stateful exit.",
        evaluate(context: StrategyExitContext): StrategyExitEvaluation {
          const heldSessions = Number(context.position.state.heldSessions ?? 0) + 1;
          return {
            signal: heldSessions >= 2 ? "Exit Tier 2" : null,
            reason: heldSessions >= 2 ? "Registered strategy exit" : null,
            state: { ...context.position.state, heldSessions },
            immediate: false
          };
        }
      },
      position: {
        ...original.strategyD.position,
        stopReason: "Registered strategy stop",
        initialize(context: StrategyPositionContext) {
          return {
            stopPrice: context.entryPrice - Number(context.candidate.data?.stopDistance),
            targetPrice: Number.POSITIVE_INFINITY,
            state: { ...initialPositionState(), heldSessions: 0 }
          };
        }
      }
    } satisfies RankedStrategyDefinition
  };
});

import { runSimulation } from "../src/backtest/simulator.ts";
import { validateConfig } from "../src/backtest/config.ts";
import { advanceMomentumSignals, parseMomentumState } from "../src/momentum-signals.ts";
import { strategyCatalog } from "../strategy-core/strategy.ts";
import worker from "../src/index.ts";
import { PaperTrading } from "../src/paper-trading";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function bars(count = 307, end = "2026-11-16"): Bar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(Date.parse(`${end}T05:00:00Z`) - (count - 1 - index) * 86_400_000).toISOString(),
    open: 100, high: 101, low: 99, close: 100, volume: 1000
  }));
}

function settings(values: Bar[]) {
  return validateConfig({
    strategy: { setups: ["Setup E"], watchlist: ["AAPL"] },
    dateWindow: { start: values[300]!.timestamp.slice(0, 10), end: values[303]!.timestamp.slice(0, 10) },
    portfolio: { startingCapital: 100000, maxOpenPositions: 2, sizing: { type: "fixed-dollar", value: 1 } },
    stops: { initial: { type: "fixed-percent", value: 1 }, leftSideFailurePercent: 3 },
    profitTaking: { type: "fixed-percent", value: 0.1, partialPercent: 100 },
    trailingExitEma: "disabled",
    costs: { slippagePercent: 0, commissionPerOrder: 0 }
  });
}

describe("registry-owned strategy execution", () => {
  it("prepares universe-dependent exits for a close strategy without selecting a ranked strategy", () => {
    const values = bars();
    const config = settings(values);
    config.strategy.setups = ["Setup A"];
    config.stops.initial = { type: "fixed-percent", value: 8 };
    config.profitTaking = { type: "risk-multiple", value: 2, partialPercent: 50 };
    const result = runSimulation(config, { VOO: values, AAPL: values });
    expect(result.trades[0]).toMatchObject({
      setup: "Setup A", exitReason: "Universe prepared",
      entryDate: values[301]!.timestamp.slice(0, 10), exitDate: values[302]!.timestamp.slice(0, 10)
    });
  });

  it("runs a new setup ID's entry gate, position rules, sizing and stateful exit without simulator changes", () => {
    const values = bars();
    const config = settings(values);
    const result = runSimulation(config, { VOO: values, AAPL: values });
    expect(result.trades[0]).toMatchObject({
      setup: "Setup E", shares: 500, exitReason: "Registered strategy exit",
      entryDate: values[301]!.timestamp.slice(0, 10), exitDate: values[303]!.timestamp.slice(0, 10)
    });
    expect(strategyCatalog.find((strategy) => String(strategy.id) === "Setup E")).toMatchObject({
      description: "Custom ranked entries.", exitDescription: "Custom stateful exit."
    });
  });

  it("uses registered protective stops and carries entry payloads into simulated and alert-only positions", () => {
    const values = bars();
    const stock = values.map((bar, index) => index === 301 ? { ...bar, low: 96 } : bar);
    const result = runSimulation(settings(values), { VOO: values, AAPL: stock });
    expect(result.trades[0]).toMatchObject({
      setup: "Setup E", exitPrice: 97, shares: 500, exitReason: "Registered strategy stop"
    });
    const initial = advanceMomentumSignals(parseMomentumState(null),
      values[300]!.timestamp.slice(0, 10), ["AAPL"], { VOO: values, AAPL: stock });
    expect(initial.alerts[0]).toMatchObject({ strategy: "Setup E", type: "Setup E", stopLoss: 97 });
    const next = advanceMomentumSignals(parseMomentumState(JSON.stringify(initial)),
      values[301]!.timestamp.slice(0, 10), ["AAPL"], { VOO: values, AAPL: stock });
    expect(next.alerts[0]).toMatchObject({ strategy: "Setup E", type: "Hard Stop", stopLoss: 97 });
  });

  it("automatically scans registered ranked strategies but never forwards them to paper execution", async () => {
    const values = new Map<string, string>();
    const execute = vi.fn(async (_body: unknown) => Response.json({ submitted: 0 }));
    const env = {
      ALPACA_API_KEY: "test-key", ALPACA_API_SECRET_KEY: "test-secret",
      ASSETS: { fetch: async () => Response.json({ watchlist: ["AAPL"] }) },
      WTRACK_KV: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => { values.set(key, value); }
      },
      PAPER_TRADING: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            if (url.endsWith("/status")) return Response.json({ enabled: true });
            if (url.endsWith("/symbols")) return Response.json({ symbols: [] });
            if (url.endsWith("/execute")) return execute(JSON.parse(String(init?.body)));
            throw new Error(`Unexpected paper route: ${url}`);
          }
        })
      }
    } as unknown as Env;
    const history = bars(300).map((bar) => ({
      t: bar.timestamp, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      bars: { VOO: history, QQQ: history, AAPL: history }, next_page_token: null
    })));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T21:30:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    worker.scheduled({
      scheduledTime: Date.parse("2026-11-16T21:30:00Z"), cron: "30 21 * * 1-5"
    } as ScheduledController, env, {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise)
    } as unknown as ExecutionContext);
    await Promise.all(pending);
    const snapshot = JSON.parse(values.get("latest-scan")!);
    expect(snapshot.tickers[0].signals).toEqual(["Setup A", "Setup E"]);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      alerts: [expect.objectContaining({ ticker: "AAPL", type: "Setup A" })]
    }));
  });

  it("rejects registered ranked exits inside paper trading even when sent directly", async () => {
    const stored = new Map<string, unknown>([
      ["enabled", true],
      ["orders", [{
        clientId: "owned-entry", ticker: "AAPL", side: "buy", signalDate: "2026-11-13",
        phase: "close", qty: "1", limit: "100.00", status: "filled", filledQty: "1"
      }]]
    ]);
    const object = new PaperTrading({
      storage: {
        get: async (key: string) => structuredClone(stored.get(key)),
        put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); }
      }
    } as unknown as DurableObjectState, {
      ALPACA_API_KEY: "test-key", ALPACA_API_SECRET_KEY: "test-secret"
    } as Env);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).not.toBe("POST");
      const url = new URL(input.toString());
      expect(url.origin).toBe("https://paper-api.alpaca.markets");
      if (url.pathname === "/v2/account") return Response.json({
        id: "paper-account", trading_blocked: false, account_blocked: false
      });
      if (url.pathname === "/v2/positions") return Response.json([{ symbol: "AAPL", qty: "1", side: "long" }]);
      if (url.pathname === "/v2/orders") return Response.json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await object.fetch(new Request("https://paper.internal/execute", {
      method: "POST",
      body: JSON.stringify({
        date: "2026-11-16", phase: "close",
        alerts: [{
          ticker: "AAPL", type: "Exit Tier 2", strategy: "Setup E" as StockAlert["strategy"],
          date: "2026-11-16", close: 100
        }]
      })
    }));
    expect(await response.json()).toEqual({ submitted: 0 });
    expect(stored.get("orders")).toHaveLength(1);
  });
});
