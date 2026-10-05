// The download button finds the newest notarized DMG; the demo's sound toggle; and Ember's line figures.
import { HL } from "./assets/fig/kernel.js";
import { reel } from "./assets/fig/reel.js";
import { waveform } from "./assets/fig/waveform.js";
import { catalogue } from "./assets/fig/catalogue.js";

// Download: the latest release's DMG, straight from GitHub. The buttons already point at the releases page.
fetch("https://api.github.com/repos/lucassynnott/ember/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
  .then((response) => (response.ok ? response.json() : null))
  .then((release) => {
    const dmg = release?.assets?.find((asset) => /\.dmg$/.test(asset.name));
    if (!dmg) return;
    document.querySelectorAll(".js-download").forEach((link) => link.setAttribute("href", dmg.browser_download_url));
    const version = String(release.tag_name || "").replace(/^v/, "");
    if (version) document.querySelectorAll(".js-version").forEach((el) => (el.textContent = `Free · v${version}`));
  })
  .catch(() => {});

// The demo plays muted on a loop; the button turns the soundtrack on from the start.
const video = document.querySelector(".js-demo");
const sound = document.querySelector(".js-sound");
sound?.addEventListener("click", () => {
  const on = video.muted;
  video.muted = !on;
  if (on) { video.currentTime = 0; void video.play(); }
  sound.setAttribute("aria-pressed", String(on));
  sound.querySelector("span").textContent = on ? "Sound off" : "Sound on";
});

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
