import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Bar } from "../strategy-core/types.ts";

const DATABASE_DIRECTORY = resolve(process.cwd(), "backtest-data");
const DATABASE_PATH = resolve(DATABASE_DIRECTORY, "market.sqlite");

export function openCache(): DatabaseSync {
  mkdirSync(DATABASE_DIRECTORY, { recursive: true });
  const database = new DatabaseSync(DATABASE_PATH);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS daily_bars (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX IF NOT EXISTS daily_bars_date ON daily_bars (date, ticker);
  `);
  return database;
}

function subtractCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export function getCachedBars(
  database: DatabaseSync,
  ticker: string,
  startDate: string,
  endDate: string
): Bar[] {
  const rows = database.prepare(`
    SELECT date, open, high, low, close, volume
    FROM daily_bars
    WHERE ticker = ? AND date >= ? AND date <= ?
    ORDER BY date
  `).all(ticker, startDate, endDate) as Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  return rows.map(({ date, ...bar }) => ({ timestamp: `${date}T00:00:00Z`, ...bar }));
}

export function getCacheSummary(database: DatabaseSync): Array<{
  ticker: string;
  bars: number;
  from: string;
  through: string;
}> {
  return database.prepare(`
    SELECT ticker, COUNT(*) AS bars, MIN(date) AS "from", MAX(date) AS through
    FROM daily_bars
    GROUP BY ticker
    ORDER BY ticker
  `).all() as Array<{ ticker: string; bars: number; from: string; through: string }>;
}

export async function updateCachedBars(
  database: DatabaseSync,
  tickers: readonly string[],
  startDate: string,
  endDate: string,
  fetchBars: (ticker: string, startDate: string, endDate: string) => Promise<Bar[]>,
  refresh = false
): Promise<Record<string, number>> {
  const deleteTicker = database.prepare("DELETE FROM daily_bars WHERE ticker = ?");
  const insert = database.prepare(`
    INSERT INTO daily_bars (ticker, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ticker, date) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume
  `);
  const results: Record<string, number> = {};

  for (const ticker of tickers) {
    const coverage = database.prepare(`
      SELECT MIN(date) AS firstDate, MAX(date) AS lastDate
      FROM daily_bars WHERE ticker = ?
    `).get(ticker) as { firstDate: string | null; lastDate: string | null };
    const warmupStart = subtractCalendarDays(startDate, 600);
    const from = refresh || !coverage.firstDate || coverage.firstDate > warmupStart
      ? warmupStart
      : coverage.lastDate && coverage.lastDate <= endDate ? coverage.lastDate : null;

    if (from && from <= endDate) {
      const bars = await fetchBars(ticker, from, endDate);
      if (refresh && bars.length === 0) {
        throw new Error(`Refresh returned no historical bars for ${ticker}; existing cached data was retained.`);
      }
      database.exec("BEGIN");
      try {
        if (refresh) deleteTicker.run(ticker);
        for (const bar of bars) {
          insert.run(
            ticker,
            bar.timestamp.slice(0, 10),
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      results[ticker] = bars.length;
    } else {
      results[ticker] = 0;
    }
  }
  return results;
}
