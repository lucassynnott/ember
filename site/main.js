// The download button finds the newest notarized DMG, and Ember's line figures.
import { HL } from "./assets/fig/kernel.js";
import { reel } from "./assets/fig/reel.js";
import { waveform } from "./assets/fig/waveform.js";
import { catalogue } from "./assets/fig/catalogue.js";

// Download: the newest Mac DMG, straight from GitHub. The buttons already point at the releases page.
// The newest release with a Mac DMG: Windows releases in the same repo are skipped.
fetch("https://api.github.com/repos/lucassynnott/ember/releases?per_page=20", { headers: { Accept: "application/vnd.github+json" } })
  .then((response) => (response.ok ? response.json() : null))
  .then((releases) => {
    const release = (releases || []).find((entry) => !entry.draft && !entry.prerelease && entry.assets?.some((asset) => /\.dmg$/.test(asset.name)));
    const dmg = release?.assets?.find((asset) => /\.dmg$/.test(asset.name));
    if (!dmg) return;
    document.querySelectorAll(".js-download").forEach((link) => link.setAttribute("href", dmg.browser_download_url));
    const version = String(release.tag_name || "").replace(/^v/, "");
    if (version) document.querySelectorAll(".js-version").forEach((el) => (el.textContent = `Free · v${version}`));
    if (version) document.querySelectorAll(".js-latest").forEach((el) => (el.textContent = version));
  })
  .catch(() => {});

// Ember's own line figures: they play on their own and answer the pointer.
const FIGURES = { reel, waveform, catalogue };
HL.inject(document);
document.querySelectorAll("[data-figure]").forEach((stage) => {
  const figure = FIGURES[stage.dataset.figure];
  if (!figure) return;
  stage.setAttribute("data-hairline", figure.name);
  const svg = HL.mk("svg", { viewBox: "0 0 400 320", "aria-hidden": "true" }, stage);
  const read = document.createElement("span");
  figure.mount({ stage, svg, read }, figure.range[1]);
});
