import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { strategyCatalog } from "../strategy-core/strategy.ts";

function createAdmin(fetcher) {
  const elements = new Map();
  function element() {
    return {
      textContent: "", disabled: false, className: "", children: [],
      addEventListener(name, callback) { this[name] = callback; },
      setAttribute: vi.fn(),
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; }
    };
  }
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll: () => [],
    createElement: element
  };
  const context = createContext({ document, fetch: fetcher });
  runInContext(readFileSync(new URL("../public/admin/admin.js", import.meta.url), "utf8"), context);
  return elements;
}

function createBacktestUI(fetcher) {
  const markup = readFileSync(new URL("../public/admin/backtest.html", import.meta.url), "utf8");
  const script = markup.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const strategyInputs = new Map(strategyCatalog.map((strategy) => [
    strategy.id, { dataset: { setup: strategy.id }, checked: false }
  ]));
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, {
          classList: { toggle: vi.fn() },
          addEventListener(name, callback) { this[name] = callback; }
        });
      }
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      if (selector === "[data-setup]") return [...strategyInputs.values()];
      return ["#run", "#refresh", "#reload", "#save", "#config"]
        .map((id) => document.querySelector(id)).concat([...strategyInputs.values()]);
    }
  };
  const context = createContext({ document, fetch: fetcher });
  runInContext(script, context);
  return { elements, strategyInputs, markup, renderResult: context.renderResult };
}

it("loads and updates the paper trading switch", async () => {
  const fetcher = vi.fn(async (url, init) => {
    if (url === "/admin/paper-trading" && !init?.method) return Response.json({ enabled: false });
    if (url === "/admin/orders") return Response.json({ orders: [] });
    if (url === "/admin/paper-trading") return Response.json({ enabled: true });
    throw new Error(`Unexpected request: ${url}`);
  });
  const elements = createAdmin(fetcher);
  const button = elements.get("#paper-toggle");
  await vi.waitFor(() => expect(button.textContent).toBe("Turn paper trading ON"));
  expect(elements.get("#paper-status").className).toContain("text-danger-emphasis");
  await button.click();
  expect(button.textContent).toBe("Turn paper trading OFF");
  expect(elements.get("#paper-status").className).toContain("text-success-emphasis");
  const switchCall = fetcher.mock.calls.find(([url, init]) => url === "/admin/paper-trading" && init?.method === "POST");
  expect(JSON.parse(switchCall[1].body)).toEqual({ enabled: true });
});

it("renders stored order details as text and reports refresh failures", async () => {
  let ordersAvailable = true;
  const fetcher = vi.fn(async (url) => {
    if (url === "/admin/paper-trading") return Response.json({ enabled: true });
    if (url === "/admin/orders") return ordersAvailable
      ? Response.json({ orders: [{
        signalDate: "2026-11-16", phase: "close", ticker: "<AAPL>", side: "buy",
        qty: "2", filledQty: "1", limit: "103.00", status: "partially_filled", clientId: "test"
      }] })
      : new Response("Unavailable", { status: 500 });
    throw new Error(`Unexpected request: ${url}`);
  });
  const elements = createAdmin(fetcher);
  await vi.waitFor(() => expect(elements.get("#order-rows").children).toHaveLength(1));
  const cells = elements.get("#order-rows").children[0].children;
  expect(cells.map((cell) => cell.textContent)).toEqual([
    "2026-11-16", "close", "<AAPL>", "buy", "2", "1", "103.00", "partially_filled", "test", "—"
  ]);
  ordersAvailable = false;
  elements.get("#orders-refresh").click();
  await vi.waitFor(() => expect(elements.get("#orders-status").textContent).toContain("500"));
  expect(elements.get("#order-rows").children).toHaveLength(0);
});

it("loads and runs backtests through the WTrack server without a local launcher", async () => {
  const fetcher = vi.fn(async (path) => {
    if (path === "/admin/backtest/config") return Response.json({
      config: { strategy: { setups: ["Setup A"], watchlist: ["AAPL"] } },
      strategies: strategyCatalog
    });
    if (path === "/admin/backtest/cache") return Response.json({ tickers: [] });
    if (path === "/admin/backtest/run") return Response.json({ error: "Not enough historical bars." }, { status: 502 });
    throw new Error(`Unexpected request: ${path}`);
  });
  const { elements, markup } = createBacktestUI(fetcher);
  await vi.waitFor(() => expect(elements.get("#config").value).toContain("AAPL"));
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/admin/backtest/config", "/admin/backtest/cache"]);
  expect(markup).not.toContain("local-launch");
  expect(markup).not.toContain("127.0.0.1");
  await elements.get("#run").click({ currentTarget: elements.get("#run") });
  expect(elements.get("#status").textContent).toBe("Not enough historical bars.");
  expect(fetcher.mock.calls[2][1].method).toBe("POST");
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ config: { strategy: { setups: ["Setup A"], watchlist: ["AAPL"] } } });
  expect(elements.get("#run").disabled).toBe(false);
  expect(elements.get("#refresh").disabled).toBe(false);
});

