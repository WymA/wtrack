import type { EntrySetup } from "../../strategy-core/types.ts";
import type { MomentumStopType } from "../../strategy-core/types.ts";
import { strategyCatalog } from "../../strategy-core/strategy.ts";

export type StopConfig =
  | { type: "swing-low"; lookback: number }
  | { type: "fixed-percent"; value: number }
  | { type: "ema-buffer"; ema: EmaName; bufferPercent: number };

type EmaName = "ema20" | "ema50" | "ema100" | "ema200";

export interface BacktestConfig {
  strategy: {
    setups: EntrySetup[];
    watchlist: string[];
    momentumStop: MomentumStopType;
  };
  dateWindow: {
    start: string;
    end: string;
  };
  portfolio: {
    startingCapital: number;
    maxOpenPositions: number;
    sizing: {
      type: "risk-percent" | "fixed-dollar" | "equity-percent";
      value: number;
    };
  };
  stops: {
    initial: StopConfig;
    leftSideFailurePercent: number;
  };
  profitTaking: {
    type: "fixed-percent" | "risk-multiple";
    value: number;
    partialPercent: number;
  };
  trailingExitEma: "disabled" | "ema50" | "ema100";
  costs: {
    slippagePercent: number;
    commissionPerOrder: number;
  };
}

const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const SETUPS = new Set<string>(strategyCatalog.map((strategy) => strategy.id));
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmaName(value: unknown): value is EmaName {
  return value === "ema20" || value === "ema50" || value === "ema100" || value === "ema200";
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "today") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function newYorkDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Unable to determine the New York trading date.");
  return `${year}-${month}-${day}`;
}

