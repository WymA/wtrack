import { describe, expect, it } from "vitest";
import { evaluateBuySetup, evaluateExitSignals, marketRegimePasses } from "../src/strategy";
import type { Bar, IndicatorSeries } from "../src/types";

function makeBars(count: number): Bar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: `2026-01-${String(index + 1).padStart(2, "0")}T05:00:00Z`,
    open: 104,
    high: 106,
    low: 105,
    close: 105,
    volume: 1_000
  }));
}

function makeIndicators(
  ema20: number[],
  ema50: number[],
  ema100: number[],
  ema200: number[]
): IndicatorSeries {
  return { ema20, ema50, ema100, ema200 };
}

describe("evaluateBuySetup", () => {
  it("detects the stacked pullback after a bullish trigger candle", () => {
    const bars = makeBars(8);
    bars[6]!.low = 102;
    bars[7]!.open = 105;
    bars[7]!.high = 108;
    bars[7]!.close = 107;
    const indicators = makeIndicators(
      [104, 104, 104, 104, 104, 104, 104, 105],
      [94, 95, 96, 97, 98, 99, 100, 101],
      Array(8).fill(90),
      [80, 81, 82, 83, 84, 85, 86, 87]
    );

    expect(evaluateBuySetup(bars, indicators)).toBe("Setup A");
    expect(evaluateBuySetup(bars, indicators, [])).toBeNull();
    expect(evaluateBuySetup(bars, indicators, ["Setup B"])).toBeNull();
  });

  it("detects a deep pullback reclaim with a recent 20/50 EMA cross", () => {
    const bars = makeBars(8);
    bars[4]!.low = 100;
    bars[4]!.close = 101;
    bars[7]!.close = 106;
    const indicators = makeIndicators(
      [98, 98, 98, 98, 99, 102, 103, 104],
      [100, 100, 100, 100, 100, 100, 101, 101],
      [101, 101, 101, 101, 101, 102, 103, 103],
      [88, 88.5, 89, 89.2, 89.5, 90, 90.5, 91]
    );

    expect(evaluateBuySetup(bars, indicators)).toBe("Setup B");
  });

  it("rejects a deep pullback that closes more than 3% below the 200 EMA", () => {
    const bars = makeBars(8);
    bars[4]!.low = 85;
    bars[4]!.close = 86;
    bars[7]!.close = 106;
    const indicators = makeIndicators(
      [98, 98, 98, 98, 99, 102, 103, 104],
      [100, 100, 100, 100, 100, 100, 101, 101],
      [101, 101, 101, 101, 101, 102, 103, 103],
      [88, 88.5, 89, 89.2, 89.5, 90, 90.5, 91]
    );

    expect(evaluateBuySetup(bars, indicators)).toBeNull();
  });
});

describe("evaluateExitSignals", () => {
  it("emits both exit tiers after two consecutive closes below their EMAs", () => {
    const bars = makeBars(2);
    bars[0]!.close = 80;
    bars[1]!.close = 79;
    const indicators = makeIndicators(
      [90, 89],
      [85, 84],
      [82, 81],
      [75, 76]
    );

    expect(evaluateExitSignals(bars, indicators)).toEqual(["Exit Tier 2", "Exit Tier 3"]);
  });
});

describe("marketRegimePasses", () => {
  it("requires SPY to close above both the 50 and 200 EMAs", () => {
    const bars = makeBars(1);
    const indicators = makeIndicators([90], [95], [80], [85]);
    expect(marketRegimePasses(bars, indicators)).toBe(true);

    bars[0]!.close = 94;
    expect(marketRegimePasses(bars, indicators)).toBe(false);
  });
});
