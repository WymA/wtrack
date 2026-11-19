const systemColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const themeKey = "wtrack-theme";
let themePreference;

try {
  const savedTheme = window.localStorage.getItem(themeKey);
  if (savedTheme === "light" || savedTheme === "dark") themePreference = savedTheme;
} catch (error) {
  console.warn("Could not read the WTrack theme preference.", error);
}

function currentTheme() {
  return themePreference ?? (systemColorScheme.matches ? "dark" : "light");
}

function applyTheme() {
  document.documentElement.setAttribute("data-bs-theme", currentTheme());
}

applyTheme();

document.addEventListener("DOMContentLoaded", () => {
  const header = document.querySelector("#site-header");
  header.innerHTML = `
    <nav class="d-flex flex-wrap align-items-center gap-2" aria-label="Main navigation">
      <a class="btn btn-primary d-inline-flex align-items-center gap-2" href="/" aria-label="WTrack home">
        <span class="material-symbols-outlined" aria-hidden="true">home</span>
        WTrack
      </a>
      <a class="btn btn-outline-primary d-inline-flex align-items-center gap-2" href="/admin">
        <span class="material-symbols-outlined" aria-hidden="true">settings</span>
        Admin
      </a>
      <a class="btn btn-outline-primary" href="/admin/backtest.html">Backtest</a>
    </nav>
    <button class="btn btn-outline-secondary theme-toggle" type="button" id="theme-toggle">
      <span class="material-symbols-outlined" aria-hidden="true"></span>
    </button>
  `;

  const path = window.location.pathname.replace(/\/index\.html$/, "").replace(/\.html$/, "").replace(/\/$/, "") || "/";
  for (const link of header.querySelectorAll("nav a")) {
    const href = link.getAttribute("href").replace(/\.html$/, "");
    if (path === href) link.setAttribute("aria-current", "page");
  }

  const themeToggle = header.querySelector("#theme-toggle");
  const themeIcon = themeToggle.querySelector(".material-symbols-outlined");

  function updateThemeControls() {
    applyTheme();
    const isDark = currentTheme() === "dark";
    const label = isDark ? "Switch to light mode" : "Switch to dark mode";
    themeIcon.textContent = isDark ? "light_mode" : "dark_mode";
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
  }

  function selectTheme(theme) {
    themePreference = theme;
    try {
      window.localStorage.setItem(themeKey, theme);
    } catch (error) {
      console.warn("Could not save the WTrack theme preference.", error);
    }
    updateThemeControls();
  }

  themeToggle.addEventListener("click", () => selectTheme(currentTheme() === "dark" ? "light" : "dark"));
  systemColorScheme.addEventListener("change", updateThemeControls);
  updateThemeControls();
});
