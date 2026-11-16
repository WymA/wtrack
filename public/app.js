const rowsElement = document.querySelector("#ticker-rows");
const messageElement = document.querySelector("#data-message");
const connectionStatusElement = document.querySelector("#connection-status");
const connectionIndicator = document.querySelector("#connection-indicator");
const refreshButton = document.querySelector("#refresh-button");
const themeToggle = document.querySelector("#theme-toggle");
const systemThemeButton = document.querySelector("#system-theme-button");
const systemColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
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

function setTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.setAttribute("data-bs-theme", isDark ? "dark" : "light");
  themeToggle.textContent = isDark ? "Switch to light mode" : "Switch to dark mode";
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

function renderTickers(tickers) {
  rowsElement.replaceChildren();

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
    addCell(row, displayNumber(ticker.stopLoss));
    addCell(row, displayNumber(ticker.ema20));
    addCell(row, displayNumber(ticker.ema50));
    addCell(row, displayNumber(ticker.ema100));
    addCell(row, displayNumber(ticker.ema200));

    const signalCell = addCell(row, "");
    renderSignals(signalCell, signals);
    addCell(row, ticker.sufficientHistory ? "300 bars" : `${ticker.historyBars}/300 bars`);
    rowsElement.append(row);
  }

  document.querySelector("#ticker-count").textContent = String(tickers.length);
}

function renderSnapshot(payload) {
  const snapshot = payload.snapshot;
  const tickers = Array.isArray(snapshot?.tickers) ? snapshot.tickers : [];
  renderTickers(tickers);

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
    ? `${tickers.length} tracked ticker${tickers.length === 1 ? "" : "s"} in the latest snapshot.`
    : "No watchlist or holding tickers are configured.";
}

async function loadDashboard() {
  refreshButton.disabled = true;
  messageElement.textContent = "Loading latest saved data…";
  try {
    const [healthResponse, watchlistResponse] = await Promise.all([
      fetch("/ping", { cache: "no-store" }),
      fetch("/watchlist", { cache: "no-store" })
    ]);
    if (!healthResponse.ok || !watchlistResponse.ok) {
      throw new Error("The dashboard API returned an error.");
    }

    const payload = await watchlistResponse.json();
    renderSnapshot(payload);
    connectionStatusElement.textContent = "Connected";
    connectionIndicator.classList.add("connected");
  } catch (error) {
    messageElement.textContent = error instanceof Error ? error.message : "Unable to load dashboard data.";
    connectionStatusElement.textContent = "Connection error";
    connectionIndicator.classList.remove("connected");
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadDashboard);
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
void loadDashboard();
window.setInterval(loadDashboard, 5 * 60 * 1000);
