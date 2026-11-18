import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openCache, getCacheSummary, getCachedBars, updateCachedBars } from "./cache.ts";
import { currentSessionIsComplete, newYorkDate, requiredWarmupStart, validateConfig } from "./config.ts";
import type { BacktestConfig } from "./config.ts";
import { fetchDailyBars } from "./market-data.ts";
import { runSimulation } from "./simulator.ts";

const ROOT = process.cwd();
const CONFIG_PATH = resolve(ROOT, "backtest.config.json");
const DATABASE = openCache();
const HTML = await readFile(resolve(ROOT, "backtest", "ui.html"), "utf8");
const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const MAX_BODY_BYTES = 1_000_000;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  sendJson(response, status, { error: message });
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new RangeError("Request body exceeds the 1 MB limit.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TypeError("Request body must contain valid JSON.");
  }
}

async function loadConfigFile(): Promise<BacktestConfig> {
  const contents = await readFile(CONFIG_PATH, "utf8");
  const value: unknown = JSON.parse(contents);
  return validateConfig(value);
}

function validateLocalOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.port === String(port);
  } catch {
    return false;
  }
}

function parseTickers(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length < 1 || value.length > 200 ||
    !value.every((ticker) => typeof ticker === "string" && TICKER_PATTERN.test(ticker))) {
    throw new TypeError("tickers must be an array of 1-200 uppercase ticker symbols.");
  }
  return [...new Set(value)];
}

async function cacheTickers(
  config: BacktestConfig,
  tickers: readonly string[],
  refresh: boolean
): Promise<Record<string, number>> {
  return updateCachedBars(
    DATABASE,
    tickers,
    config.dateWindow.start,
    config.dateWindow.end,
    fetchDailyBars,
    refresh
  );
}

async function runBacktest(config: BacktestConfig): Promise<unknown> {
  const tickers = [...new Set(["SPY", ...config.strategy.watchlist])];
  const downloaded = await cacheTickers(config, tickers, false);
  const warmupStart = requiredWarmupStart(config.dateWindow.start);
  const dayBeforeStart = new Date(`${config.dateWindow.start}T00:00:00.000Z`);
  dayBeforeStart.setUTCDate(dayBeforeStart.getUTCDate() - 1);
  const priorEnd = dayBeforeStart.toISOString().slice(0, 10);
  const data: Record<string, ReturnType<typeof getCachedBars>> = {};

  for (const ticker of tickers) {
    const warmup = getCachedBars(DATABASE, ticker, warmupStart, priorEnd);
    if (warmup.length < 300) {
      throw new Error(
        `${ticker} has only ${warmup.length} cached daily bars before ${config.dateWindow.start}; ` +
        "at least 300 are required for reliable 200 EMA warm-up. Try an earlier start date or another ticker."
      );
    }
    const bars = getCachedBars(DATABASE, ticker, warmupStart, config.dateWindow.end);
    data[ticker] = config.dateWindow.end === newYorkDate() && !currentSessionIsComplete()
      ? bars.filter((bar) => bar.timestamp.slice(0, 10) < config.dateWindow.end)
      : bars;
  }

  return {
    result: runSimulation(config, data),
    downloaded,
    cache: getCacheSummary(DATABASE)
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self';"
    });
    response.end(HTML);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, { config: await loadConfigFile(), today: newYorkDate() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/cache") {
    sendJson(response, 200, { tickers: getCacheSummary(DATABASE) });
    return;
  }
  if (request.method !== "POST" || !["/api/run", "/api/refresh"].includes(url.pathname)) {
    sendError(response, 404, new Error("Not found."));
    return;
  }
  if (!validateLocalOrigin(request)) {
    sendError(response, 403, new Error("Request origin must be this local backtest application."));
    return;
  }
  const body = await requestJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  const value = body as Record<string, unknown>;
  const config = value.config === undefined
    ? await loadConfigFile()
    : validateConfig(value.config);
  if (url.pathname === "/api/run") {
    sendJson(response, 200, await runBacktest(config));
    return;
  }
  const tickers = parseTickers(value.tickers, [...new Set(["SPY", ...config.strategy.watchlist])]);
  const refreshed = await cacheTickers(config, tickers, true);
  sendJson(response, 200, { refreshed, cache: getCacheSummary(DATABASE) });
}

const portValue = Number(process.env.BACKTEST_PORT ?? "8788");
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
  throw new RangeError("BACKTEST_PORT must be an integer between 1 and 65535.");
}
const port = portValue;

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    console.error("Local backtest request failed:", error);
    sendError(response, error instanceof TypeError || error instanceof RangeError ? 400 : 500, error);
  });
});
server.listen(port, "127.0.0.1", () => {
  console.info(`WTrack local backtester: http://127.0.0.1:${port}`);
  console.info("Backtest cache and SQLite data remain in the ignored backtest-data/ directory.");
});
