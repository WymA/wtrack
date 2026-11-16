import { fetchDailyBars, REQUIRED_DAILY_BARS } from "./data";
import { calculateIndicators } from "./indicators";
import { sendNewAlerts } from "./notifications";
import { evaluateBuySetup, evaluateExitSignals, marketRegimePasses } from "./strategy";
import type { Bar, Env, IndicatorSeries, SignalType, StockAlert } from "./types";

const MAX_TRACKED_TICKERS = 200;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

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
    spy: BenchmarkSummary;
    qqq: BenchmarkSummary;
  };
  alerts: StockAlert[];
  notified: StockAlert[];
  skipped: Array<{ ticker: string; reason: string }>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function authorize(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return jsonResponse({ error: "ADMIN_TOKEN is not configured." }, 503);
  }
  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return jsonResponse(
      { error: "A valid bearer token is required." },
      401
    );
  }
  return null;
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

async function loadTickerList(env: Env, key: "watchlist" | "holdings"): Promise<string[]> {
  const value = await env.STOCK_TRACKER_KV.get(key);
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  return normalizeTickerList(parsed);
}

async function saveTickerList(
  request: Request,
  env: Env,
  key: "watchlist" | "holdings"
): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) return jsonResponse({ error: "Request body is too large." }, 413);
  const body = await request.text();
  if (body.length > 16_384) return jsonResponse({ error: "Request body is too large." }, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  if (
    typeof payload !== "object" || payload === null ||
    !("tickers" in payload)
  ) {
    return jsonResponse({ error: 'Request body must have a "tickers" array.' }, 400);
  }

  let tickers: string[];
  try {
    tickers = normalizeTickerList(payload.tickers);
  } catch (error) {
    if (error instanceof TypeError) {
      return jsonResponse({ error: error.message }, 400);
    }
    throw error;
  }
  const otherKey = key === "watchlist" ? "holdings" : "watchlist";
  const otherTickers = await loadTickerList(env, otherKey);
  if (new Set([...tickers, ...otherTickers]).size > MAX_TRACKED_TICKERS) {
    return jsonResponse({
      error: `The combined watchlist and holdings cannot exceed ${MAX_TRACKED_TICKERS} unique tickers.`
    }, 400);
  }
  await env.STOCK_TRACKER_KV.put(key, JSON.stringify(tickers));
  return jsonResponse({ [key]: tickers });
}

async function handleTickerList(
  request: Request,
  env: Env,
  key: "watchlist" | "holdings"
): Promise<Response> {
  const unauthorized = authorize(request, env);
  if (unauthorized) return unauthorized;

  if (request.method === "GET") {
    return jsonResponse({ [key]: await loadTickerList(env, key) });
  }
  if (request.method === "POST") {
    return saveTickerList(request, env, key);
  }
  return jsonResponse(
    { error: "Method not allowed." },
    405
  );
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
  const recentBars = bars.slice(-5);
  if (recentBars.length === 0) throw new Error(`Price data for ${ticker} is empty.`);

  return {
    ticker,
    type,
    date,
    close: latest.close,
    stopLoss: Math.min(...recentBars.map((bar) => bar.low)),
    ema20,
    ema50,
    ema100,
    ema200
  };
}

async function runScan(env: Env): Promise<ScanResult> {
  const [watchlist, holdings] = await Promise.all([
    loadTickerList(env, "watchlist"),
    loadTickerList(env, "holdings")
  ]);
  const tickerSet = new Set([...watchlist, ...holdings]);
  if (tickerSet.size > MAX_TRACKED_TICKERS) {
    throw new Error(`The combined watchlist and holdings cannot exceed ${MAX_TRACKED_TICKERS} tickers.`);
  }

  const tickers = [...new Set(["SPY", "QQQ", ...tickerSet])];
  const data = await fetchDailyBars(tickers, env);
  const spyBars = data.SPY ?? [];
  const qqqBars = data.QQQ ?? [];
  if (spyBars.length < REQUIRED_DAILY_BARS || qqqBars.length < REQUIRED_DAILY_BARS) {
    throw new Error(`SPY and QQQ must each have at least ${REQUIRED_DAILY_BARS} daily bars.`);
  }

  const spyIndicators = calculateIndicators(spyBars);
  const qqqIndicators = calculateIndicators(qqqBars);
  const marketRegime = {
    passes: marketRegimePasses(spyBars, spyIndicators),
    spy: getBenchmarkSummary(spyBars, spyIndicators),
    qqq: getBenchmarkSummary(qqqBars, qqqIndicators)
  };
  const date = currentNewYorkDate(new Date());
  const latestSpyBar = spyBars[spyBars.length - 1];
  const skipped: ScanResult["skipped"] = [];

  if (!latestSpyBar?.timestamp.startsWith(date)) {
    return {
      date,
      status: "no-current-session",
      marketRegime,
      alerts: [],
      notified: [],
      skipped: [{ ticker: "SPY", reason: "No daily bar is available for the current New York date." }]
    };
  }

  const heldTickers = new Set(holdings);
  const alerts: StockAlert[] = [];

  for (const ticker of holdings) {
    const bars = data[ticker] ?? [];
    if (bars.length < REQUIRED_DAILY_BARS) {
      skipped.push({ ticker, reason: `Fewer than ${REQUIRED_DAILY_BARS} daily bars are available.` });
      continue;
    }
    const indicators = calculateIndicators(bars);
    for (const signal of evaluateExitSignals(bars, indicators)) {
      alerts.push(createAlert(ticker, signal, bars, indicators, date));
    }
  }

  if (marketRegime.passes) {
    for (const ticker of watchlist) {
      if (heldTickers.has(ticker)) continue;
      const bars = data[ticker] ?? [];
      if (bars.length < REQUIRED_DAILY_BARS) {
        skipped.push({ ticker, reason: `Fewer than ${REQUIRED_DAILY_BARS} daily bars are available.` });
        continue;
      }
      const indicators = calculateIndicators(bars);
      const signal = evaluateBuySetup(bars, indicators);
      if (signal) alerts.push(createAlert(ticker, signal, bars, indicators, date));
    }
  }

  const notified = await sendNewAlerts(alerts, date, env);
  return { date, status: "completed", marketRegime, alerts, notified, skipped };
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") {
    return jsonResponse({ name: "wtrack", status: "ok" });
  }
  if (url.pathname === "/scan") {
    const unauthorized = authorize(request, env);
    if (unauthorized) return unauthorized;
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    return jsonResponse(await runScan(env));
  }
  if (url.pathname === "/holdings") return handleTickerList(request, env, "holdings");
  if (url.pathname === "/watchlist") return handleTickerList(request, env, "watchlist");
  return jsonResponse({ error: "Not Found." }, 404);
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

  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(
      runScan(env)
        .then((result) => {
          console.info("Scheduled scan completed:", {
            date: result.date,
            status: result.status,
            alerts: result.alerts.length,
            notified: result.notified.length,
            skipped: result.skipped.length
          });
        })
        .catch((error: unknown) => {
          console.error("Scheduled scan failed:", error);
          throw error;
        })
    );
  }
} satisfies ExportedHandler<Env>;
