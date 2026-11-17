const rowsElement = document.querySelector("#ticker-rows");
const signalRowsElement = document.querySelector("#signal-rows");
const signalsMessageElement = document.querySelector("#signals-message");
const messageElement = document.querySelector("#data-message");
const themeToggle = document.querySelector("#theme-toggle");
const systemThemeButton = document.querySelector("#system-theme-button");
const systemColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const scheduledRunStatusElement = document.querySelector("#scheduled-run-status");
const scheduledRunTimeElement = document.querySelector("#scheduled-run-time");
const scheduledRunDetailElement = document.querySelector("#scheduled-run-detail");
let followsSystemTheme = true;

const money = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function displayNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? money.format(value) : "—";
}

function displayChange(value, formatter) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatter(value)}`;
}

function displayPercent(value) {
  return displayChange(value, (number) => `${number.toFixed(2)}%`);
}

function setTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-bs-theme", isDark ? "dark" : "light");
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
}

function applySystemTheme() {
  setTheme(systemColorScheme.matches ? "dark" : "light");
}

function addCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(cell);
  return cell;
}

function renderSignals(cell, signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    cell.textContent = "—";
    return;
  }

  for (const signal of signals) {
    const badge = document.createElement("span");
    badge.className = signal.startsWith("Exit") ? "signal-badge exit-badge" : "signal-badge entry-badge";
    badge.textContent = signal;
    cell.append(badge);
  }
}

function renderTickers(tickers, target, signalsOnly = false) {
  target.replaceChildren();

  for (const ticker of tickers) {
    const row = document.createElement("tr");
    const signals = Array.isArray(ticker.signals) ? ticker.signals : [];
    if (signals.some((signal) => signal.startsWith("Setup"))) {
      row.classList.add("entry-row");
    } else if (signals.some((signal) => signal.startsWith("Exit"))) {
      row.classList.add("exit-row");
    }

    addCell(row, ticker.ticker);
    addCell(row, ticker.asOfDate ?? "—");
    addCell(row, displayNumber(ticker.close));
    addCell(row, displayChange(ticker.change, (number) => money.format(number)));
    addCell(row, displayPercent(ticker.changePercent));
    if (!signalsOnly) {
      addCell(row, displayNumber(ticker.ema20));
      addCell(row, displayNumber(ticker.ema50));
      addCell(row, displayNumber(ticker.ema100));
      addCell(row, displayNumber(ticker.ema200));
    }

    const signalCell = addCell(row, "");
    renderSignals(signalCell, signals);
    target.append(row);
  }
}

function renderMarketProxy(symbol, price, scannedAt) {
  document.querySelector(`#${symbol}-price`).textContent = displayNumber(price?.close);
  document.querySelector(`#${symbol}-change`).textContent =
    `Change: ${displayChange(price?.change, (number) => money.format(number))} (${displayPercent(price?.changePercent)})`;
  const savedAt = new Date(scannedAt);
  document.querySelector(`#${symbol}-date`).textContent = price?.asOfDate
    ? `Daily close: ${price.asOfDate} · Saved: ${Number.isFinite(savedAt.getTime()) ? savedAt.toLocaleString() : "—"}`
    : "No daily data yet";
}

function renderScheduledRun(record) {
  scheduledRunStatusElement.className = "fs-5";
  scheduledRunDetailElement.textContent = "";

  if (!record || typeof record.success !== "boolean" || typeof record.completedAt !== "string") {
    scheduledRunStatusElement.textContent = "No record";
    scheduledRunStatusElement.classList.add("text-body-secondary");
    scheduledRunTimeElement.textContent = "No scheduled run recorded yet";
    return;
  }

  scheduledRunStatusElement.textContent = record.success ? "Successful" : "Failed";
  scheduledRunStatusElement.classList.add(record.success ? "text-success" : "text-danger");
  const completedAt = new Date(record.completedAt);
  scheduledRunTimeElement.textContent = Number.isFinite(completedAt.getTime())
    ? `Finished ${completedAt.toLocaleString()}`
    : "Completion time unavailable";

  if (!record.success) {
    scheduledRunDetailElement.textContent = "Check Worker logs for details.";
  } else if (record.status === "no-current-session") {
    scheduledRunDetailElement.textContent = "No current market session.";
  } else {
    const alerts = Number.isInteger(record.alerts) ? record.alerts : 0;
    const notified = Number.isInteger(record.notified) ? record.notified : 0;
    scheduledRunDetailElement.textContent =
      `${alerts} alert${alerts === 1 ? "" : "s"} · ${notified} notification${notified === 1 ? "" : "s"}`;
  }
}

