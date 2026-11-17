import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function createDashboard() {
  const elements = new Map();
  function element() {
    return {
      children: [],
      textContent: "",
      className: "",
      classList: { add: vi.fn() },
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      addEventListener() {},
      setAttribute() {},
      getAttribute() { return "light"; }
    };
  }
  const document = {
    documentElement: element(),
    createElement: element,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    }
  };
  const context = createContext({
    document,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), setInterval() {} },
    fetch: () => new Promise(() => {})
  });
  runInContext(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), context);
  return { renderSnapshot: context.renderSnapshot, elements };
}

describe("dashboard watchlist rendering", () => {
  it("shows all configured tickers as placeholders before the first scan", () => {
    const { renderSnapshot, elements } = createDashboard();
    renderSnapshot({ watchlist: ["AAPL", "MSFT"], snapshot: null, paperTradingEnabled: false });
    const rows = elements.get("#ticker-rows").children;
    expect(rows.map((row) => row.children[0].textContent)).toEqual(["AAPL", "MSFT"]);
    expect(rows[0].children).toHaveLength(10);
    expect(rows[0].children[2].textContent).toBe("—");
    expect(elements.get("#signal-rows").children).toHaveLength(0);
    expect(elements.get("#signals-message").textContent).toBe("Waiting for the first scan.");
    expect(elements.get("#ticker-count").textContent).toBe("2");
    expect(elements.get("#paper-trading-status").textContent).toBe("Paper trading: OFF · signals only");
  });

  it("shows only current watchlist signals and keeps unscanned symbols in the full list", () => {
    const { renderSnapshot, elements } = createDashboard();
    renderSnapshot({
      watchlist: ["AAPL", "MSFT", "NEW"],
      paperTradingEnabled: true,
      snapshot: {
        scannedAt: "2026-11-16T21:30:00Z",
        sessionDate: "2026-11-16",
        status: "completed",
        marketRegime: { passes: false, spy: {} },
        tickers: [
          { ticker: "AAPL", close: 100, signals: ["Setup A"] },
          { ticker: "MSFT", close: 90, signals: ["Exit Tier 2"] },
          { ticker: "OLD", signals: ["Setup B"] }
        ]
      }
    });
    const signals = elements.get("#signal-rows").children;
    const rows = elements.get("#ticker-rows").children;
    expect(signals.map((row) => row.children[0].textContent)).toEqual(["AAPL", "MSFT"]);
    expect(signals[0].classList.add).toHaveBeenCalledWith("entry-row");
    expect(signals[1].classList.add).toHaveBeenCalledWith("exit-row");
    expect(rows.map((row) => row.children[0].textContent)).toEqual(["AAPL", "MSFT", "NEW"]);
    expect(rows[2].children[2].textContent).toBe("—");
    expect(elements.get("#ticker-count").textContent).toBe("3");
    expect(elements.get("#paper-trading-status").textContent).toContain("Paper trading: ON");
    renderSnapshot({
      watchlist: ["AAPL"],
      snapshot: {
        scannedAt: "2026-11-17T21:30:00Z",
        sessionDate: "2026-11-17",
        status: "no-current-session",
        marketRegime: { passes: false, spy: {} },
        tickers: [{ ticker: "AAPL", signals: [] }]
      }
    });
    expect(elements.get("#signal-rows").children).toHaveLength(0);
    expect(elements.get("#signals-message").textContent).toBe("No current market session; signals were not evaluated.");
  });
});
