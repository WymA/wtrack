import { fetchDailyHistory, REQUIRED_DAILY_BARS } from "./data";
import { calculateIndicators } from "./indicators";
import { sendNewAlerts } from "./notifications";
import { advanceMomentumSignals, MOMENTUM_STATE_KEY, parseMomentumState } from "./momentum-signals";
import { momentumRegimePasses } from "../strategy-core/strategy";
import { currentSessionIsComplete } from "./backtest/config";
import { evaluateBuySetup, evaluateExitSignals, marketRegimePasses, recentSwingLow } from "./strategy";
import type { Bar, Env, IndicatorSeries, SignalType, StockAlert } from "./types";
export { PaperTrading } from "./paper-trading";
export { Backtest } from "./backtest/server";

const MAX_TRACKED_TICKERS = 200;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const WATCHLIST_ASSET_URL = "https://assets.local/watchlist.json";

interface BenchmarkSummary {
  close: number;
  ema50: number;
  ema200: number;
}

interface ScanResult {
  date: string;
  status: "completed" | "no-current-session";
  marketRegime: {
    passes: boolean;
    v2Passes?: boolean;
    spy: BenchmarkSummary;
  };
  alerts: StockAlert[];
  notified: StockAlert[];
  skipped: Array<{ ticker: string; reason: string }>;
}

interface DailyPrice {
  asOfDate: string | null;
  close: number | null;
  change: number | null;
  changePercent: number | null;
}

interface TickerSnapshot extends DailyPrice {
  ticker: string;
  stopLoss: number | null;
  ema20: number | null;
  ema50: number | null;
  ema100: number | null;
  ema200: number | null;
  historyBars: number;
  sufficientHistory: boolean;
  signals: SignalType[];
}

interface DashboardSnapshot {
  scannedAt: string;
  sessionDate: string;
  status: ScanResult["status"];
  marketRegime: ScanResult["marketRegime"];
  marketProxies: { spy: DailyPrice; qqq: DailyPrice };
  tickers: TickerSnapshot[];
}

const DASHBOARD_SNAPSHOT_KEY = "latest-scan";
const SCHEDULED_RUN_KEY = "last-scheduled-run";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function normalizeTickerList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_TRACKED_TICKERS ||
    !value.every((ticker) => typeof ticker === "string")
  ) {
    throw new TypeError(`tickers must be an array of at most ${MAX_TRACKED_TICKERS} strings.`);
  }

  const tickers = value.map((ticker) => ticker.trim().toUpperCase());
  if (!tickers.every((ticker) => TICKER_PATTERN.test(ticker))) {
    throw new TypeError("Each ticker must contain only letters, digits, periods, or hyphens.");
  }
  return [...new Set(tickers)];
}

async function loadWatchlistAsset(env: Env): Promise<{ response: Response; tickers: string[] }> {
  const response = await env.ASSETS.fetch(new Request(WATCHLIST_ASSET_URL));
  if (!response.ok) {
    throw new Error(`Unable to load watchlist.json: asset returned status ${response.status}.`);
  }
  const value: unknown = await response.clone().json();
  if (typeof value !== "object" || value === null || !("watchlist" in value)) {
    throw new TypeError("watchlist.json must contain a watchlist array.");
  }
  return { response, tickers: normalizeTickerList(value.watchlist) };
}

async function loadTickerList(env: Env): Promise<string[]> {
  return (await loadWatchlistAsset(env)).tickers;
}

async function handleDashboard(env: Env): Promise<Response> {
  const [tickers, storedSnapshot, storedScheduledRun, paperTradingEnabled] = await Promise.all([
    loadTickerList(env),
    env.WTRACK_KV.get(DASHBOARD_SNAPSHOT_KEY),
    env.WTRACK_KV.get(SCHEDULED_RUN_KEY),
    paperTradingStatus(env)
  ]);
  const snapshot: unknown = storedSnapshot === null ? null : JSON.parse(storedSnapshot);
  const lastScheduledRun: unknown = storedScheduledRun === null ? null : JSON.parse(storedScheduledRun);
  return jsonResponse({
    watchlist: tickers, snapshot, lastScheduledRun,
    paperTradingEnabled
  });
}

function paperTradingStub(env: Env): DurableObjectStub {
  return env.PAPER_TRADING.get(env.PAPER_TRADING.idFromName("paper-strategy"));
}

async function paperTradingRequest(env: Env, path: string, init?: RequestInit): Promise<unknown> {
  const response = await paperTradingStub(env).fetch(`https://paper.internal${path}`, init);
  if (!response.ok) throw new Error(`Paper trading coordinator failed: ${response.status}.`);
  return response.json();
}

