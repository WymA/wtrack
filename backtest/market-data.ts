import type { Bar } from "../strategy-core/types.ts";

const BARS_URL = "https://data.alpaca.markets/v2/stocks/bars";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBar(value: unknown, ticker: string): Bar {
  if (!isRecord(value) || typeof value.t !== "string" ||
    typeof value.o !== "number" || !Number.isFinite(value.o) ||
    typeof value.h !== "number" || !Number.isFinite(value.h) ||
    typeof value.l !== "number" || !Number.isFinite(value.l) ||
    typeof value.c !== "number" || !Number.isFinite(value.c) ||
    typeof value.v !== "number" || !Number.isFinite(value.v)) {
    throw new Error(`Alpaca returned an invalid daily bar for ${ticker}.`);
  }
  return {
    timestamp: value.t,
    open: value.o,
    high: value.h,
    low: value.l,
    close: value.c,
    volume: value.v
  };
}

async function requestPage(url: URL): Promise<unknown> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret || key === "replace-me" || secret === "replace-me") {
    throw new Error("Set ALPACA_API_KEY and ALPACA_API_SECRET_KEY in .dev.vars or the environment.");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
      },
      signal: AbortSignal.timeout(15_000)
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5_000)
        : 500 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    if (!response.ok) throw new Error(`Alpaca market-data request failed with status ${response.status}.`);
    return response.json();
  }
  throw new Error("Alpaca market-data request failed after retries.");
}

export async function fetchDailyBars(ticker: string, startDate: string, endDate: string): Promise<Bar[]> {
  const bars: Bar[] = [];
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();

  do {
    const url = new URL(BARS_URL);
    url.search = new URLSearchParams({
      symbols: ticker,
      timeframe: "1Day",
      start: `${startDate}T00:00:00Z`,
      end: `${endDate}T23:59:59Z`,
      limit: "10000",
      adjustment: "split",
      feed: "iex",
      sort: "asc",
      ...(pageToken ? { page_token: pageToken } : {})
    }).toString();
    const value = await requestPage(url);
    if (!isRecord(value) || !isRecord(value.bars) || !Array.isArray(value.bars[ticker])) {
      throw new Error(`Alpaca returned an invalid daily-bars response for ${ticker}.`);
    }
    bars.push(...value.bars[ticker].map((bar) => parseBar(bar, ticker)));
    const next = value.next_page_token;
    if (next !== null && next !== undefined && typeof next !== "string") {
      throw new Error(`Alpaca returned an invalid pagination token for ${ticker}.`);
    }
    pageToken = typeof next === "string" && next.length > 0 ? next : null;
    if (pageToken && seenTokens.has(pageToken)) {
      throw new Error(`Alpaca repeated a pagination token for ${ticker}.`);
    }
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);

  return bars.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
