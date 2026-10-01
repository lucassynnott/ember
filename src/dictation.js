const { EventEmitter } = require("node:events");
const { canPasteInto } = require("./hotkey");

const SAMPLE_RATE = 16000;
const MIN_HOLD_MS = 300;
const OVERLAY_DELAY_MS = 150;
const TAIL_MS = 200;
const MAX_DICTATION_MS = 5 * 60 * 1000;
const CLIPBOARD_RESTORE_MS = 600;

function rms(samples) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length));
}

// Splits long audio into pieces of at most maxSeconds, cutting at the quietest moment
// in the last few seconds of each piece so words aren't split.
function splitForTranscription(samples, { maxSeconds = 28, searchSeconds = 6, frameSeconds = 0.25 } = {}) {
  const maxSamples = Math.floor(maxSeconds * SAMPLE_RATE);
  if (samples.length <= maxSamples) return [samples];
  const frame = Math.floor(frameSeconds * SAMPLE_RATE);
  const pieces = [];
  let start = 0;
  while (samples.length - start > maxSamples) {
    const windowEnd = start + maxSamples;
    const searchStart = Math.max(start + frame, windowEnd - Math.floor(searchSeconds * SAMPLE_RATE));
    let cut = windowEnd;
    let quietest = Infinity;
    for (let position = searchStart; position + frame <= windowEnd; position += Math.floor(frame / 2)) {
      const level = rms(samples.subarray(position, position + frame));
      if (level < quietest) {
        quietest = level;
        cut = position + Math.floor(frame / 2);
      }
    }
    pieces.push(samples.subarray(start, cut));
    start = cut;
  }
  pieces.push(samples.subarray(start));
  return pieces;
}

class DictationController extends EventEmitter {
  constructor({
    helper,
    overlay,
    transcribe,
    clipboard,
    getSettings,
    preflight = () => null,
    now = Date.now,
    timers = globalThis,
  }) {
    super();
    this.helper = helper;
    this.overlay = overlay;
    this.transcribe = transcribe;
    this.clipboard = clipboard;
    this.getSettings = getSettings;
    this.preflight = preflight;
    this.now = now;
    this.timers = timers;
    this.state = "idle";
    this.session = 0;
    this.startedAt = 0;
    this.pressOpen = false;
    this.overlayTimer = null;
    this.limitTimer = null;
    this.lastText = "";

    helper.on("down", () => this.handleDown());
    helper.on("up", () => this.handleUp());
    helper.on("cancel", () => this.handleShortcutCancel());
    helper.on("escape", () => this.handleEscape());
  }

  mode() {
    return this.getSettings().dictationMode === "toggle" ? "toggle" : "hold";
  }

  handleDown() {
    if (this.state === "idle") {
      this.pressOpen = true;
      void this.start();
    } else if (this.state === "listening" && this.mode() === "toggle") {
      void this.finish();
    }
  }

  handleUp() {
    const startedThisPress = this.pressOpen;
    this.pressOpen = false;
    if (this.state !== "listening" || this.mode() !== "hold" || !startedThisPress) return;
    if (this.now() - this.startedAt < MIN_HOLD_MS) this.cancel({ quiet: true });
    else void this.finish();
  }

  handleShortcutCancel() {
    // The hotkey modifier was part of a normal shortcut, so this wasn't a dictation.
    if (this.state === "listening" && this.pressOpen) this.cancel({ quiet: true });
    this.pressOpen = false;
  }

  handleEscape() {
    if (this.state === "listening" || this.state === "transcribing") this.cancel({ quiet: false });
  }

  #clearTimers() {
    this.timers.clearTimeout(this.overlayTimer);
    this.timers.clearTimeout(this.limitTimer);
    this.overlayTimer = null;
    this.limitTimer = null;
  }

  #reset() {
    this.#clearTimers();
    this.state = "idle";
    this.helper.setDictating(false);
  }

  async start() {
    const problem = this.preflight();
    if (problem) {
      this.pressOpen = false;
      this.overlay.show("error", problem);
      return;
    }
    const session = ++this.session;
    this.state = "listening";
    this.startedAt = this.now();
    this.helper.setDictating(true);
    this.overlayTimer = this.timers.setTimeout(() => this.overlay.show("listening"), OVERLAY_DELAY_MS);
    this.limitTimer = this.timers.setTimeout(() => {
      if (this.session === session && this.state === "listening") void this.finish();
    }, MAX_DICTATION_MS);
    try {
      await this.overlay.startCapture();
    } catch (error) {
      if (this.session !== session) return;
      this.#reset();
      this.overlay.show("error", error.message);
      this.emit("error", error);
    }
  }

  cancel({ quiet }) {
    this.session += 1;
    this.#reset();
    this.overlay.cancelCapture();
    if (quiet) this.overlay.hide();
    else this.overlay.show("cancelled", "Cancelled");
  }

  async finish() {
    const session = this.session;
    this.timers.clearTimeout(this.limitTimer);
    this.timers.clearTimeout(this.overlayTimer);
    this.state = "transcribing";
    this.overlay.show("transcribing");
    try {
      const samples = await this.overlay.stopCapture({ tailMs: TAIL_MS });
      if (this.session !== session) return;
      if (samples.length < SAMPLE_RATE * 0.25 || rms(samples) < 0.002) {
        this.#reset();
        this.overlay.show("empty", "No speech heard");
        return;
      }
      const text = (await this.transcribe(samples)).replace(/\s+/g, " ").trim();
      if (this.session !== session) return;
      if (!text) {
        this.#reset();
        this.overlay.show("empty", "No speech heard");
        return;
      }
      await this.deliver(text);
      this.#reset();
    } catch (error) {
      if (this.session !== session) return;
      this.#reset();
      this.overlay.show("error", error.message);
      this.emit("error", error);
    }
  }

  async deliver(text) {
    this.lastText = text;
    const focus = await this.helper.focus().catch(() => null);
    if (canPasteInto(focus)) {
      const snapshot = this.clipboard.snapshot();
      this.clipboard.writeText(text);
      await this.helper.paste();
      if (!this.getSettings().dictationKeepOnClipboard) {
        this.timers.setTimeout(() => {
          // Leave the clipboard alone if something else was copied in the meantime.
          if (this.clipboard.readText() === text) this.clipboard.restore(snapshot);
        }, CLIPBOARD_RESTORE_MS);
      }
      this.overlay.show("pasted", "Pasted");
      this.emit("result", { text, pasted: true, app: focus?.app || "" });
    } else {
      this.clipboard.writeText(text);
      this.overlay.show("copied", "Copied to clipboard");
      this.emit("result", { text, pasted: false, app: focus?.app || "" });
    }
  }
}

module.exports = { DictationController, splitForTranscription, MIN_HOLD_MS };
