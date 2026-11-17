import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";

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
  runInContext(readFileSync(new URL("../public/admin.js", import.meta.url), "utf8"), context);
  return elements;
}

it("loads and updates the paper trading switch", async () => {
  const fetcher = vi.fn(async (url) => {
    if (url === "/admin/watchlist") return Response.json({ paperTradingEnabled: false });
    if (url === "/admin/orders") return Response.json({ orders: [] });
    if (url === "/admin/paper-trading") return Response.json({ enabled: true });
    throw new Error(`Unexpected request: ${url}`);
  });
  const elements = createAdmin(fetcher);
  const button = elements.get("#paper-toggle");
  await vi.waitFor(() => expect(button.textContent).toBe("Turn paper trading ON"));
  await button.click();
  expect(button.textContent).toBe("Turn paper trading OFF");
  const switchCall = fetcher.mock.calls.find(([url]) => url === "/admin/paper-trading");
  expect(JSON.parse(switchCall[1].body)).toEqual({ enabled: true });
});

it("renders stored order details as text and reports refresh failures", async () => {
  let ordersAvailable = true;
  const fetcher = vi.fn(async (url) => {
    if (url === "/admin/watchlist") return Response.json({ paperTradingEnabled: true });
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