export function validateConfig(value: unknown, now = new Date()): BacktestConfig {
  if (!isRecord(value)) {
    throw new TypeError("Backtest configuration is missing a required section.");
  }
  const strategy = value.strategy;
  const dateWindow = value.dateWindow;
  const portfolio = value.portfolio;
  const stops = value.stops;
  const profitTaking = value.profitTaking;
  const costs = value.costs;
  if (!isRecord(strategy) || !isRecord(dateWindow) || !isRecord(portfolio) ||
    !isRecord(portfolio.sizing) || !isRecord(stops) || !isRecord(stops.initial) ||
    !isRecord(profitTaking) || !isRecord(costs)) {
    throw new TypeError("Backtest configuration is missing a required section.");
  }
  const sizing = portfolio.sizing;
  const initial = stops.initial;
  const startDate = dateWindow.start;
  const configuredEndDate = dateWindow.end;
  const setups = Array.isArray(strategy.setups)
    ? strategy.setups.filter((setup): setup is EntrySetup =>
      typeof setup === "string" && SETUPS.has(setup))
    : [];
  if (!Array.isArray(strategy.setups) || setups.length !== strategy.setups.length ||
    new Set(setups).size !== setups.length) {
    throw new TypeError(`strategy.setups must contain unique registered strategies: ${[...SETUPS].join(", ")}.`);
  }
  const momentumStop = strategy.momentumStop ?? "fixed-percent";
  if (momentumStop !== "fixed-percent" && momentumStop !== "atr") {
    throw new TypeError("strategy.momentumStop must be fixed-percent (8%) or atr (2.5x ATR14).");
  }
  const watchlist = Array.isArray(strategy.watchlist)
    ? strategy.watchlist.filter((ticker): ticker is string =>
      typeof ticker === "string" && TICKER_PATTERN.test(ticker))
    : [];
  if (!Array.isArray(strategy.watchlist) || watchlist.length === 0 ||
    watchlist.length > 200 || watchlist.length !== strategy.watchlist.length ||
    new Set(watchlist).size !== watchlist.length) {
    throw new TypeError("strategy.watchlist must contain 1-200 unique uppercase ticker symbols.");
  }
  if (!validDate(startDate) || startDate === "today" || !validDate(configuredEndDate)) {
    throw new TypeError("dateWindow.start and dateWindow.end must be YYYY-MM-DD dates (end may be 'today').");
  }
  const endDate = configuredEndDate === "today" ? newYorkDate(now) : configuredEndDate;
  if (startDate > endDate || endDate > newYorkDate(now)) {
    throw new RangeError("The backtest date window must be ordered and cannot end in the future.");
  }
  const startingCapital = portfolio.startingCapital;
  const maxOpenPositions = portfolio.maxOpenPositions;
  if (!positiveNumber(startingCapital) || typeof maxOpenPositions !== "number" ||
    !Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 200) {
    throw new RangeError("Portfolio capital must be positive and maxOpenPositions must be between 1 and 200.");
  }
  const sizingType = sizing.type;
  const sizingValue = sizing.value;
  if ((sizingType !== "risk-percent" && sizingType !== "fixed-dollar" && sizingType !== "equity-percent") ||
    !positiveNumber(sizingValue) ||
    ((sizingType === "risk-percent" || sizingType === "equity-percent") && sizingValue > 100)) {
    throw new RangeError("Position sizing type or value is invalid.");
  }
  let initialConfig: StopConfig;
  if (initial.type === "swing-low") {
    const lookback = initial.lookback;
    if (typeof lookback !== "number" || !Number.isInteger(lookback) || lookback < 1 || lookback > 100) {
      throw new RangeError("The swing-low lookback must be between 1 and 100 bars.");
    }
    initialConfig = { type: "swing-low", lookback };
  } else if (initial.type === "fixed-percent") {
    const stopPercent = initial.value;
    if (!positiveNumber(stopPercent) || stopPercent >= 100) {
      throw new RangeError("The fixed-percentage stop must be greater than 0 and less than 100.");
    }
    initialConfig = { type: "fixed-percent", value: stopPercent };
  } else if (initial.type === "ema-buffer") {
    const ema = initial.ema;
    const bufferPercent = initial.bufferPercent;
    if (!isEmaName(ema) ||
      !nonnegativeNumber(bufferPercent) || bufferPercent >= 100) {
      throw new RangeError("The EMA-buffer stop configuration is invalid.");
    }
    initialConfig = {
      type: "ema-buffer",
      ema,
      bufferPercent
    };
  } else {
    throw new TypeError("stops.initial.type must be swing-low, fixed-percent, or ema-buffer.");
  }
  const leftSideFailurePercent = stops.leftSideFailurePercent;
  if (!nonnegativeNumber(leftSideFailurePercent) || leftSideFailurePercent >= 100) {
    throw new RangeError("The left-side failure stop must be between 0 and 100 percent.");
  }
  const profitType = profitTaking.type;
  const profitValue = profitTaking.value;
  const partialPercent = profitTaking.partialPercent;
  if ((profitType !== "fixed-percent" && profitType !== "risk-multiple") ||
    !positiveNumber(profitValue) ||
    (profitType === "fixed-percent" && profitValue >= 100) ||
    typeof partialPercent !== "number" || !Number.isFinite(partialPercent) ||
    partialPercent <= 0 || partialPercent > 100) {
    throw new RangeError("The profit-taking configuration is invalid.");
  }
  const trailingExitEma = value.trailingExitEma;
  if (trailingExitEma !== "disabled" && trailingExitEma !== "ema50" && trailingExitEma !== "ema100") {
    throw new TypeError("trailingExitEma must be disabled, ema50, or ema100.");
  }
  const slippagePercent = costs.slippagePercent;
  const commissionPerOrder = costs.commissionPerOrder;
  if (!nonnegativeNumber(slippagePercent) || slippagePercent >= 100 ||
    !nonnegativeNumber(commissionPerOrder)) {
    throw new RangeError("Slippage must be between 0 and 100 percent and commission cannot be negative.");
  }

  return {
    strategy: { setups, watchlist, momentumStop },
    dateWindow: { start: startDate, end: endDate },
    portfolio: {
      startingCapital,
      maxOpenPositions,
      sizing: { type: sizingType, value: sizingValue }
    },
    stops: {
      initial: initialConfig,
      leftSideFailurePercent
    },
    profitTaking: {
      type: profitType,
      value: profitValue,
      partialPercent
    },
    trailingExitEma,
    costs: { slippagePercent, commissionPerOrder }
  };
}

export function requiredWarmupStart(startDate: string): string {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 600);
  return date.toISOString().slice(0, 10);
}

export function currentSessionIsComplete(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).find((part) => part.type === "hour")?.value);
  return Number.isFinite(hour) && hour >= 16;
}
