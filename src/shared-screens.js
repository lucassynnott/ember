// Captures what's shared on screen during a call, through the meeting-notes-screens helper.
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");

function screensHelperPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", "meeting-notes-screens")
    : path.join(app.getAppPath(), "native", "screens", "meeting-notes-screens");
}

// Which window shows the call: Zoom's meeting window, the call app's window, or the browser tab.
const BROWSER_TITLES = {
  "Google Meet": "Meet|meet\\.google",
  "Microsoft Teams": "Teams",
  Zoom: "Zoom",
  Whereby: "Whereby",
  "Jitsi Meet": "Jitsi",
  Webex: "Webex",
  Discord: "Discord",
};

function screenTarget({ zoom, call }) {
  if (zoom?.screenSharing && !zoom?.meetingOpen) return { display: true, label: "your shared screen" };
  if (zoom?.meetingOpen) return { bundle: "us.zoom.xos", label: "Zoom" };
  if (call?.bundleId) {
    if (call.browser) return { bundle: call.bundleId, title: BROWSER_TITLES[call.app] || null, label: call.app };
    return { bundle: call.bundleId, label: call.app };
  }
  return null;
}

class ScreenWatcher {
  constructor({ binaryPath, outDir, target, onSlide = () => {} }) {
    this.binaryPath = binaryPath;
    this.outDir = outDir;
    this.target = target;
    this.onSlide = onSlide;
    this.child = null;
    this.buffer = "";
  }

  async start() {
    await fs.mkdir(this.outDir, { recursive: true, mode: 0o700 });
    const args = ["--out", this.outDir, "--interval", "2"];
    if (this.target.display) args.push("--display");
    else args.push("--bundle", this.target.bundle);
    if (this.target.title) args.push("--title", this.target.title);
    this.child = spawn(this.binaryPath, args, { stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === "slide") this.onSlide(message);
        } catch {
          // Not a slide line.
        }
      }
    });
    this.child.on("error", (error) => console.error("Shared screen capture:", error.message));
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    setTimeout(() => child.kill("SIGTERM"), 1500).unref();
  }
}

/** Copies a call's slides beside its note, as `<stem>-shared/slide-001.jpg`; returns their relative paths. */
async function placeSlides(slides, noteDirectory, stem) {
  if (!slides.length) return [];
  const folder = path.join(noteDirectory, `${stem}-shared`);
  await fs.mkdir(folder, { recursive: true });
  const placed = [];
  for (const slide of slides) {
    const name = path.basename(slide.file);
    await fs.copyFile(slide.file, path.join(folder, name));
    placed.push(`./${stem}-shared/${name}`);
  }
  return placed;
}

module.exports = { ScreenWatcher, placeSlides, screenTarget, screensHelperPath };
