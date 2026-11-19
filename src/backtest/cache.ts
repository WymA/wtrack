import type { Bar } from "../../strategy-core/types.ts";
import { requiredWarmupStart } from "./config";

type CacheStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

export function openCache(storage: CacheStorage): CacheStorage {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS daily_bars (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY (ticker, date)
    )
  `);
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS coverage (
      ticker TEXT PRIMARY KEY,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL
    )
  `);
  return storage;
}

export function getCachedBars(
  database: CacheStorage,
  ticker: string,
  startDate: string,
  endDate: string
): Bar[] {
  const rows = database.sql.exec<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>(`
    SELECT date, open, high, low, close, volume
    FROM daily_bars
    WHERE ticker = ? AND date >= ? AND date <= ?
    ORDER BY date
  `, ticker, startDate, endDate).toArray();
  return rows.map(({ date, ...bar }) => ({ timestamp: `${date}T00:00:00Z`, ...bar }));
}

export function getCacheSummary(database: CacheStorage): Array<{
  ticker: string;
  bars: number;
  from: string;
  through: string;
}> {
  return database.sql.exec<{ ticker: string; bars: number; from: string; through: string }>(`
    SELECT ticker, COUNT(*) AS bars, MIN(date) AS "from", MAX(date) AS through
    FROM daily_bars
    GROUP BY ticker
    ORDER BY ticker
  `).toArray();
}

export async function updateCachedBars(
  database: CacheStorage,
  tickers: readonly string[],
  startDate: string,
  endDate: string,
  fetchBars: (ticker: string, startDate: string, endDate: string) => Promise<Bar[]>,
  refresh = false
): Promise<Record<string, number>> {
  const insert = `
    INSERT INTO daily_bars (ticker, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ticker, date) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume
  `;
  const results: Record<string, number> = {};

  for (const ticker of tickers) {
    const coverage = database.sql.exec<{ start_date: string; end_date: string }>(`
      SELECT start_date, end_date FROM coverage WHERE ticker = ?
    `, ticker).toArray()[0];
    const warmupStart = requiredWarmupStart(startDate);
    const from = refresh || !coverage || coverage.start_date > warmupStart
      ? warmupStart
      : coverage.end_date <= endDate ? coverage.end_date : null;
    const through = !refresh && coverage && coverage.end_date > endDate ? coverage.end_date : endDate;

    if (from && from <= through) {
      const bars = await fetchBars(ticker, from, through);
      if (refresh && bars.length === 0) {
        throw new Error(`Refresh returned no historical bars for ${ticker}; existing cached data was retained.`);
      }
      database.transactionSync(() => {
        if (refresh) database.sql.exec("DELETE FROM daily_bars WHERE ticker = ?", ticker);
        for (const bar of bars) {
          database.sql.exec(
            insert,
            ticker,
            bar.timestamp.slice(0, 10),
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume
          );
        }
        database.sql.exec(`
          INSERT INTO coverage (ticker, start_date, end_date) VALUES (?, ?, ?)
          ON CONFLICT (ticker) DO UPDATE SET start_date = excluded.start_date, end_date = excluded.end_date
        `, ticker, refresh || !coverage ? from : [coverage.start_date, from].sort()[0]!, through);
      });
      results[ticker] = bars.length;
    } else {
      results[ticker] = 0;
    }
  }
  return results;
}
