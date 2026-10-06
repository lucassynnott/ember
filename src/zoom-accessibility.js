const path = require("node:path");
const { spawn } = require("node:child_process");

function observerPath(app) {
  if (process.platform === "win32") return require("./platform").nativeHelperPath(app, "hotkey");
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", "meeting-notes-zoom-observer")
    : path.join(app.getAppPath(), "native", "zoom-observer", "meeting-notes-zoom-observer");
}

function overlapMilliseconds(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function resolveSpeakerFromIntervals({
  intervals,
  activeSpeakers = [],
  lastObservedAt = null,
  startedAt,
  endedAt,
  now = Date.now(),
}) {
  const start = Number(startedAt) - 500;
  const end = Number(endedAt) + 250;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const candidates = [...intervals];
  if (lastObservedAt !== null) {
    const currentEnd = Math.max(lastObservedAt, Math.min(end, now));
    for (const speaker of activeSpeakers) {
      candidates.push({ speaker, startedAt: lastObservedAt, endedAt: currentEnd });
    }
  }

  const scores = new Map();
  for (const interval of candidates) {
    const overlap = overlapMilliseconds(start, end, interval.startedAt, interval.endedAt);
    if (overlap > 0) scores.set(interval.speaker, (scores.get(interval.speaker) || 0) + overlap);
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  if (!ranked.length || ranked[0][1] < 250) return null;
  if (ranked[1] && ranked[0][1] - ranked[1][1] < 200 && ranked[0][1] < ranked[1][1] * 1.5) {
    return null;
  }
  return ranked[0][0];
}

function segmentSpeaker({ source, configuredSpeakerName, zoomSpeaker }) {
  return source === "microphone" ? configuredSpeakerName : zoomSpeaker || "Remote speaker";
}

class ZoomAccessibilityObserver {
  constructor({ app, onState = () => {}, onAudioApps = () => {} }) {
    this.binaryPath = observerPath(app);
    this.onState = onState;
    this.onAudioApps = onAudioApps;
    this.child = null;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.intervals = [];
    this.lastObservedAt = null;
    this.activeSpeakers = [];
    this.state = {
      accessibility: "not-granted",
      meetingOpen: false,
      participants: [],
      activeSpeakers: [],
    };
  }

  start() {
    if (this.child) return;
    const child = spawn(this.binaryPath, process.platform === "win32" ? ["observe-audio"] : [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout.on("data", (chunk) => this.#handleOutput(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.once("error", (error) => this.#fail(error));
    child.once("close", (code) => {
      if (this.child === child) this.child = null;
      if (code && code !== 0) this.#fail(new Error(this.stderr || `Zoom observer exited with ${code}.`));
    });
  }

  #handleOutput(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === "audio-apps") this.onAudioApps(Array.isArray(message.apps) ? message.apps : []);
        else this.#recordState(message);
      } catch {
        // Ignore malformed helper output and keep observing.
      }
    }
  }

  #recordState(message) {
    const observedAt = Number(message.observedAt);
    if (!Number.isFinite(observedAt)) return;
    if (this.lastObservedAt !== null && observedAt >= this.lastObservedAt) {
      for (const speaker of this.activeSpeakers) {
        this.intervals.push({ speaker, startedAt: this.lastObservedAt, endedAt: observedAt });
      }
    }
    this.lastObservedAt = observedAt;
    this.activeSpeakers = Array.isArray(message.activeSpeakers)
      ? message.activeSpeakers.filter((name) => typeof name === "string" && name.trim())
      : [];
    this.state = {
      accessibility: message.accessibility === "granted" ? "granted" : "not-granted",
      meetingOpen: Boolean(message.meetingOpen),
      participants: Array.isArray(message.participants) ? message.participants : [],
      activeSpeakers: this.activeSpeakers,
    };
    const cutoff = observedAt - 4 * 60 * 60 * 1000;
    this.intervals = this.intervals.filter((interval) => interval.endedAt >= cutoff);
    this.onState(this.publicState());
  }

  #fail(error) {
    this.state = {
      ...this.state,
      meetingOpen: false,
      activeSpeakers: [],
      error: error.message,
    };
    this.onState(this.publicState());
  }

  publicState() {
    return {
      ...this.state,
      participants: [...this.state.participants],
      activeSpeakers: [...this.state.activeSpeakers],
    };
  }

  resolveSpeaker({ startedAt, endedAt }) {
    return resolveSpeakerFromIntervals({
      intervals: this.intervals,
      activeSpeakers: this.activeSpeakers,
      lastObservedAt: this.lastObservedAt,
      startedAt,
      endedAt,
    });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

module.exports = {
  ZoomAccessibilityObserver,
  observerPath,
  overlapMilliseconds,
  resolveSpeakerFromIntervals,
  segmentSpeaker,
};