function renderSnapshot(payload) {
  document.querySelector("#paper-trading-status").textContent = payload.paperTradingEnabled === true
    ? "Setup A and Setup B enabled for Alpaca paper trading · scheduled scans only"
    : "Paper trading disabled · signals only";
  const snapshot = payload.snapshot;
  const watchlist = Array.isArray(payload.watchlist) ? payload.watchlist : [];
  const savedTickers = new Map(
    (Array.isArray(snapshot?.tickers) ? snapshot.tickers : []).map((ticker) => [ticker.ticker, ticker])
  );
  const tickers = watchlist.map((ticker) => savedTickers.get(ticker) ?? { ticker });
  const triggered = tickers.filter((ticker) => Array.isArray(ticker.signals) && ticker.signals.length > 0);
  renderScheduledRun(payload.lastScheduledRun);
  renderTickers(triggered, signalRowsElement, true);
  renderTickers(tickers, rowsElement);
  document.querySelector("#ticker-count").textContent = String(watchlist.length);
  signalsMessageElement.textContent = !snapshot
    ? "Waiting for the first scan."
    : snapshot.status === "no-current-session"
      ? "No current market session; signals were not evaluated."
    : triggered.length
      ? `${triggered.length} ticker${triggered.length === 1 ? "" : "s"} with signals in the latest scan.`
      : "No signals in the latest scan.";
  renderMarketProxy("spy", snapshot?.marketProxies?.spy, snapshot?.scannedAt);
  renderMarketProxy("qqq", snapshot?.marketProxies?.qqq, snapshot?.scannedAt);

  if (!snapshot) {
    document.querySelector("#session-date").textContent = "—";
    document.querySelector("#scan-status").textContent = "Waiting for the first scheduled scan";
    document.querySelector("#market-filter").textContent = "—";
    document.querySelector("#spy-summary").textContent = "No benchmark data yet";
    document.querySelector("#updated-at").textContent = "No saved snapshot yet";
    messageElement.textContent = payload.watchlist?.length
      ? "The watchlist is configured; waiting for its first scan."
      : "No watchlist tickers are configured.";
    return;
  }

  document.querySelector("#session-date").textContent = snapshot.sessionDate;
  document.querySelector("#scan-status").textContent = snapshot.status === "completed"
    ? "Daily scan complete"
    : "No new market session; showing the latest available bars";
  document.querySelector("#market-filter").textContent = snapshot.marketRegime.passes
    ? "Passing"
    : "Not passing";
  document.querySelector("#spy-summary").textContent =
    `SPY ${displayNumber(snapshot.marketRegime.spy.close)} · ` +
    `EMA 50 ${displayNumber(snapshot.marketRegime.spy.ema50)} · ` +
    `EMA 200 ${displayNumber(snapshot.marketRegime.spy.ema200)}`;
  document.querySelector("#updated-at").textContent =
    `Saved ${new Date(snapshot.scannedAt).toLocaleString()}`;
  messageElement.textContent = tickers.length
    ? `${tickers.length} ticker${tickers.length === 1 ? "" : "s"} in the watchlist.`
    : "No watchlist tickers are configured.";
}

async function loadDashboard() {
  messageElement.textContent = "Loading latest saved data…";
  try {
    const [healthResponse, watchlistResponse] = await Promise.all([
      fetch("/admin/ping", { cache: "no-store" }),
      fetch("/admin/watchlist", { cache: "no-store" })
    ]);
    if (!healthResponse.ok || !watchlistResponse.ok) {
      throw new Error("The dashboard API returned an error.");
    }

    const payload = await watchlistResponse.json();
    renderSnapshot(payload);
  } catch (error) {
    messageElement.textContent = error instanceof Error ? error.message : "Unable to load dashboard data.";
    signalsMessageElement.textContent = "Unable to load signals. Check the dashboard error below.";
  }
}

themeToggle.addEventListener("click", () => {
  followsSystemTheme = false;
  systemThemeButton.hidden = false;
  const currentTheme = document.documentElement.getAttribute("data-bs-theme");
  setTheme(currentTheme === "dark" ? "light" : "dark");
});
systemThemeButton.addEventListener("click", () => {
  followsSystemTheme = true;
  systemThemeButton.hidden = true;
  applySystemTheme();
});
systemColorScheme.addEventListener("change", () => {
  if (followsSystemTheme) applySystemTheme();
});
setTheme(document.documentElement.getAttribute("data-bs-theme") ?? "light");
void loadDashboard();
window.setInterval(loadDashboard, 5 * 60 * 1000);
