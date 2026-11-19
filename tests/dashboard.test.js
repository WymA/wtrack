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

it("shares the top menu and theme across Home, Admin, and Backtest", () => {
  const script = readFileSync(new URL("../public/site-header.js", import.meta.url), "utf8");
  const preferences = new Map();
  for (const page of ["index.html", "admin/index.html", "admin/backtest.html"]) {
    const markup = readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8");
    expect(markup).toContain("<title>WTrack</title>");
    expect(markup).toContain('src="/site-header.js"');
    expect(markup).toContain('id="site-header"');
    expect(markup).toContain("icon_names=dark_mode,home,light_mode,settings");
  }

  function loadHeader(pathname) {
    const theme = {};
    const system = { matches: false, addEventListener: vi.fn() };
    const icon = {};
    const home = { getAttribute: () => "/", setAttribute: vi.fn() };
    const admin = { getAttribute: () => "/admin", setAttribute: vi.fn() };
    const backtest = { getAttribute: () => "/admin/backtest.html", setAttribute: vi.fn() };
    const toggle = { querySelector: () => icon, setAttribute: vi.fn(), addEventListener: vi.fn() };
    const header = {
      querySelector: (selector) => selector === "#theme-toggle" ? toggle : null,
      querySelectorAll: () => [home, admin, backtest]
    };
    runInContext(script, createContext({
      console,
      document: {
        documentElement: { setAttribute(name, value) { theme[name] = value; } },
        addEventListener: (_, listener) => listener(),
        querySelector: () => header
      },
      window: {
        location: { pathname },
        matchMedia: () => system,
        localStorage: {
          getItem: (key) => preferences.get(key),
          setItem: (key, value) => preferences.set(key, value)
        }
      }
    }));
    return { theme, icon, home, admin, backtest, toggle, markup: header.innerHTML };
  }

  const homePage = loadHeader("/");
  expect(homePage.markup).not.toContain("Use system theme");
  expect(homePage.home.setAttribute).toHaveBeenCalledWith("aria-current", "page");
  expect(homePage.icon.textContent).toBe("dark_mode");
  homePage.toggle.addEventListener.mock.calls[0][1]();
  expect(homePage.theme["data-bs-theme"]).toBe("dark");
  expect(homePage.icon.textContent).toBe("light_mode");

  const adminPage = loadHeader("/admin");
  expect(adminPage.admin.setAttribute).toHaveBeenCalledWith("aria-current", "page");
  expect(adminPage.theme["data-bs-theme"]).toBe("dark");
  expect(adminPage.toggle.setAttribute).toHaveBeenLastCalledWith("aria-label", "Switch to light mode");
  adminPage.toggle.addEventListener.mock.calls[0][1]();
  expect(adminPage.theme["data-bs-theme"]).toBe("light");
  expect(adminPage.icon.textContent).toBe("dark_mode");
  for (const path of ["/admin/", "/admin/index.html"]) {
    expect(loadHeader(path).admin.setAttribute).toHaveBeenCalledWith("aria-current", "page");
  }
  for (const path of ["/admin/backtest.html", "/admin/backtest"]) {
    const page = loadHeader(path);
    expect(page.markup).toContain('href="/admin/backtest.html"');
    expect(page.backtest.setAttribute).toHaveBeenCalledWith("aria-current", "page");
    expect(page.admin.setAttribute).not.toHaveBeenCalled();
  }
});

