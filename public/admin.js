const statusElement = document.querySelector("#action-status");
const resultElement = document.querySelector("#action-result");
const actionButtons = [...document.querySelectorAll("[data-action]")];

const actionPaths = {
  scan: "/scan",
  ping: "/ping",
  watchlist: "/watchlist"
};

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
