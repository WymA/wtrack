import { strategyA } from "./setups/a.ts";
import { strategyB } from "./setups/b.ts";
import { strategyC } from "./setups/c.ts";
import { strategyD } from "./setups/d.ts";
import type { Bar, EntrySetup, IndicatorSeries, MarketInstrument, RightSideSetup, StrategyDefinition } from "./types.ts";

export { evaluateExitSignals } from "./exits.ts";
export { evaluateSupportTouch, supportFailure } from "./setups/c.ts";
export { evaluateMomentumExit, momentumHardStop, momentumRegimePasses, rankMomentumUniverse } from "./setups/d.ts";

export const REQUIRED_DAILY_BARS = 300;
export const strategies = [strategyA, strategyB, strategyC, strategyD] as const satisfies readonly StrategyDefinition[];
export const strategyCatalog = strategies.map(({ id, code, name, timing, description }) => ({
  id, code, name, timing, description
}));
const RIGHT_SIDE_SETUPS = strategies.flatMap((strategy) => strategy.timing === "close" ? [strategy.id] : []);

export function marketRegimePasses(spyBars: readonly Bar[], spy: IndicatorSeries): boolean {
  const index = spyBars.length - 1;
  const latest = spyBars[index];
  const ema50 = spy.ema50[index];
  const ema200 = spy.ema200[index];
  return latest !== undefined && ema50 !== undefined && ema200 !== undefined &&
    latest.close > ema50 && latest.close > ema200;
}

export function evaluateBuySetup(
  bars: readonly Bar[],
  indicators: IndicatorSeries,
  active: readonly RightSideSetup[] = RIGHT_SIDE_SETUPS
): RightSideSetup | null {
  for (const strategy of strategies) {
    if (strategy.timing === "close" && active.includes(strategy.id) && strategy.evaluate(bars, indicators)) {
      return strategy.id;
    }
  }
  return null;
}

export function evaluateIntradaySetups(
  priorBars: readonly Bar[],
  indicators: IndicatorSeries,
  session: Pick<Bar, "open" | "low">,
  active: readonly EntrySetup[]
): Array<{ setup: EntrySetup; support: number; price: number }> {
  const entries: Array<{ setup: EntrySetup; support: number; price: number }> = [];
  for (const strategy of strategies) {
    if (strategy.timing !== "intraday" || !active.includes(strategy.id)) continue;
    const entry = strategy.evaluate(priorBars, indicators, session);
    if (entry) entries.push({ setup: strategy.id, ...entry });
  }
  return entries;
}

export function isRightSideSetup(setup: EntrySetup): setup is RightSideSetup {
  return strategies.some((strategy) => strategy.id === setup && strategy.timing === "close");
}

export function isIntradaySetup(setup: EntrySetup): boolean {
  return strategies.some((strategy) => strategy.id === setup && strategy.timing === "intraday");
}

export function isRankedSetup(setup: EntrySetup): boolean {
  return strategies.some((strategy) => strategy.id === setup && strategy.timing === "ranked-close");
}

export function evaluateRankedSetups(
  universe: readonly MarketInstrument[],
  spy: MarketInstrument,
  active: readonly EntrySetup[]
) {
  return strategies.flatMap((strategy) =>
    strategy.timing === "ranked-close" && active.includes(strategy.id)
      ? strategy.evaluate(universe, spy).map((candidate) => ({ ...candidate, setup: strategy.id }))
      : []
  );
}

export function recentSwingLow(bars: readonly Bar[], lookback = 5): number {
  if (!bars.length) throw new Error("Cannot calculate a swing low without price bars.");
  return Math.min(...bars.slice(-lookback).map(({ low }) => low));
}
