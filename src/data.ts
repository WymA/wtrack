import type { Bar, Env } from "./types";
import { REQUIRED_DAILY_BARS } from "./strategy";

export { REQUIRED_DAILY_BARS };

const ALPACA_BARS_URL = "https://data.alpaca.markets/v2/stocks/bars";
const BATCH_SIZE = 20;
const HISTORY_DAYS = 600;
const MAX_PAGES_PER_BATCH = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBar(value: unknown, ticker: string): Bar {
  if (!isRecord(value)) throw new Error(`Market data for ${ticker} contained an invalid bar.`);
  const { t, o, h, l, c, v } = value;
  if (
    typeof t !== "string" ||
    typeof o !== "number" || !Number.isFinite(o) ||
    typeof h !== "number" || !Number.isFinite(h) ||
    typeof l !== "number" || !Number.isFinite(l) ||
    typeof c !== "number" || !Number.isFinite(c) ||
    typeof v !== "number" || !Number.isFinite(v)
  ) {
    throw new Error(`Market data for ${ticker} contained an invalid bar.`);
  }
  return {
    timestamp: t,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v
  };
}

function splitIntoBatches<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

async function requestPage(
  url: URL,
  env: Pick<Env, "ALPACA_API_KEY" | "ALPACA_API_SECRET_KEY">,
  fetcher: typeof fetch
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(url, {
      headers: {
        "APCA-API-KEY-ID": env.ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY
      },
      signal: AbortSignal.timeout(15_000)
    });

    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5_000)
        : 500 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Alpaca market data request failed with status ${response.status}.`);
    }
    return response.json();
  }

  throw new Error("Alpaca market data request failed after retries.");
}

export async function fetchDailyBars(
  tickers: readonly string[],
  env: Pick<Env, "ALPACA_API_KEY" | "ALPACA_API_SECRET_KEY">,
  now = new Date(),
  fetcher: typeof fetch = fetch
): Promise<Record<string, Bar[]>> {
  const result = await fetchDailyHistory(tickers, env, now, fetcher);
  return Object.fromEntries(Object.entries(result).map(([ticker, bars]) => [
    ticker, bars.slice(-REQUIRED_DAILY_BARS)
  ]));
}

export async function fetchDailyHistory(
  tickers: readonly string[],
  env: Pick<Env, "ALPACA_API_KEY" | "ALPACA_API_SECRET_KEY">,
  now = new Date(),
  fetcher: typeof fetch = fetch,
  replayAfter?: string
): Promise<Record<string, Bar[]>> {
  const anchor = replayAfter ? Math.min(now.getTime(), Date.parse(`${replayAfter}T00:00:00Z`)) : now.getTime();
  const start = new Date(anchor - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return fetchHistoricalDailyBars(tickers, env, start, now.toISOString(), fetcher);
}

export async function fetchHistoricalDailyBars(
  tickers: readonly string[],
  env: Pick<Env, "ALPACA_API_KEY" | "ALPACA_API_SECRET_KEY">,
  start: string,
  end: string,
  fetcher: typeof fetch = fetch
): Promise<Record<string, Bar[]>> {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET_KEY) {
    throw new Error("ALPACA_API_KEY and ALPACA_API_SECRET_KEY must be configured.");
  }

  const result: Record<string, Bar[]> = Object.fromEntries(
    tickers.map((ticker) => [ticker, []])
  );

  for (const batch of splitIntoBatches([...new Set(tickers)], BATCH_SIZE)) {
    let pageToken: string | null = null;
    const seenTokens = new Set<string>();
    let pageCount = 0;

    do {
      const url = new URL(ALPACA_BARS_URL);
      url.search = new URLSearchParams({
        symbols: batch.join(","),
        timeframe: "1Day",
        start,
        end,
        limit: "10000",
        adjustment: "split",
        feed: "iex",
        sort: "asc",
        ...(pageToken ? { page_token: pageToken } : {})
      }).toString();

      const payload = await requestPage(url, env, fetcher);
      if (!isRecord(payload) || !isRecord(payload.bars)) {
        throw new Error("Alpaca returned an invalid market data response.");
      }

      for (const ticker of batch) {
        const bars = payload.bars[ticker];
        if (bars === undefined) continue;
        if (!Array.isArray(bars)) {
          throw new Error(`Alpaca returned invalid bars for ${ticker}.`);
        }
        const tickerBars = result[ticker];
        if (tickerBars === undefined) {
          throw new Error(`Unexpected market data symbol ${ticker}.`);
        }
        tickerBars.push(...bars.map((bar) => parseBar(bar, ticker)));
      }

      const nextToken = payload.next_page_token;
      if (nextToken !== null && nextToken !== undefined && typeof nextToken !== "string") {
        throw new Error("Alpaca returned an invalid pagination token.");
      }
      pageToken = typeof nextToken === "string" && nextToken.length > 0 ? nextToken : null;
      pageCount += 1;
      if (pageToken && seenTokens.has(pageToken)) {
        throw new Error("Alpaca returned a repeated pagination token.");
      }
      if (pageToken) seenTokens.add(pageToken);
      if (pageToken && pageCount >= MAX_PAGES_PER_BATCH) {
        throw new Error("Alpaca market data exceeded the pagination limit.");
      }
    } while (pageToken);
  }

  for (const bars of Object.values(result)) bars.sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  return result;
}

