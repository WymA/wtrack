import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env, StockAlert } from "../src/types";

function createEnv(values: Map<string, string>, watchlist: unknown = []) {
  let enabled = false;
  const kv = {
    get: vi.fn(async (key: string) => {
      return values.get(key) ?? null;
    }),
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    }
  };
  const assetsFetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/admin/") return new Response("Admin page");
    if (new URL(request.url).pathname === "/watchlist.json") return Response.json({ watchlist });
    return new Response("Not found", { status: 404 });
  });
  const backtestFetch = vi.fn(async () => Response.json({ result: { simulated: true } }));
  const env = {
    WTRACK_KV: kv,
    ASSETS: { fetch: assetsFetch },
    BACKTEST: {
      idFromName: () => ({}),
      get: () => ({ fetch: backtestFetch })
    },
    PAPER_TRADING: {
      idFromName: () => ({}),
      get: () => ({
        async fetch(url: string, init?: RequestInit) {
          if (url.endsWith("/status")) return Response.json({ enabled });
          if (url.endsWith("/orders")) return Response.json({ orders: [{ ticker: "AAPL", status: "new" }] });
          if (url.endsWith("/switch")) {
            const value = JSON.parse(String(init?.body)) as { enabled: boolean };
            enabled = value.enabled;
            return Response.json({ enabled });
          }
          throw new Error(`Unexpected coordinator request ${url}`);
        }
      })
    }
  } as unknown as Env;

  return { env, assetsFetch, kv, backtestFetch };
}