async function paperTradingStatus(env: Env): Promise<boolean> {
  const value = await paperTradingRequest(env, "/status");
  if (typeof value !== "object" || value === null || !("enabled" in value) ||
    typeof value.enabled !== "boolean") throw new Error("Invalid paper trading status.");
  return value.enabled;
}

async function previousTradingSession(env: Env, today: string): Promise<string | null> {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET_KEY) {
    throw new Error("ALPACA_API_KEY and ALPACA_API_SECRET_KEY must be configured.");
  }
  const headers = {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY
  };
  const clock = await fetch("https://paper-api.alpaca.markets/v2/clock", { headers, signal: AbortSignal.timeout(15_000) });
  if (!clock.ok) throw new Error(`Alpaca clock request failed: ${clock.status}.`);
  const clockValue: unknown = await clock.json();
  if (typeof clockValue !== "object" || clockValue === null ||
    !("is_open" in clockValue) || typeof clockValue.is_open !== "boolean") {
    throw new Error("Alpaca returned an invalid market clock.");
  }
  if (!clockValue.is_open) return null;
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
  const calendar = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${today}`, {
    headers, signal: AbortSignal.timeout(15_000)
  });
  if (!calendar.ok) throw new Error(`Alpaca calendar request failed: ${calendar.status}.`);
  const days: unknown = await calendar.json();
  if (!Array.isArray(days) || !days.every((day) => typeof day === "object" && day !== null &&
    typeof day.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date))) {
    throw new Error("Alpaca returned an invalid market calendar.");
  }
  const dates: string[] = days.map((day) => day.date);
  if (!dates.includes(today)) throw new Error("Alpaca calendar does not include today's open session.");
  const previous = dates.filter((date) => date < today).sort().at(-1);
  if (!previous) throw new Error("Alpaca calendar has no previous trading session.");
  return previous;
}

function currentNewYorkDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Unable to determine the New York trading date.");
  return `${year}-${month}-${day}`;
}

function getBenchmarkSummary(bars: readonly Bar[], indicators: IndicatorSeries): BenchmarkSummary {
  const index = bars.length - 1;
  const latest = bars[index];
  const ema50 = indicators.ema50[index];
  const ema200 = indicators.ema200[index];
  if (latest === undefined || ema50 === undefined || ema200 === undefined) {
    throw new Error("Benchmark data is incomplete.");
  }
  return { close: latest.close, ema50, ema200 };
}

function createAlert(
  ticker: string,
  type: SignalType,
  bars: readonly Bar[],
  indicators: IndicatorSeries,
  date: string
): StockAlert {
  const index = bars.length - 1;
  const latest = bars[index];
  const ema20 = indicators.ema20[index];
  const ema50 = indicators.ema50[index];
  const ema100 = indicators.ema100[index];
  const ema200 = indicators.ema200[index];
  if (
    latest === undefined || ema20 === undefined || ema50 === undefined ||
    ema100 === undefined || ema200 === undefined
  ) {
    throw new Error(`Indicator data for ${ticker} is incomplete.`);
  }
  return {
    ticker,
    type,
    date,
    close: latest.close,
    stopLoss: recentSwingLow(bars),
    ema20,
    ema50,
    ema100,
    ema200
  };
}

function createTickerSnapshot(
  ticker: string,
  bars: readonly Bar[],
  signals: SignalType[]
): TickerSnapshot {
  const index = bars.length - 1;
  const latest = bars[index];
  const price = getDailyPrice(bars);
  if (latest === undefined) {
    return {
      ticker,
      ...price,
      stopLoss: null,
      ema20: null,
      ema50: null,
      ema100: null,
      ema200: null,
      historyBars: 0,
      sufficientHistory: false,
      signals
    };
  }

  const indicators = calculateIndicators(bars);
  return {
    ticker,
    ...price,
    stopLoss: recentSwingLow(bars),
    ema20: indicators.ema20[index] ?? null,
    ema50: indicators.ema50[index] ?? null,
    ema100: indicators.ema100[index] ?? null,
    ema200: indicators.ema200[index] ?? null,
    historyBars: bars.length,
    sufficientHistory: bars.length >= REQUIRED_DAILY_BARS,
    signals
  };
}

function getDailyPrice(bars: readonly Bar[]): DailyPrice {
  const latest = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const change = latest !== undefined && previous !== undefined
    ? latest.close - previous.close
    : null;
  return {
    asOfDate: latest?.timestamp.slice(0, 10) ?? null,
    close: latest?.close ?? null,
    change,
    changePercent: change !== null && previous !== undefined && previous.close > 0
      ? change / previous.close * 100
      : null
  };
}

function createDashboardSnapshot(
  tickers: readonly string[],
  data: Record<string, Bar[]>,
  alerts: readonly StockAlert[],
  date: string,
  status: ScanResult["status"],
  marketRegime: ScanResult["marketRegime"]
): DashboardSnapshot {
  const signalsByTicker = new Map<string, SignalType[]>();
  for (const alert of alerts) {
    const signals = signalsByTicker.get(alert.ticker) ?? [];
    if (!signals.includes(alert.type)) signals.push(alert.type);
    signalsByTicker.set(alert.ticker, signals);
  }

  return {
    scannedAt: new Date().toISOString(),
    sessionDate: date,
    status,
    marketRegime,
    marketProxies: {
      spy: getDailyPrice(data.SPY ?? []),
      qqq: getDailyPrice(data.QQQ ?? [])
    },
    tickers: tickers.map((ticker) =>
      createTickerSnapshot(ticker, data[ticker] ?? [], signalsByTicker.get(ticker) ?? [])
    )
  };
}

async function runScan(env: Env, phase?: "close" | "morning"): Promise<ScanResult> {
  const watchlist = await loadTickerList(env);
  const momentumState = parseMomentumState(await env.WTRACK_KV.get(MOMENTUM_STATE_KEY));
  const tradingEnabled = phase !== undefined && await paperTradingStatus(env);
  const managedValue = tradingEnabled ? await paperTradingRequest(env, "/symbols") : { symbols: [] };
  if (typeof managedValue !== "object" || managedValue === null ||
    !("symbols" in managedValue) || !Array.isArray(managedValue.symbols) ||
    !managedValue.symbols.every((symbol) => typeof symbol === "string" && TICKER_PATTERN.test(symbol))) {
    throw new Error("Invalid managed paper positions.");
  }
  const managed: string[] = managedValue.symbols;
  const today = currentNewYorkDate(new Date());
  const sessionDate = phase === "morning" ? await previousTradingSession(env, today) : today;
  const tickersToFetch = [...new Set(["SPY", "QQQ", ...watchlist, ...managed, ...momentumState.positions.map((position) => position.ticker)])];
  const history = await fetchDailyHistory(tickersToFetch, env,
    phase === "morning" ? new Date(`${today}T00:00:00Z`) : new Date(), fetch,
    momentumState.date || undefined);
  const data = Object.fromEntries(Object.entries(history).map(([ticker, bars]) => [
    ticker, bars.slice(-REQUIRED_DAILY_BARS)
  ]));
  const spyBars = data.SPY ?? [];
  if (spyBars.length < REQUIRED_DAILY_BARS) {
    throw new Error(`SPY must have at least ${REQUIRED_DAILY_BARS} daily bars.`);
  }

  const spyIndicators = calculateIndicators(spyBars);
  const marketRegime = {
    passes: marketRegimePasses(spyBars, spyIndicators),
    v2Passes: momentumRegimePasses({ ticker: "SPY", bars: spyBars, indicators: spyIndicators }),
    spy: getBenchmarkSummary(spyBars, spyIndicators)
  };
  const date = sessionDate ?? today;
  const latestSpyBar = spyBars[spyBars.length - 1];
  const skipped: ScanResult["skipped"] = [];

  if (sessionDate === null || !latestSpyBar?.timestamp.startsWith(date)) {
    const snapshot = createDashboardSnapshot(
      watchlist,
      data,
      [],
      date,
      "no-current-session",
      marketRegime
    );
    await env.WTRACK_KV.put(DASHBOARD_SNAPSHOT_KEY, JSON.stringify(snapshot));
    return {
      date,
      status: "no-current-session",
      marketRegime,
      alerts: [],
      notified: [],
      skipped: [{ ticker: "SPY", reason: "No daily bar is available for the current New York date." }]
    };
  }

  const alerts: StockAlert[] = [];

  for (const ticker of [...new Set([...watchlist, ...managed])]) {
    const bars = data[ticker] ?? [];
    if (bars.length < REQUIRED_DAILY_BARS || !bars.at(-1)?.timestamp.startsWith(date)) {
      if (managed.includes(ticker)) throw new Error(`Current-session data for managed paper position ${ticker} is unavailable.`);
      skipped.push({ ticker, reason: "Insufficient or stale daily bars." });
      continue;
    }
    const indicators = calculateIndicators(bars);
    for (const signal of evaluateExitSignals(bars, indicators)) {
      alerts.push(createAlert(ticker, signal, bars, indicators, date));
    }
    if (marketRegime.passes && watchlist.includes(ticker)) {
      const signal = evaluateBuySetup(bars, indicators);
      if (signal) alerts.push(createAlert(ticker, signal, bars, indicators, date));
    }
  }

  if (date < today || currentSessionIsComplete()) {
    const momentum = advanceMomentumSignals(momentumState, date, watchlist, history);
    alerts.push(...momentum.alerts.filter((alert) => alert.date === date));
    await env.WTRACK_KV.put(MOMENTUM_STATE_KEY, JSON.stringify(momentum));
  }

  const snapshot = createDashboardSnapshot(
    watchlist,
    data,
    alerts,
    date,
    "completed",
    marketRegime
  );
  await env.WTRACK_KV.put(DASHBOARD_SNAPSHOT_KEY, JSON.stringify(snapshot));
  if (tradingEnabled) {
    await paperTradingRequest(env, "/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date, phase, alerts: alerts.filter((alert) => alert.strategy !== "Setup D") })
    });
  }
  const notified = await sendNewAlerts(alerts, date, env);
  return { date, status: "completed", marketRegime, alerts, notified, skipped };
}

function scheduledPhase(date: Date): "close" | "morning" | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (hour === "16" && minute === "30") return "close";
  if (hour === "10" && minute === "15") return "morning";
  return null;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/admin/backtest/")) {
    const action = url.pathname.slice("/admin/backtest/".length);
    const method = action === "config" || action === "cache" ? "GET"
      : action === "run" || action === "refresh" || action === "save" ? "POST" : null;
    if (!method) return jsonResponse({ error: "Not found." }, 404);
    if (request.method !== method) return jsonResponse({ error: "Method not allowed." }, 405);
    if (method === "POST" && request.headers.get("origin") !== url.origin) {
      return jsonResponse({ error: "Invalid request origin." }, 403);
    }
    return env.BACKTEST.get(env.BACKTEST.idFromName("backtest")).fetch(request);
  }
  if (url.pathname === "/admin/orders") {
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed." }, 405);
    return jsonResponse(await paperTradingRequest(env, "/orders"));
  }
  if (url.pathname === "/admin/paper-trading") {
    if (request.method === "GET") return jsonResponse({ enabled: await paperTradingStatus(env) });
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
    if (request.headers.get("origin") !== url.origin) return jsonResponse({ error: "Invalid request origin." }, 403);
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || !("enabled" in value) ||
      typeof value.enabled !== "boolean") return jsonResponse({ error: "Invalid switch value." }, 400);
    const result = await paperTradingRequest(env, "/switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: value.enabled })
    });
    return jsonResponse(result);
  }
  if (url.pathname === "/admin/ping") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    return jsonResponse({ name: "wtrack", status: "ok" });
  }
  if (url.pathname === "/admin/scan") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    return jsonResponse(await runScan(env));
  }
  if (url.pathname === "/admin/watchlist") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    const { response } = await loadWatchlistAsset(env);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
  if (url.pathname === "/admin/dashboard") {
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed." }, 405);
    return handleDashboard(env);
  }
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    return env.ASSETS.fetch(new Request(new URL("/admin/", url), request));
  }
  if (url.pathname === "/") {
    return env.ASSETS.fetch(request);
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("Request failed:", error);
      return jsonResponse({ error: "The request could not be completed." }, 500);
    }
  },

  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    const phase = scheduledPhase(new Date(controller.scheduledTime));
    if (!phase) {
      console.info("Skipping cron outside the configured New York scan windows.", {
        cron: controller.cron
      });
      return;
    }
    context.waitUntil((async () => {
      let result: ScanResult;
      try {
        result = await runScan(env, phase);
      } catch (error) {
        try {
          await env.WTRACK_KV.put(SCHEDULED_RUN_KEY, JSON.stringify({
            completedAt: new Date().toISOString(),
            success: false
          }));
        } catch (recordError) {
          console.error("Failed to save scheduled scan failure record:", recordError);
        }
        console.error("Scheduled scan failed:", error);
        throw error;
      }

      const record = {
        completedAt: new Date().toISOString(),
        success: true,
        status: result.status,
        alerts: result.alerts.length,
        notified: result.notified.length
      };
      await env.WTRACK_KV.put(SCHEDULED_RUN_KEY, JSON.stringify(record));
      console.info("Scheduled scan completed:", {
        date: result.date,
        status: result.status,
        alerts: result.alerts.length,
        notified: result.notified.length,
        skipped: result.skipped.length
      });
    })());
  }
} satisfies ExportedHandler<Env>;
