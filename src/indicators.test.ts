import { describe, expect, it } from "vitest";
import { calculateEma } from "./indicators";

describe("calculateEma", () => {
  it("uses standard exponential smoothing", () => {
    const result = calculateEma([10, 13, 16], 2);
    expect(result[0]).toBe(10);
    expect(result[1]).toBe(12);
    expect(result[2]).toBeCloseTo(14.6666666667);
  });

  it("returns no values for empty input and rejects invalid periods", () => {
    expect(calculateEma([], 20)).toEqual([]);
    expect(() => calculateEma([1], 0)).toThrow(RangeError);
  });
});
