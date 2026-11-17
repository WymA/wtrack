const statusElement = document.querySelector("#action-status");
const resultElement = document.querySelector("#action-result");
const actionButtons = [...document.querySelectorAll("[data-action]")];
const paperToggle = document.querySelector("#paper-toggle");
const paperStatus = document.querySelector("#paper-status");
let paperEnabled = null;

const actionPaths = {
  scan: "/admin/scan",
  ping: "/admin/ping",
  watchlist: "/admin/watchlist"
};

function showPaperStatus(enabled) {
  paperEnabled = enabled;
  paperToggle.disabled = false;
  paperToggle.className = enabled ? "btn btn-danger" : "btn btn-success";
  paperToggle.textContent = enabled ? "Turn paper trading OFF" : "Turn paper trading ON";
  paperToggle.setAttribute("aria-pressed", String(enabled));
  paperStatus.textContent = enabled ? "Paper trading is ON." : "Paper trading is OFF. Existing orders remain open.";
}

async function loadPaperStatus() {
  try {
    const response = await fetch("/admin/watchlist", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load paper trading status (${response.status}).`);
    const result = await response.json();
    if (typeof result.paperTradingEnabled !== "boolean") throw new Error("Invalid paper trading status.");
    showPaperStatus(result.paperTradingEnabled);
  } catch (error) {
    paperStatus.textContent = error instanceof Error ? error.message : "Could not load paper trading status.";
  }
}

paperToggle.addEventListener("click", async () => {
  if (paperEnabled === null) return;
  paperToggle.disabled = true;
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
