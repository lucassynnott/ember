const DEFAULT_START_DELAY_MS = 2_500;
const DEFAULT_END_DELAY_MS = 5_000;
// Other apps can let go of the microphone for a moment (switching devices, rejoining), so wait longer.
const CALL_END_DELAY_MS = 15_000;

function isActiveZoomMeeting(state) {
  return Boolean(state?.screenSharing || (state?.meetingOpen && state?.participants?.length));
}

class ZoomAutoRecordingController {
  constructor({
    getEnabled,
    getPhase,
    getRecordingOrigin,
    onStart,
    onStop,
    onState = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    startDelayMs = DEFAULT_START_DELAY_MS,
    endDelayMs = DEFAULT_END_DELAY_MS,
    callEndDelayMs = CALL_END_DELAY_MS,
  }) {
    this.getEnabled = getEnabled;
    this.getPhase = getPhase;
    this.getRecordingOrigin = getRecordingOrigin;
    this.onStart = onStart;
    this.onStop = onStop;
    this.onState = onState;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.startDelayMs = startDelayMs;
    this.endDelayMs = endDelayMs;
    this.callEndDelayMs = callEndDelayMs;
    this.zoom = { open: false, active: false };
    this.call = null;
    this.lastSource = null;
    this.meetingOpen = false;
    this.meetingActive = false;
    this.suppressed = false;
    this.startTimer = null;
    this.stopTimer = null;
    this.startInFlight = false;
    this.stopInFlight = false;
  }

  snapshot() {
    return {
      enabled: Boolean(this.getEnabled()),
      meetingOpen: this.meetingOpen,
      meetingActive: this.meetingActive,
      source: this.source(),
      pending:
        this.startTimer || this.startInFlight
          ? "start"
          : this.stopTimer || this.stopInFlight
            ? "stop"
            : null,
      suppressed: this.suppressed,
      recordingOrigin: this.getRecordingOrigin() || null,
    };
  }

  publish() {
    this.onState(this.snapshot());
  }

  // Which app the current or most recent meeting is in, e.g. "Zoom" or "Google Meet".
  source() {
    if (this.zoom.open) return "Zoom";
    return this.call?.app || this.lastSource;
  }

  #combine() {
    this.meetingOpen = Boolean(this.zoom.open || this.call?.live);
    this.meetingActive = Boolean(this.zoom.active || this.call?.active);
    if (this.meetingOpen) this.lastSource = this.source();
    if (!this.meetingOpen) this.suppressed = false;
    this.reconcile();
  }

  updateZoomState(state) {
    this.zoom = { open: Boolean(state?.meetingOpen || state?.screenSharing), active: isActiveZoomMeeting(state) };
    this.#combine();
  }

  // From CallTracker: a call in another app, or null when there isn't one.
  updateCallState(call) {
    this.call = call && call.live ? call : null;
    this.#combine();
  }

  settingsChanged() {
    this.reconcile();
  }

  recordingStateChanged() {
    this.reconcile();
  }
  manualStartRequested() {
    this.cancelStart();
    this.publish();
  }

  manualStopRequested() {
    if (this.meetingOpen) this.suppressed = true;
    this.cancelStart();
    this.cancelStop();
    this.publish();
  }

  destroy() {
    this.cancelStart();
    this.cancelStop();
  }

  cancelStart() {
    if (!this.startTimer) return;
    this.clearTimer(this.startTimer);
    this.startTimer = null;
  }

  cancelStop() {
    if (!this.stopTimer) return;
    this.clearTimer(this.stopTimer);
    this.stopTimer = null;
  }

  reconcile() {
    if (!this.getEnabled() || this.suppressed) {
      this.cancelStart();
      this.cancelStop();
      this.publish();
      return;
    }

    const phase = this.getPhase();
    if (this.meetingOpen) {
      this.cancelStop();
      if (!this.meetingActive || phase !== "idle") this.cancelStart();
      if (this.meetingActive && phase === "idle" && !this.startTimer && !this.startInFlight) {
        this.startTimer = this.setTimer(() => void this.runStart(), this.startDelayMs);
      }
    } else {
      this.cancelStart();
      if (
        phase === "recording" &&
        this.getRecordingOrigin() === "zoom-auto" &&
        !this.stopTimer &&
        !this.stopInFlight
      ) {
        const delay = this.lastSource && this.lastSource !== "Zoom" ? this.callEndDelayMs : this.endDelayMs;
        this.stopTimer = this.setTimer(() => void this.runStop(), delay);
      } else if (phase !== "recording" || this.getRecordingOrigin() !== "zoom-auto") {
        this.cancelStop();
      }
    }
    this.publish();
  }

  async runStart() {
    this.startTimer = null;
    if (
      !this.getEnabled() ||
      this.suppressed ||
      !this.meetingActive ||
      this.getPhase() !== "idle"
    ) {
      this.reconcile();
      return;
    }

    this.startInFlight = true;
    this.publish();
    try {
      const started = await this.onStart();
      if (started === false) this.suppressed = true;
    } catch {
      this.suppressed = true;
    } finally {
      this.startInFlight = false;
      this.reconcile();
    }
  }

  async runStop() {
    this.stopTimer = null;
    if (
      !this.getEnabled() ||
      this.meetingOpen ||
      this.getPhase() !== "recording" ||
      this.getRecordingOrigin() !== "zoom-auto"
    ) {
      this.reconcile();
      return;
    }

    this.stopInFlight = true;
    this.publish();
    try {
      await this.onStop();
    } finally {
      this.stopInFlight = false;
      this.reconcile();
    }
  }
}

module.exports = {
  CALL_END_DELAY_MS,
  DEFAULT_END_DELAY_MS,
  DEFAULT_START_DELAY_MS,
  isActiveZoomMeeting,
  ZoomAutoRecordingController,
};
