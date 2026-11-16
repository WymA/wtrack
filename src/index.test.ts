import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

function createEnv(values: Map<string, string>) {
  const kv = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    }
  };
  const assetsFetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/admin") return new Response("Admin page");
    return new Response("Not found", { status: 404 });
  });
  const env = {
    WTRACK_KV: kv,
    ASSETS: { fetch: assetsFetch }
  } as unknown as Env;

  return { env, assetsFetch };
}

describe("admin actions", () => {
  it.each([
    { watchlist: ["AAPL"], expectedSymbols: ["SPY", "QQQ", "AAPL"], previous: 100, change: -10, percent: -10 },
    { watchlist: ["AAPL"], expectedSymbols: ["SPY", "QQQ", "AAPL"], previous: 0, change: 90, percent: null },
    { watchlist: ["AAPL"], expectedSymbols: ["SPY", "QQQ", "AAPL"], previous: null, change: null, percent: null },
    { watchlist: ["QQQ"], expectedSymbols: ["SPY", "QQQ"], previous: 100, change: -10, percent: -10 }
  ])("stores daily changes for $watchlist with previous close $previous", async ({
    watchlist, expectedSymbols, previous, change, percent
  }) => {
    const values = new Map([["watchlist", JSON.stringify(watchlist)]]);
    const { env } = createEnv(values);
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

  it("merges and removes the legacy holdings list", async () => {
    const values = new Map([
      ["watchlist", '["aapl","MSFT"]'],
      ["holdings", '["MSFT","NVDA"]']
    ]);
    const { env } = createEnv(values);
    const request = new Request("https://wtrack.example/admin/watchlist");

    const response = await worker.fetch(request, env);

    expect(await response.json()).toEqual({
      watchlist: ["AAPL", "MSFT", "NVDA"],
      snapshot: null,
      lastScheduledRun: null
    });
    expect(values.get("watchlist")).toBe('["AAPL","MSFT","NVDA"]');
    expect(values.has("holdings")).toBe(false);
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

  it("serves the admin page at /admin", async () => {
    const { env } = createEnv(new Map());
    const request = new Request("https://wtrack.example/admin");

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Admin page");
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

      const response = await worker.fetch(new Request("https://wtrack.example/admin/watchlist"), env);
      const payload = await response.json() as { lastScheduledRun: unknown };
      expect(payload.lastScheduledRun).toEqual(JSON.parse(storedRecord ?? ""));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
