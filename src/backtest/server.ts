import defaults from "../../backtest.config.json";
import { fetchHistoricalDailyBars } from "../data";
import type { Env } from "../types";
import { openCache, getCacheSummary, getCachedBars, updateCachedBars } from "./cache";
import { currentSessionIsComplete, newYorkDate, requiredWarmupStart, validateConfig } from "./config";
import type { BacktestConfig } from "./config";
import { runSimulation } from "./simulator";

const API_PREFIX = "/admin/backtest/";
const MAX_BODY_BYTES = 1_000_000;

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Request body must contain valid JSON.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("Request body exceeds the 1 MB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TypeError("Request body must contain valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export class Backtest {
  private readonly database;
  private busy = false;

  constructor(state: DurableObjectState, private readonly env: Env) {
    this.database = openCache(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(API_PREFIX.length);
    if (request.method === "GET" && action === "config") {
      return jsonResponse({ config: validateConfig(defaults), today: newYorkDate() });
    }
    if (request.method === "GET" && action === "cache") {
      return jsonResponse({ tickers: getCacheSummary(this.database) });
    }
    if (action !== "run" && action !== "refresh") {
      return jsonResponse({ error: "Not found." }, 404);
    }
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
    if (request.headers.get("origin") !== url.origin) {
      return jsonResponse({ error: "Invalid request origin." }, 403);
    }
    if (this.busy) return jsonResponse({ error: "A backtest or cache refresh is already running. Try again shortly." }, 409);

    this.busy = true;
    try {
      const body = await requestJson(request);
      const config = validateConfig(body.config === undefined ? defaults : body.config);
      const tickers = [...new Set(["SPY", "VOO", ...config.strategy.watchlist])];
      const downloaded = await updateCachedBars(
        this.database,
        tickers,
        config.dateWindow.start,
        config.dateWindow.end,
        async (ticker, start, end) => {
          const bars = await fetchHistoricalDailyBars(
            [ticker], this.env, `${start}T00:00:00Z`, `${end}T23:59:59Z`
          );
          return bars[ticker] ?? [];
        },
        action === "refresh"
      );
      if (action === "refresh") {
        return jsonResponse({ refreshed: downloaded, cache: getCacheSummary(this.database) });
      }
      return jsonResponse({
        result: runSimulation(config, this.simulationData(config, tickers)),
        downloaded,
        cache: getCacheSummary(this.database)
      });
    } catch (error) {
      return jsonResponse({
        error: error instanceof Error ? error.message : "The backtest could not be completed."
      }, error instanceof TypeError || error instanceof RangeError ? 400 : 502);
    } finally {
      this.busy = false;
    }
  }

  private simulationData(config: BacktestConfig, tickers: string[]) {
    const warmupStart = requiredWarmupStart(config.dateWindow.start);
    const data: Record<string, ReturnType<typeof getCachedBars>> = {};
    for (const ticker of tickers) {
      const bars = getCachedBars(this.database, ticker, warmupStart, config.dateWindow.end);
      const warmupCount = bars.filter((bar) => bar.timestamp.slice(0, 10) < config.dateWindow.start).length;
      const requiresWarmup = ticker === "SPY" || config.strategy.watchlist.includes(ticker);
      if (requiresWarmup && warmupCount < 300) {
        throw new Error(
          `${ticker} has only ${warmupCount} daily bars before ${config.dateWindow.start}; ` +
          "at least 300 are required for reliable 200 EMA warm-up. Choose a later start date or another ticker."
        );
      }
      data[ticker] = config.dateWindow.end === newYorkDate() && !currentSessionIsComplete()
        ? bars.filter((bar) => bar.timestamp.slice(0, 10) < config.dateWindow.end)
        : bars;
    }
    return data;
  }
}