it("edits one online config, saves only explicitly, and discards unsaved changes on reload", async () => {
  let saved = { strategy: { setups: ["Setup A"], watchlist: ["AAPL"] } };
  const fetcher = vi.fn(async (path, init) => {
    if (path === "/admin/backtest/cache") return Response.json({ tickers: [] });
    if (path === "/admin/backtest/save") {
      const { config } = JSON.parse(init.body);
      saved = config;
      return Response.json({ config });
    }
    return Response.json({ config: saved, strategies: strategyCatalog });
  });
  const { elements, strategyInputs, markup } = createBacktestUI(fetcher);
  await vi.waitFor(() => expect(elements.get("#config").value).toContain("AAPL"));
  expect(elements.get("#strategy-cards").innerHTML).toContain("Stacked Pullback");
  expect(elements.get("#strategy-cards").innerHTML).toContain("Momentum Rotation");
  expect(elements.get("#strategy-cards").innerHTML).toContain("<strong>Entry:</strong>");
  expect(elements.get("#strategy-cards").innerHTML).toContain("<strong>Exit:</strong>");
  expect(elements.get("#strategy-cards").innerHTML).toContain("<strong>Position:</strong>");
  expect(elements.get("#strategy-cards").innerHTML).toContain(strategyCatalog[2].exitDescription.replaceAll("'", "&#39;"));
  for (const removed of ["config-select", "config-name", "config-files"]) expect(markup).not.toContain(`id="${removed}"`);
  expect(strategyInputs.get("Setup A").checked).toBe(true);
  const b = strategyInputs.get("Setup B");
  b.checked = true;
  elements.get("#strategy-cards").change({ target: b });
  expect(JSON.parse(elements.get("#config").value).strategy.setups).toEqual(["Setup A", "Setup B"]);
  expect(elements.get("#config-state").textContent).toContain("Unsaved changes");
  expect(saved.strategy.setups).toEqual(["Setup A"]);
  expect(fetcher.mock.calls.filter(([path]) => path === "/admin/backtest/save")).toHaveLength(0);
  await elements.get("#save").click();
  expect(saved.strategy.setups).toEqual(["Setup A", "Setup B"]);
  expect(elements.get("#config-state").textContent).toBe("Saved configuration loaded.");
  elements.get("#config").value = JSON.stringify({ ...saved, strategy: { ...saved.strategy, setups: [] } });
  elements.get("#config").input();
  await elements.get("#reload").click();
  expect(JSON.parse(elements.get("#config").value)).toEqual(saved);
});

it("leaves the draft intact when Save is rejected", async () => {
  const config = { strategy: { setups: ["Setup A"], watchlist: ["AAPL"] } };
  const { elements } = createBacktestUI(async (path) => {
    if (path === "/admin/backtest/cache") return Response.json({ tickers: [] });
    if (path === "/admin/backtest/save") return Response.json({ error: "Invalid config." }, { status: 400 });
    return Response.json({ config, strategies: strategyCatalog });
  });
  await vi.waitFor(() => expect(elements.get("#config").value).toContain("AAPL"));
  elements.get("#config").value = '{"broken":true}';
  elements.get("#config").input();
  await elements.get("#save").click();
  expect(elements.get("#status").textContent).toBe("Invalid config.");
  expect(elements.get("#config").value).toBe('{"broken":true}');
  expect(elements.get("#config-state").textContent).toContain("Unsaved changes");
});

it.each([
  [10, "10.00%", "positive"],
  [-5, "-5.00%", "negative"],
  [null, "Unavailable", ""]
])("renders the simulated period and VOO return of %s in Performance", (returnPercent, expected, color) => {
  const { elements, renderResult } = createBacktestUI(() => new Promise(() => {}));
  const result = {
    config: { dateWindow: { start: "2025-01-01", end: "2025-01-12" } },
    period: { start: "2025-01-02", end: "2025-01-10", tradingDays: 6 },
    benchmark: { ticker: "VOO", returnPercent },
    metrics: {
      startingCapital: 1000, endingEquity: 1000, netProfit: 0, returnPercent: 0,
      closedTrades: 0, winRatePercent: 0, profitFactor: 0, maxDrawdownPercent: 0, openPositions: 0
    },
    trades: [], openTrades: []
  };
  renderResult(result);
  expect(elements.get("#performance-period").textContent).toBe(
    "Period: 2025-01-02 to 2025-01-10 (6 trading sessions). Requested: 2025-01-01 to 2025-01-12."
  );
  expect(elements.get("#metrics").innerHTML).toContain(
    `<span>VOO buy-and-hold</span><strong class="${color}">${expected}</strong>`
  );
  expect(elements.get("#summary").hidden).toBe(false);
  renderResult({ ...result, period: { start: null, end: null, tradingDays: 0 } });
  expect(elements.get("#performance-period").textContent).toBe(
    "Period: 2025-01-01 to 2025-01-12. No completed trading sessions."
  );
});
