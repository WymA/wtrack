const rowsElement = document.querySelector("#ticker-rows");
const signalRowsElement = document.querySelector("#signal-rows");
const signalsMessageElement = document.querySelector("#signals-message");
const messageElement = document.querySelector("#data-message");
const scheduledRunStatusElement = document.querySelector("#scheduled-run-status");
const scheduledRunTimeElement = document.querySelector("#scheduled-run-time");
const scheduledRunDetailElement = document.querySelector("#scheduled-run-detail");
const paperTradingStatusElement = document.querySelector("#paper-trading-status");

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

function addCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(cell);
  return cell;
}

function renderSignals(cell, signals) {
  for (const signal of signals) {
    const badge = document.createElement("span");
    badge.className = signal.startsWith("Exit") ? "signal-badge exit-badge" : "signal-badge entry-badge";
    badge.textContent = signal
      .replace(/^Exit Tier ([23])$/, "Exit-$1")
      .replace(/^Setup ([ABC])$/, "Setup-$1");
    cell.append(badge);
  }
}

function renderTickers(tickers, target, { showSignal = false } = {}) {
  target.replaceChildren();

  for (const ticker of tickers) {
    const row = document.createElement("tr");
    addCell(row, ticker.ticker);
    if (showSignal) {
      const signals = ticker.signals;
      if (signals.some((signal) => signal.startsWith("Setup"))) {
        row.classList.add("entry-row");
      } else if (signals.some((signal) => signal.startsWith("Exit"))) {
        row.classList.add("exit-row");
      }
      renderSignals(addCell(row, ""), signals);
    }
    addCell(row, ticker.asOfDate ?? "—");
    addCell(row, displayNumber(ticker.close));
    addCell(row, displayChange(ticker.change, (number) => money.format(number)));
    addCell(row, displayPercent(ticker.changePercent));
    addCell(row, displayNumber(ticker.ema20));
    addCell(row, displayNumber(ticker.ema50));
    addCell(row, displayNumber(ticker.ema100));
    addCell(row, displayNumber(ticker.ema200));
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
  const paperEnabled = payload.paperTradingEnabled;
  paperTradingStatusElement.className = `fw-semibold mb-0 ${
    paperEnabled === true ? "text-success-emphasis" : paperEnabled === false ? "text-danger-emphasis" : "text-body-secondary"
  }`;
  paperTradingStatusElement.textContent = paperEnabled === true
    ? "Paper trading: ON · Setup-A and Setup-B · scheduled scans only"
    : paperEnabled === false
      ? "Paper trading: OFF · signals only"
      : "Paper trading: status unavailable.";
  const snapshot = payload.snapshot;
  const watchlist = Array.isArray(payload.watchlist) ? payload.watchlist : [];
  const savedTickers = new Map(
    (Array.isArray(snapshot?.tickers) ? snapshot.tickers : []).map((ticker) => [ticker.ticker, ticker])
  );
  const triggered = [];
  const remaining = [];
  for (const ticker of watchlist) {
    const saved = savedTickers.get(ticker) ?? { ticker };
    if (Array.isArray(saved.signals) && saved.signals.length > 0) {
      triggered.push(saved);
    } else {
      remaining.push(saved);
    }
  }
  renderScheduledRun(payload.lastScheduledRun);
  renderTickers(triggered, signalRowsElement, { showSignal: true });
  renderTickers(remaining, rowsElement);
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
  messageElement.textContent = remaining.length
    ? `${remaining.length} ticker${remaining.length === 1 ? "" : "s"} without signals.`
    : triggered.length
      ? "All watchlist tickers have signals and are shown above."
      : "No watchlist tickers are configured.";
}

async function loadDashboard() {
  messageElement.textContent = "Loading latest saved data…";
  try {
    const [healthResponse, watchlistResponse] = await Promise.all([
      fetch("/admin/ping", { cache: "no-store" }),
      fetch("/admin/dashboard", { cache: "no-store" })
    ]);
    if (!healthResponse.ok || !watchlistResponse.ok) {
      throw new Error("The dashboard API returned an error.");
    }

    const payload = await watchlistResponse.json();
    renderSnapshot(payload);
  } catch (error) {
    messageElement.textContent = error instanceof Error ? error.message : "Unable to load dashboard data.";
    signalsMessageElement.textContent = "Unable to load signals. Check the dashboard error below.";
    paperTradingStatusElement.className = "fw-semibold mb-0 text-body-secondary";
    paperTradingStatusElement.textContent = "Paper trading: status unavailable.";
  }
}

void loadDashboard();
window.setInterval(loadDashboard, 5 * 60 * 1000);
