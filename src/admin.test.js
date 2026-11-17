import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("loads and updates the paper trading switch", async () => {
  const elements = new Map();
  function element() {
    return {
      textContent: "", disabled: false, className: "",
      addEventListener(name, callback) { this[name] = callback; },
      setAttribute: vi.fn()
    };
  }
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll: () => []
  };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ paperTradingEnabled: false }))
    .mockResolvedValueOnce(Response.json({ enabled: true }));
  const context = createContext({ document, fetch: fetcher });
  runInContext(readFileSync(new URL("../public/admin.js", import.meta.url), "utf8"), context);
  const button = elements.get("#paper-toggle");
  await vi.waitFor(() => expect(button.textContent).toBe("Turn paper trading ON"));
  await button.click();
  expect(button.textContent).toBe("Turn paper trading OFF");
  expect(fetcher.mock.calls[1][0]).toBe("/admin/paper-trading");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ enabled: true });
});
