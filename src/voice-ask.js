const { EventEmitter } = require("node:events");
const { silenceLimit } = require("./dictation");

const MIN_HOLD_MS = 300;
const TAIL_MS = 200;
const MAX_QUESTION_MS = 60 * 1000;

function rms(samples) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / Math.max(1, samples.length));
}

/**
 * Hold the Ask shortcut, ask a question about your meetings out loud, and the answer appears in a
 * card above the dictation pill, with links to the calls it came from.
 */
class VoiceAskController extends EventEmitter {
  constructor({
    helper,
    overlay,
    card,
    transcribe,
    clean = async (text) => text,
    answer,
    getSettings,
    preflight = () => null,
    isBusy = () => false,
    isLive = () => false,
    now = Date.now,
    timers = globalThis,
  }) {
    super();
    this.helper = helper;
    this.overlay = overlay;
    this.card = card;
    this.transcribe = transcribe;
    this.clean = clean;
    this.answer = answer;
    this.getSettings = getSettings;
    this.preflight = preflight;
    this.isBusy = isBusy;
    this.isLive = isLive;
    this.now = now;
    this.timers = timers;
    this.state = "idle";
    this.session = 0;
    this.pressOpen = false;
    this.startedAt = 0;
    this.limitTimer = null;
    this.abort = null;

    helper.on("ask:down", () => this.handleDown());
    helper.on("ask:up", () => this.handleUp());
    helper.on("ask:cancel", () => {
      if (this.state === "listening" && this.pressOpen) this.cancel();
      this.pressOpen = false;
    });
    helper.on("escape", () => this.handleEscape());
    card.on("closed", () => this.#cardClosed());
  }

  get capturing() {
    return this.state === "listening" || this.state === "transcribing";
  }

  mode() {
    return this.getSettings().dictationMode === "toggle" ? "toggle" : "hold";
  }

  handleDown() {
    if (this.state === "listening" && this.mode() === "toggle") {
      void this.finish();
      return;
    }
    if (this.capturing || this.isBusy()) return;
    this.pressOpen = true;
    void this.start();
  }

  handleUp() {
    const startedThisPress = this.pressOpen;
    this.pressOpen = false;
    if (this.state !== "listening" || this.mode() !== "hold" || !startedThisPress) return;
    if (this.now() - this.startedAt < MIN_HOLD_MS) this.cancel();
    else void this.finish();
  }

  handleEscape() {
    if (this.capturing) this.cancel();
    else if (this.state === "answering" || this.card.visible) this.closeCard();
  }

  #escape(active) {
    this.helper.setDictating(active, "ask");
  }

  async start() {
    const problem = this.preflight();
    if (problem) {
      this.pressOpen = false;
      this.overlay.show("error", problem);
      return;
    }
    // A new question replaces the last answer.
    this.abort?.abort();
    this.card.hide();
    const session = ++this.session;
    this.state = "listening";
    this.startedAt = this.now();
    this.#escape(true);
    // A short delay, so pressing Right ⌘ on the way to a longer chord doesn't flash the pill.
    this.overlayTimer = this.timers.setTimeout(() => this.overlay.show("listening", "Ask your meetings"), 150);
    this.limitTimer = this.timers.setTimeout(() => {
      if (this.session === session && this.state === "listening") void this.finish();
    }, MAX_QUESTION_MS);
    try {
      await this.overlay.startCapture();
    } catch (error) {
      if (this.session !== session) return;
      this.#reset();
      this.overlay.show("error", error.message);
    }
  }

  cancel() {
    this.session += 1;
    this.overlay.cancelCapture();
    this.overlay.hide();
    this.#reset();
  }

  #reset() {
    this.timers.clearTimeout(this.overlayTimer);
    this.timers.clearTimeout(this.limitTimer);
    this.limitTimer = null;
    this.state = "idle";
    this.#escape(this.card.visible);
  }

  async finish() {
    const session = this.session;
    this.timers.clearTimeout(this.limitTimer);
    this.timers.clearTimeout(this.overlayTimer);
    this.state = "transcribing";
    this.overlay.show("transcribing", "Hearing your question");
    let question = "";
    try {
      const samples = await this.overlay.stopCapture({ tailMs: TAIL_MS });
      if (this.session !== session) return;
      if (samples.length < 16000 * 0.4 || rms(samples) < silenceLimit(this.getSettings())) {
        this.#reset();
        this.overlay.show("empty", "No question heard");
        return;
      }
      const text = (await this.transcribe(samples)).replace(/\s+/g, " ").trim();
      question = text ? (await this.clean(text)) || text : "";
    } catch (error) {
      if (this.session !== session) return;
      this.#reset();
      this.overlay.show("error", error.message);
      return;
    }
    if (this.session !== session) return;
    if (!question) {
      this.#reset();
      this.overlay.show("empty", "No question heard");
      return;
    }

    this.overlay.hide();
    this.state = "answering";
    this.#escape(true);
    this.card.show({ kind: this.isLive() ? "live" : "ask", question, text: "", status: "answering" });
    const controller = new AbortController();
    this.abort = controller;
    let text = "";
    try {
      const result = await this.answer({
        question,
        signal: controller.signal,
        onDelta: (delta) => {
          if (this.session !== session) return;
          text += delta;
          this.card.update({ text });
        },
      });
      if (this.session !== session) return;
      this.card.update({ text: result?.text || text || "No answer came back. Try asking again.", status: "done", sources: result?.sources || {} });
    } catch (error) {
      if (this.session !== session || controller.signal.aborted) return;
      this.card.update({ status: "error", error: error.message });
    } finally {
      if (this.session === session) {
        this.abort = null;
        this.state = "idle";
        this.#escape(this.card.visible);
      }
    }
  }

  closeCard() {
    this.abort?.abort();
    this.abort = null;
    this.session += 1;
    this.card.hide();
    if (!this.capturing) this.state = "idle";
    this.#escape(false);
  }

  #cardClosed() {
    if (this.state === "answering") {
      this.abort?.abort();
      this.session += 1;
      this.state = "idle";
    }
    this.#escape(this.capturing);
  }
}

module.exports = { VoiceAskController };
