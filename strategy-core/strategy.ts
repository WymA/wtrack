import { strategyA } from "./setups/a.ts";
import { strategyB } from "./setups/b.ts";
import { strategyC } from "./setups/c.ts";
import { strategyD } from "./setups/d.ts";
import type {
  Bar, EntrySetup, IndicatorSeries, MarketInstrument, RightSideSetup, StrategyDefinition,
  StrategyEntryCandidate, StrategyEntryContext, StrategyExitContext, StrategyExitEvaluation, StrategyUniverseState
} from "./types.ts";

export { evaluateExitSignals } from "./exits.ts";
export { marketRegimePasses } from "./market.ts";
export { recentSwingLow } from "./shared.ts";
export { evaluateSupportTouch, supportFailure } from "./setups/c.ts";
export { evaluateMomentumExit, momentumHardStop, momentumRegimePasses, rankMomentumUniverse } from "./setups/d.ts";

export const REQUIRED_DAILY_BARS = 300;
export const strategies = [strategyA, strategyB, strategyC, strategyD] as const satisfies readonly StrategyDefinition[];
export const strategyCatalog = strategies.map(({ id, code, name, timing, entry, exit, position }) => ({
  id, code, name, timing,
  description: entry.description,
  exitDescription: exit.description,
  positionDescription: position.description
}));
const RIGHT_SIDE_SETUPS = strategies.flatMap((strategy) => strategy.timing === "close" ? [strategy.id] : []);

export function getStrategy(setup: string): StrategyDefinition {
  const strategy = strategies.find((strategy) => strategy.id === setup);
  if (!strategy) throw new RangeError(`Unknown strategy: ${setup}.`);
  return strategy;
}

export function evaluateEntries(
  context: StrategyEntryContext,
  active: readonly EntrySetup[]
): Array<StrategyEntryCandidate & { setup: EntrySetup }> {
  return strategies.flatMap((strategy) =>
    strategy.timing === context.timing && active.includes(strategy.id) &&
    (!context.benchmark || strategy.entry.regimePasses(context.benchmark))
      ? strategy.entry.evaluate(context).map((candidate) => ({ ...candidate, setup: strategy.id }))
      : []
  );
}

export function prepareStrategyUniverse(
  universe: readonly MarketInstrument[],
  active: readonly EntrySetup[]
): Map<EntrySetup, StrategyUniverseState> {
  return new Map([...new Set(active)].map((setup) => [setup, getStrategy(setup).exit.prepare(universe)]));
}

export function evaluateStrategyExit(setup: EntrySetup, context: StrategyExitContext): StrategyExitEvaluation {
  return getStrategy(setup).exit.evaluate(context);
}

export function evaluateBuySetup(
  bars: readonly Bar[],
  indicators: IndicatorSeries,
  active: readonly RightSideSetup[] = RIGHT_SIDE_SETUPS,
  benchmark?: MarketInstrument
): RightSideSetup | null {
  const candidate = evaluateEntries({
    timing: "close", instrument: { ticker: "", bars, indicators }, benchmark
  }, active)[0];
  return candidate && isRightSideSetup(candidate.setup) ? candidate.setup : null;
}

export function evaluateIntradaySetups(
  priorBars: readonly Bar[],
  indicators: IndicatorSeries,
  session: Pick<Bar, "open" | "low">,
  active: readonly EntrySetup[],
  benchmark?: MarketInstrument
): Array<{ setup: EntrySetup; support?: number; price: number }> {
  return evaluateEntries({
    timing: "intraday", instrument: { ticker: "", bars: priorBars, indicators }, session, benchmark
  }, active).flatMap((candidate) => candidate.price === undefined ? [] : [{
    setup: candidate.setup, support: candidate.support, price: candidate.price
  }]);
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
  voo: MarketInstrument,
  active: readonly EntrySetup[]
) {
  return evaluateEntries({ timing: "ranked-close", universe, benchmark: voo }, active);
}