describe("admin actions", () => {
  it.each(["run", "save"])("forwards Backtest %s requests to the integrated service", async (action) => {
    const { env, backtestFetch } = createEnv(new Map());
    const request = new Request(`https://wtrack.example/admin/backtest/${action}`, {
      method: "POST", headers: { origin: "https://wtrack.example" }, body: "{}"
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(backtestFetch).toHaveBeenCalledWith(request);
    expect(await response.json()).toEqual({ result: { simulated: true } });
  });

  it("validates Backtest API routes, methods, and origin before dispatch", async () => {
    const { env, backtestFetch } = createEnv(new Map());
    for (const [action, method, origin, status] of [
      ["run", "GET", "https://wtrack.example", 405],
      ["save", "GET", "https://wtrack.example", 405],
      ["config", "POST", "https://wtrack.example", 405],
      ["run", "POST", "https://other.example", 403],
      ["save", "POST", "https://other.example", 403],
      ["unknown", "GET", "https://wtrack.example", 404]
    ] as const) {
      const response = await worker.fetch(new Request(`https://wtrack.example/admin/backtest/${action}`, {
        method, headers: { origin }
      }), env);
      expect(response.status).toBe(status);
    }
    expect(backtestFetch).not.toHaveBeenCalled();
    for (const action of ["config", "cache"]) {
      expect((await worker.fetch(new Request(`https://wtrack.example/admin/backtest/${action}`), env)).status).toBe(200);
    }
    expect(backtestFetch).toHaveBeenCalledTimes(2);
  });

  it("serves saved orders only through the admin GET route", async () => {
    const { env } = createEnv(new Map());
    const response = await worker.fetch(new Request("https://wtrack.example/admin/orders"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ orders: [{ ticker: "AAPL", status: "new" }] });
    const post = await worker.fetch(new Request("https://wtrack.example/admin/orders", { method: "POST" }), env);
    expect(post.status).toBe(405);
  });

  it("completes scans with signals when notifications are not configured", async () => {
    const values = new Map<string, string>();
    const { env } = createEnv(values, ["AAPL"]);
    env.ALPACA_API_KEY = "test-key";
    env.ALPACA_API_SECRET_KEY = "test-secret";
    const now = new Date("2026-11-16T21:30:00Z");
    const bars = Array.from({ length: 300 }, (_, index) => ({
      t: new Date(now.getTime() - (299 - index) * 86_400_000).toISOString(),
      o: 100, h: 101, l: 89, c: 100, v: 1_000
    }));
    const declining = bars.map((bar, index) => ({ ...bar, c: index >= 298 ? 90 : 100 }));
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      bars: { SPY: bars, QQQ: bars, AAPL: declining },
      next_page_token: null
    })));
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request("https://wtrack.example/admin/scan"), env);
      expect(response.status).toBe(200);
      const result = await response.json() as { alerts: { type: string }[]; notified: unknown[] };
      expect(result.alerts.map((alert) => alert.type)).toEqual(["Exit Tier 2", "Exit Tier 3"]);
      expect(result.notified).toEqual([]);
      const snapshot = JSON.parse(values.get("latest-scan") ?? "") as { tickers: { signals: string[] }[] };
      expect(snapshot.tickers[0]?.signals).toEqual(["Exit Tier 2", "Exit Tier 3"]);
      expect(values.has("alerts:2026-11-16")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      log.mockRestore();
    }
  });

  it("advances D only after the close and excludes its alerts from scheduled paper execution", async () => {
    const values = new Map<string, string>();
    const { env } = createEnv(values, ["AAPL"]);
    env.ALPACA_API_KEY = "test-key";
    env.ALPACA_API_SECRET_KEY = "test-secret";
    const coordinator = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/status")) return Response.json({ enabled: true });
      if (url.endsWith("/symbols")) return Response.json({ symbols: [] });
      if (url.endsWith("/execute")) return Response.json({ submitted: 0 });
      throw new Error(`Unexpected coordinator request ${url}`);
    });
    env.PAPER_TRADING = {
      idFromName: () => ({}), get: () => ({ fetch: coordinator })
    } as unknown as DurableObjectNamespace;
    const bars = Array.from({ length: 340 }, (_, index) => {
      const close = 100 + index * 0.2;
      return {
        t: new Date(Date.parse("2026-11-16T05:00:00Z") - (339 - index) * 86_400_000).toISOString(),
        o: close - 0.1, h: close + 1, l: close - 1, c: close, v: 1000
      };
    });
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      bars: { SPY: bars, QQQ: bars, AAPL: bars }, next_page_token: null
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T15:00:00Z"));
    vi.stubGlobal("fetch", fetcher);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const early = await worker.fetch(new Request("https://wtrack.example/admin/scan"), env);
      expect(early.status).toBe(200);
      expect(values.has("momentum-signal-state")).toBe(false);
      vi.setSystemTime(new Date("2026-11-16T21:30:00Z"));
      fetcher.mockResolvedValue(Response.json({
        bars: { SPY: bars, QQQ: bars, AAPL: bars }, next_page_token: null
      }));
      const scheduledWork: Promise<unknown>[] = [];
      worker.scheduled({
        scheduledTime: Date.parse("2026-11-16T21:30:00Z"), cron: "30 21 * * 1-5"
      } as ScheduledController, env, {
        waitUntil: (promise: Promise<unknown>) => scheduledWork.push(promise)
      } as unknown as ExecutionContext);
      await Promise.all(scheduledWork);
      const state = JSON.parse(values.get("momentum-signal-state") ?? "") as { alerts: StockAlert[] };
      expect(state.alerts).toMatchObject([{ type: "Setup D", strategy: "Setup D", percentileRank: 100 }]);
      const execute = coordinator.mock.calls.find(([url]) => url.endsWith("/execute"));
      expect(execute).toBeDefined();
      expect(JSON.parse(String(execute![1]!.body)).alerts).toEqual([]);
      const snapshot = JSON.parse(values.get("latest-scan") ?? "");
      expect(snapshot.tickers[0].signals).toEqual(["Setup D"]);
      expect(state.alerts[0]!.ema200).toBe(snapshot.tickers[0].ema200);
    } finally {
      info.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each([
    { watchlist: ["AAPL"], expectedSymbols: ["SPY", "QQQ", "AAPL"], previous: 100, change: -10, percent: -10 },
    { watchlist: ["AAPL"], expectedSymbols: ["SPY", "QQQ", "AAPL"], previous: 0, change: 90, percent: null },
    { watchlist: ["AAPL"], expectedSymbols: ["SPY", "QQQ", "AAPL"], previous: null, change: null, percent: null },
    { watchlist: ["QQQ"], expectedSymbols: ["SPY", "QQQ"], previous: 100, change: -10, percent: -10 }
  ])("stores daily changes for $watchlist with previous close $previous", async ({
    watchlist, expectedSymbols, previous, change, percent
  }) => {
    const values = new Map<string, string>();
    const { env } = createEnv(values, watchlist);
    env.ALPACA_API_KEY = "test-key";
    env.ALPACA_API_SECRET_KEY = "test-secret";
    const now = new Date("2026-11-16T21:30:00Z");
    const bars = Array.from({ length: 300 }, (_, index) => ({
      t: new Date(now.getTime() - (299 - index) * 86_400_000).toISOString(),
      o: 100, h: 101, l: 99, c: 100, v: 1_000
    }));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      const symbols = (url.searchParams.get("symbols") ?? "").split(",");
      return Response.json({
        bars: Object.fromEntries(symbols.map((symbol) => [
          symbol,
          symbol === "SPY" ? bars : watchlist.includes(symbol)
            ? [
              ...(previous === null ? [] : [{ ...bars[298], c: previous }]),
              { ...bars[299], c: 90 }
            ]
            : []
        ])),
        next_page_token: null
      });
    });

    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", fetcher);
    try {
      const response = await worker.fetch(new Request("https://wtrack.example/admin/scan"), env);
      expect(response.status).toBe(200);
      const result = await response.json() as { status: string; marketRegime: Record<string, unknown> };
      expect(result.status).toBe("completed");
      expect(result.marketRegime).toEqual({
        passes: false,
        v2Passes: false,
        spy: { close: 100, ema50: expect.any(Number), ema200: expect.any(Number) }
      });
      expect(fetcher).toHaveBeenCalledOnce();
      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.searchParams.get("symbols")?.split(",")).toEqual(expectedSymbols);
      const snapshot = JSON.parse(values.get("latest-scan") ?? "") as {
        tickers: { ticker: string; change: number | null; changePercent: number | null }[];
        marketProxies: {
          spy: { close: number | null; change: number | null; changePercent: number | null };
          qqq: { close: number | null; change: number | null; changePercent: number | null; asOfDate: string | null };
        };
      };
      expect(snapshot.tickers.map((ticker) => ticker.ticker)).toEqual(watchlist);
      expect(snapshot.tickers[0]).toMatchObject({ change, changePercent: percent });
      expect(snapshot.marketProxies.spy).toMatchObject({ close: 100, change: 0, changePercent: 0 });
      expect(snapshot.marketProxies.qqq).toMatchObject(watchlist.includes("QQQ")
        ? { close: 90, change, changePercent: percent, asOfDate: "2026-11-16" }
        : { close: null, change: null, changePercent: null, asOfDate: null });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("returns the watchlist file unchanged without accessing KV or paper trading state", async () => {
    const { env, kv, assetsFetch } = createEnv(new Map([["watchlist", '["OLD"]']]));
    const source = '{\n  "watchlist": ["aapl", " MSFT ", "AAPL"],\n  "note": "from file"\n}\n';
    assetsFetch.mockResolvedValueOnce(new Response(source, { headers: { "content-type": "application/json" } }));
    const getTradingObject = vi.spyOn(env.PAPER_TRADING, "get");
    const response = await worker.fetch(new Request("https://wtrack.example/admin/watchlist"), env);
    expect(await response.text()).toBe(source);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(kv.get).not.toHaveBeenCalled();
    expect(getTradingObject).not.toHaveBeenCalled();
  });

  it("normalizes the asset watchlist for the dashboard without modifying old KV lists", async () => {
    const values = new Map([
      ["watchlist", '["OLD"]'],
      ["holdings", '["LEGACY"]']
    ]);
    const { env, kv } = createEnv(values, ["aapl", " MSFT ", "AAPL"]);
    const request = new Request("https://wtrack.example/admin/dashboard");

    const response = await worker.fetch(request, env);

    expect(await response.json()).toEqual({
      watchlist: ["AAPL", "MSFT"],
      snapshot: null,
      lastScheduledRun: null,
      paperTradingEnabled: false
    });
    expect(values.get("watchlist")).toBe('["OLD"]');
    expect(values.get("holdings")).toBe('["LEGACY"]');
    expect(kv.get.mock.calls.map(([key]) => key)).not.toContain("watchlist");
    expect(kv.get.mock.calls.map(([key]) => key)).not.toContain("holdings");
  });

  it("reports invalid or missing watchlist assets instead of using KV", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { env, assetsFetch } = createEnv(new Map([["watchlist", '["OLD"]']]), ["INVALID SYMBOL"]);
      const request = new Request("https://wtrack.example/admin/watchlist");
      expect((await worker.fetch(request, env)).status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith("Request failed:", expect.any(TypeError));
      assetsFetch.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
      expect((await worker.fetch(request, env)).status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith("Request failed:", expect.objectContaining({
        message: "Unable to load watchlist.json: asset returned status 404."
      }));
      assetsFetch.mockResolvedValueOnce(Response.json({ wrong: [] }));
      expect((await worker.fetch(request, env)).status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith("Request failed:", expect.objectContaining({
        message: "watchlist.json must contain a watchlist array."
      }));
      assetsFetch.mockResolvedValueOnce(new Response("{"));
      expect((await worker.fetch(request, env)).status).toBe(500);
      expect(errorSpy).toHaveBeenCalledWith("Request failed:", expect.any(SyntaxError));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not expose the old standalone action routes", async () => {
    const { env, assetsFetch } = createEnv(new Map());
    for (const path of ["/scan", "/ping", "/watchlist"]) {
      const request = new Request(`https://wtrack.example${path}`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(404);
    }
    expect(assetsFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["/admin", "/admin/"])("serves the admin page at %s without an index.html redirect", async (path) => {
    const { env, assetsFetch } = createEnv(new Map());
    const request = new Request(`https://wtrack.example${path}`);

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Admin page");
    expect(new URL(assetsFetch.mock.calls[0][0].url).pathname).toBe("/admin/");
  });

  it("rejects cross-origin paper switch requests", async () => {
    const { env } = createEnv(new Map());
    const request = (origin: string) => new Request("https://wtrack.example/admin/paper-trading", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    const crossOrigin = await worker.fetch(request("https://other.example"), env);
    expect(crossOrigin.status).toBe(403);
  });

  it("persists paper switch changes and exposes the current state", async () => {
    const { env } = createEnv(new Map());
    for (const enabled of [true, false]) {
      const response = await worker.fetch(new Request("https://wtrack.example/admin/paper-trading", {
        method: "POST",
        headers: {
          origin: "https://wtrack.example",
          "content-type": "application/json"
        },
        body: JSON.stringify({ enabled })
      }), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ enabled });
      const state = await worker.fetch(new Request("https://wtrack.example/admin/paper-trading"), env);
      expect(await state.json()).toEqual({ enabled });
    }
  });

  it("records scheduled failures and exposes the latest run record", async () => {
    const values = new Map<string, string>();
    const { env } = createEnv(values);
    const scheduledWork: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) {
        scheduledWork.push(promise);
      }
    } as unknown as ExecutionContext;
    const controller = {
      scheduledTime: Date.parse("2026-11-16T21:30:00Z"),
      cron: "30 21 * * 1-5"
    } as ScheduledController;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      worker.scheduled(controller, env, context);
      const task = scheduledWork[0];
      if (!task) throw new Error("The scheduled task was not registered.");
      await expect(task).rejects.toThrow("ALPACA_API_KEY and ALPACA_API_SECRET_KEY must be configured.");

      const storedRecord = values.get("last-scheduled-run");
      expect(storedRecord).toBeDefined();
      expect(JSON.parse(storedRecord ?? "")).toEqual({
        completedAt: expect.any(String),
        success: false
      });

      const response = await worker.fetch(new Request("https://wtrack.example/admin/dashboard"), env);
      const payload = await response.json() as { lastScheduledRun: unknown };
      expect(payload.lastScheduledRun).toEqual(JSON.parse(storedRecord ?? ""));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("uses the last completed session for the morning scheduled paper scan", async () => {
    const values = new Map<string, string>();
    const { env } = createEnv(values, ["AAPL"]);
    env.ALPACA_API_KEY = "test-key";
    env.ALPACA_API_SECRET_KEY = "test-secret";
    const coordinator = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/status")) return Response.json({ enabled: true });
      if (url.endsWith("/symbols")) return Response.json({ symbols: [] });
      if (url.endsWith("/execute")) return Response.json({ submitted: 0 });
      throw new Error(`Unexpected coordinator request ${url} ${init?.method}`);
    });
    env.PAPER_TRADING = {
      idFromName: () => ({}),
      get: () => ({ fetch: coordinator })
    } as unknown as DurableObjectNamespace;
    const latest = new Date("2026-11-13T21:00:00Z");
    const bars = Array.from({ length: 300 }, (_, index) => ({
      t: new Date(latest.getTime() - (299 - index) * 86_400_000).toISOString(),
      o: 100, h: 101, l: 90, c: index >= 298 ? 90 : 100, v: 1_000
    }));
    const marketFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v2/clock") return Response.json({ is_open: true });
      if (url.pathname === "/v2/calendar") {
        return Response.json([{ date: "2026-11-13" }, { date: "2026-11-16" }]);
      }
      if (url.pathname === "/v2/stocks/bars") {
        return Response.json({ bars: { SPY: bars, QQQ: bars, AAPL: bars }, next_page_token: null });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T15:15:00Z"));
    vi.stubGlobal("fetch", marketFetch);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const scheduledWork: Promise<unknown>[] = [];
      const context = { waitUntil: (promise: Promise<unknown>) => scheduledWork.push(promise) } as unknown as ExecutionContext;
      const controller = {
        scheduledTime: Date.parse("2026-11-16T15:15:00Z"), cron: "15 15 * * 1-5"
      } as ScheduledController;
      worker.scheduled(controller, env, context);
      await Promise.all(scheduledWork);
      const barsRequest = marketFetch.mock.calls.map(([url]) => new URL(String(url)))
        .find((url) => url.pathname === "/v2/stocks/bars");
      expect(barsRequest?.searchParams.get("end")).toBe("2026-11-16T00:00:00.000Z");
      const executeCall = coordinator.mock.calls.find(([url]) => url.endsWith("/execute"));
      const body = JSON.parse(String(executeCall?.[1]?.body)) as { date: string; phase: string; alerts: StockAlert[] };
      expect(body.date).toBe("2026-11-13");
      expect(body.phase).toBe("morning");
      expect(body.alerts.map((item) => item.type)).toEqual(["Exit Tier 2", "Exit Tier 3"]);
    } finally {
      info.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
