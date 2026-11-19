const statusElement = document.querySelector("#action-status");
const resultElement = document.querySelector("#action-result");
const actionButtons = [...document.querySelectorAll("[data-action]")];
const paperToggle = document.querySelector("#paper-toggle");
const paperStatus = document.querySelector("#paper-status");
const orderRows = document.querySelector("#order-rows");
const ordersStatus = document.querySelector("#orders-status");
const ordersRefresh = document.querySelector("#orders-refresh");
let paperEnabled = null;

const actionPaths = {
  scan: "/admin/scan",
  ping: "/admin/ping",
  watchlist: "/admin/watchlist"
};

async function loadPaperOrders() {
  ordersRefresh.disabled = true;
  ordersStatus.textContent = "Loading orders…";
  try {
    const response = await fetch("/admin/orders", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load orders (${response.status}).`);
    const result = await response.json();
    const fields = ["signalDate", "phase", "ticker", "side", "qty", "filledQty", "limit", "status", "clientId"];
    if (!Array.isArray(result.orders) || !result.orders.every((order) =>
      order && fields.every((field) => typeof order[field] === "string") &&
      (order.id === undefined || typeof order.id === "string")
    )) throw new Error("Invalid stored order history.");
    orderRows.replaceChildren();
    for (const order of result.orders) {
      const row = document.createElement("tr");
      for (const field of [...fields, "id"]) {
        const cell = document.createElement("td");
        cell.textContent = order[field] ?? "—";
        row.append(cell);
      }
      orderRows.append(row);
    }
    ordersStatus.textContent = result.orders.length
      ? `${result.orders.length} stored record${result.orders.length === 1 ? "" : "s"}.`
      : "No paper trading orders yet.";
  } catch (error) {
    orderRows.replaceChildren();
    ordersStatus.textContent = error instanceof Error ? error.message : "Could not load paper trading orders.";
  } finally {
    ordersRefresh.disabled = false;
  }
}

ordersRefresh.addEventListener("click", () => { void loadPaperOrders(); });
function showPaperStatus(enabled) {
  paperEnabled = enabled;
  paperToggle.disabled = false;
  paperToggle.className = enabled ? "btn btn-danger" : "btn btn-success";
  paperToggle.textContent = enabled ? "Turn paper trading OFF" : "Turn paper trading ON";
  paperToggle.setAttribute("aria-pressed", String(enabled));
  paperStatus.className = `mt-2 mb-0 ${enabled ? "text-success-emphasis" : "text-danger-emphasis"}`;
  paperStatus.textContent = enabled ? "Paper trading is ON." : "Paper trading is OFF. Existing orders remain open.";
}

async function loadPaperStatus() {
  try {
    const response = await fetch("/admin/paper-trading", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load paper trading status (${response.status}).`);
    const result = await response.json();
    if (typeof result.enabled !== "boolean") throw new Error("Invalid paper trading status.");
    showPaperStatus(result.enabled);
  } catch (error) {
    paperStatus.className = "text-body-secondary mt-2 mb-0";
    paperStatus.textContent = error instanceof Error ? error.message : "Could not load paper trading status.";
  }
}

paperToggle.addEventListener("click", async () => {
  if (paperEnabled === null) return;
  paperToggle.disabled = true;
  paperStatus.className = "text-body-secondary mt-2 mb-0";
  paperStatus.textContent = "Updating paper trading status…";
  try {
    const response = await fetch("/admin/paper-trading", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !paperEnabled })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Switch failed (${response.status}).`);
    if (typeof result.enabled !== "boolean") throw new Error("Invalid switch response.");
    showPaperStatus(result.enabled);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update paper trading.";
    paperEnabled = null;
    await loadPaperStatus();
    paperStatus.textContent = `${message} Status was rechecked. ${paperStatus.textContent}`;
  }
});

async function runAction(action) {
  const path = actionPaths[action];
  if (!path) {
    statusElement.textContent = "Unknown action.";
    return;
  }

  actionButtons.forEach((button) => {
    button.disabled = true;
  });
  statusElement.textContent = `${action[0].toUpperCase()}${action.slice(1)} in progress…`;
  resultElement.textContent = "";

  try {
    const response = await fetch(path, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) {
      const message = result && typeof result.error === "string"
        ? result.error
        : `Request failed with status ${response.status}.`;
      throw new Error(message);
    }

    statusElement.textContent = "Completed.";
    resultElement.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    statusElement.textContent = "Action failed.";
    resultElement.textContent = error instanceof Error ? error.message : "The request could not be completed.";
  } finally {
    actionButtons.forEach((button) => {
      button.disabled = false;
    });
  }
}

for (const button of actionButtons) {
  button.addEventListener("click", () => {
    void runAction(button.dataset.action);
  });
}
void loadPaperStatus();
void loadPaperOrders();