describe("dashboard watchlist rendering", () => {
  it("places Signal before Date in Triggered Signals and omits Signal from Watchlist", () => {
    const markup = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const headersByTable = Object.fromEntries(
      Array.from(markup.matchAll(/<thead>([\s\S]*?)<\/thead>\s*<tbody id="([^"]+)">/g), ([, header, id]) => [
        id,
        Array.from(header.matchAll(/<th scope="col">([^<]+)<\/th>/g), ([, label]) => label)
      ])
    );
    const dataHeaders = ["Date", "Close", "Change", "Change %", "EMA 20", "EMA 50", "EMA 100", "EMA 200"];
    expect(headersByTable["signal-rows"]).toEqual(["Ticker", "Signal", ...dataHeaders]);
    expect(headersByTable["ticker-rows"]).toEqual(["Ticker", ...dataHeaders]);
  });

  it("shows all configured tickers as placeholders before the first scan", () => {
    const { renderSnapshot, elements } = createDashboard();
    renderSnapshot({ watchlist: ["AAPL", "MSFT"], snapshot: null, paperTradingEnabled: false });
    const rows = elements.get("#ticker-rows").children;
    expect(rows.map((row) => row.children[0].textContent)).toEqual(["AAPL", "MSFT"]);
    expect(rows[0].children).toHaveLength(9);
    expect(rows[0].children[2].textContent).toBe("—");
    expect(elements.get("#signal-rows").children).toHaveLength(0);
    expect(elements.get("#signals-message").textContent).toBe("Waiting for the first scan.");
    expect(elements.get("#ticker-count").textContent).toBe("2");
    expect(elements.get("#paper-trading-status").textContent).toBe("Paper trading: OFF · signals only");
    expect(elements.get("#paper-trading-status").className).toContain("text-danger-emphasis");
  });

  it("shows triggered tickers only in Signals and keeps unscanned symbols in Watchlist", () => {
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
          { ticker: "AAPL", asOfDate: "2026-11-16", close: 100, change: 1.25, changePercent: 1.25, ema20: 99, ema50: 98, ema100: 97, ema200: 96, signals: ["Setup A"] },
          { ticker: "MSFT", close: 90, signals: ["Exit Tier 2", "Exit Tier 3"] },
          { ticker: "OLD", signals: ["Setup B"] }
        ]
      }
    });
    const signals = elements.get("#signal-rows").children;
    const rows = elements.get("#ticker-rows").children;
    expect(signals.map((row) => row.children[0].textContent)).toEqual(["AAPL", "MSFT"]);
    expect(signals[0].children[0].children).toHaveLength(0);
    expect(signals[0].children[1].children[0].textContent).toBe("Setup-A");
    expect(signals[0].children.slice(2).map((cell) => cell.textContent)).toEqual([
      "2026-11-16", "$100.00", "+$1.25", "+1.25%", "$99.00", "$98.00", "$97.00", "$96.00"
    ]);
    expect(signals[1].children[1].children.map((badge) => badge.textContent)).toEqual(["Exit-2", "Exit-3"]);
    expect(signals[0].classList.add).toHaveBeenCalledWith("entry-row");
    expect(signals[1].classList.add).toHaveBeenCalledWith("exit-row");
    expect(rows.map((row) => row.children[0].textContent)).toEqual(["NEW"]);
    expect(rows[0].children[2].textContent).toBe("—");
    expect(elements.get("#data-message").textContent).toBe("1 ticker without signals.");
    expect(elements.get("#ticker-count").textContent).toBe("3");
    expect(elements.get("#paper-trading-status").textContent).toContain("Paper trading: ON");
    expect(elements.get("#paper-trading-status").className).toContain("text-success-emphasis");
    renderSnapshot({
      watchlist: ["AAPL"],
      snapshot: {
        scannedAt: "2026-11-17T21:30:00Z",
        sessionDate: "2026-11-17",
        status: "no-current-session",
        marketRegime: { passes: false, spy: {} },
        tickers: [{ ticker: "AAPL", asOfDate: "2026-11-16", signals: [] }]
      }
    });
    expect(elements.get("#signal-rows").children).toHaveLength(0);
    const [watchlistRow] = elements.get("#ticker-rows").children;
    expect(watchlistRow.children).toHaveLength(9);
    expect(watchlistRow.children.slice(0, 2).map((cell) => cell.textContent)).toEqual(["AAPL", "2026-11-16"]);
    expect(elements.get("#signals-message").textContent).toBe("No current market session; signals were not evaluated.");
    expect(elements.get("#paper-trading-status").className).toContain("text-body-secondary");
  });

  it("explains the empty Watchlist when all configured tickers have signals", () => {
    const { renderSnapshot, elements } = createDashboard();
    renderSnapshot({
      watchlist: ["AAPL"],
      snapshot: {
        scannedAt: "2026-11-16T21:30:00Z",
        sessionDate: "2026-11-16",
        status: "completed",
        marketRegime: { passes: false, spy: {} },
        tickers: [{ ticker: "AAPL", signals: ["Setup A"] }]
      }
    });
    expect(elements.get("#signal-rows").children).toHaveLength(1);
    expect(elements.get("#ticker-rows").children).toHaveLength(0);
    expect(elements.get("#data-message").textContent).toBe("All watchlist tickers have signals and are shown above.");
  });
});
