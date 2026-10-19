const assert = require("node:assert/strict");
const test = require("node:test");

const { ZoomAutoRecordingController } = require("../src/zoom-auto-recording");

// A controller with timers you run by hand, and a recorder that starts and stops when asked.
function setup() {
  const timers = new Map();
  let next = 1;
  const state = { phase: "idle", origin: null, starts: 0, stops: 0 };
  const controller = new ZoomAutoRecordingController({
    getEnabled: () => true,
    getPhase: () => state.phase,
    getRecordingOrigin: () => state.origin,
    onStart: async () => {
      state.starts += 1;
      state.phase = "recording";
      state.origin = "zoom-auto";
      return true;
    },
    onStop: async () => {
      state.stops += 1;
      state.phase = "idle";
      state.origin = null;
    },
    setTimer: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const flush = async () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      await fn();
    }
  };
  return { controller, state, flush };
}

const meeting = { meetingOpen: true, screenSharing: false, participants: ["Alex", "Priya"] };
const gone = { meetingOpen: false, screenSharing: false, participants: [] };

test("a Zoom meeting starts recording and stops when the meeting window closes", async () => {
  const { controller, state, flush } = setup();
  controller.updateZoomState(meeting);
  await flush();
  assert.equal(state.starts, 1);
  controller.updateZoomState(gone);
  await flush();
  assert.equal(state.stops, 1);
});

test("the meeting window vanishing while Zoom still has audio doesn't stop the recording", async () => {
  const { controller, state, flush } = setup();
  controller.updateZoomAudio(true);
  controller.updateZoomState(meeting);
  await flush();
  assert.equal(state.starts, 1);
  // Watching a share: the "Zoom Meeting" window isn't found for a while.
  controller.updateZoomState(gone);
  await flush();
  assert.equal(state.stops, 0);
  assert.equal(controller.snapshot().meetingOpen, true);
  assert.equal(controller.snapshot().source, "Zoom");
  controller.updateZoomState(meeting);
  await flush();
  assert.equal(state.starts, 1);
  // The meeting really ends: the window goes and Zoom lets go of the audio.
  controller.updateZoomState(gone);
  controller.updateZoomAudio(false);
  await flush();
  assert.equal(state.stops, 1);
});

test("Zoom using audio without a meeting seen never starts a recording", async () => {
  const { controller, state, flush } = setup();
  controller.updateZoomAudio(true);
  await flush();
  assert.equal(state.starts, 0);
  assert.equal(controller.snapshot().meetingOpen, false);
});

test("after a meeting ends, Zoom's audio alone doesn't hold the next one open", async () => {
  const { controller, state, flush } = setup();
  controller.updateZoomState(meeting);
  await flush();
  controller.updateZoomState(gone);
  await flush();
  assert.equal(state.stops, 1);
  controller.updateZoomAudio(true);
  await flush();
  assert.equal(controller.snapshot().meetingOpen, false);
  assert.equal(state.starts, 1);
});
