import { describe, expect, it } from "vitest";
import { fetchDailyBars, fetchDailyHistory } from "../src/data";

const credentials = {
  ALPACA_API_KEY: "test-key",
  ALPACA_API_SECRET_KEY: "test-secret"
};

function makeBar(index: number) {
  return {
    t: new Date(Date.UTC(2025, 0, 1) + index * 24 * 60 * 60 * 1000).toISOString(),
    o: 10,
    h: 12,
    l: 9,
    c: 11,
    v: 1_000
  };
}

describe("fetchDailyBars", () => {
  it("retains warm-up before a missed-session replay instead of truncating it to 300 bars", async () => {
    const calls: URL[] = [];
    const bars = Array.from({ length: 350 }, (_, index) => makeBar(index));
    const result = await fetchDailyHistory(["AAPL"], credentials, new Date("2026-01-01T22:00:00Z"),
      async (input) => {
        calls.push(new URL(input.toString()));
        return Response.json({ bars: { AAPL: bars }, next_page_token: null });
      }, "2025-01-01");
    expect(result.AAPL).toHaveLength(350);
    expect(calls[0]!.searchParams.get("start")).toBe(
      new Date(Date.parse("2025-01-01T00:00:00Z") - 600 * 86_400_000).toISOString()
    );
    expect(calls[0]!.searchParams.get("end")).toBe("2026-01-01T22:00:00.000Z");
  });

  it("follows pagination and keeps the most recent 300 daily bars", async () => {
    const calls: URL[] = [];
    const bars = Array.from({ length: 350 }, (_, index) => makeBar(index));
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      calls.push(url);
      const page = url.searchParams.get("page_token");
      const results = page === null ? bars.slice(0, 250) : bars.slice(250);
      return Response.json({
        bars: { AAPL: results },
        next_page_token: page === null ? "page-2" : null
      });
    };

    const result = await fetchDailyBars(
      ["AAPL"],
      credentials,
      new Date("2026-01-01T22:00:00Z"),
      fetcher
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get("timeframe")).toBe("1Day");
    expect(calls[0]?.searchParams.get("feed")).toBe("iex");
    expect(calls[1]?.searchParams.get("page_token")).toBe("page-2");
    expect(result.AAPL).toHaveLength(300);
    expect(result.AAPL?.[0]?.close).toBe(11);
    expect(result.AAPL?.[0]?.timestamp).toBe(bars[50]?.t);
  });

  it("batches symbols rather than issuing one request per ticker", async () => {
    const calls: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      calls.push(url);
      const bars = Object.fromEntries(
        (url.searchParams.get("symbols") ?? "").split(",").map((ticker) => [ticker, []])
      );
      return Response.json({ bars, next_page_token: null });
    };

    await fetchDailyBars(
      Array.from({ length: 21 }, (_, index) => `T${index}`),
      credentials,
      new Date("2026-01-01T22:00:00Z"),
      fetcher
    );

    expect(calls).toHaveLength(2);
  });
});
