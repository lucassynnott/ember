const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SettingsStore } = require("../src/settings-store");
const { summarizeTranscript } = require("../src/summary");
const { resolveSpeakerFromIntervals, segmentSpeaker } = require("../src/zoom-accessibility");
const { ZoomAutoRecordingController } = require("../src/zoom-auto-recording");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => value.toString("utf8").replace(/^sealed:/, ""),
  };
}

test("persists user settings while keeping the OpenRouter key private", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-notes-settings-"));
  const filePath = path.join(directory, "settings.json");
  const store = new SettingsStore({
    filePath,
    safeStorage: fakeSafeStorage(),
    defaults: { notesDir: "/default", openRouterModel: "openai/gpt-5.6-luna" },
  });
  await store.load();
  const publicState = await store.save({
    notesDir: path.join(directory, "notes"),
    speakerName: "Lucas",
    autoRecordZoomMeetings: true,
    transcriptionModelId: "parakeet:/models/v3",
    openRouterModel: "openai/gpt-5.6-luna",
    openRouterKey: "secret-key",
  });

  assert.equal(publicState.hasOpenRouterKey, true);
  assert.equal(publicState.speakerName, "Lucas");
  assert.equal(publicState.autoRecordZoomMeetings, true);
  assert.equal(Object.hasOwn(publicState, "openRouterKey"), false);
  assert.doesNotMatch(await fs.readFile(filePath, "utf8"), /secret-key/);

  const reloaded = new SettingsStore({ filePath, safeStorage: fakeSafeStorage() });
  await reloaded.load();
  assert.equal(reloaded.runtime().openRouterKey, "secret-key");
  assert.equal(reloaded.runtime().speakerName, "Lucas");
  assert.equal(reloaded.runtime().autoRecordZoomMeetings, true);
  await fs.rm(directory, { recursive: true, force: true });
});

test("generates structured notes through the selected OpenRouter model", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (endpoint, options) => {
    request = { endpoint, payload: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: ["One", "Two", "Three", "Four", "Five"],
                decisions: ["Ship Friday"],
                actionItems: [{ owner: "Lucas", task: "Send notes" }],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const result = await summarizeTranscript("Lucas: Ship Friday.", {
      openRouterKey: "test-key",
      openRouterModel: "openai/gpt-5.6-luna",
    });
    assert.equal(request.endpoint, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(request.payload.model, "openai/gpt-5.6-luna");
    assert.deepEqual(result.decisions, ["Ship Friday"]);
    assert.equal(result.provider, "OpenRouter (openai/gpt-5.6-luna)");
  } finally {
    global.fetch = originalFetch;
  }
});

test("attributes a remote transcript segment only when one Zoom speaker dominates", () => {
  const intervals = [
    { speaker: "Alice Chen", startedAt: 1_000, endedAt: 3_000 },
    { speaker: "Bob Smith", startedAt: 3_400, endedAt: 5_000 },
  ];
  assert.equal(
    resolveSpeakerFromIntervals({ intervals, startedAt: 1_400, endedAt: 2_500, now: 6_000 }),
    "Alice Chen",
  );
  assert.equal(
    resolveSpeakerFromIntervals({
      intervals: [
        { speaker: "Alice Chen", startedAt: 1_000, endedAt: 2_000 },
        { speaker: "Bob Smith", startedAt: 1_000, endedAt: 2_000 },
      ],
      startedAt: 1_100,
      endedAt: 1_900,
      now: 2_000,
    }),
    null,
  );
});

test("keeps microphone identity and a conservative remote fallback", () => {
  assert.equal(
    segmentSpeaker({
      source: "microphone",
      configuredSpeakerName: "Lucas",
      zoomSpeaker: "Alice Chen",
    }),
    "Lucas",
  );
  assert.equal(
    segmentSpeaker({ source: "system", configuredSpeakerName: "Lucas", zoomSpeaker: null }),
    "Remote speaker",
  );
  assert.equal(
    segmentSpeaker({
      source: "system",
      configuredSpeakerName: "Lucas",
      zoomSpeaker: "Alice Chen",
    }),
    "Alice Chen",
  );
});

function fakeScheduler() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    next() {
      return tasks.values().next().value || null;
    },
    get size() {
      return tasks.size;
    },
    async runNext() {
      const entry = tasks.entries().next().value;
      assert.ok(entry, "expected a scheduled timer");
      tasks.delete(entry[0]);
      entry[1].callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("starts and stops an automatic recording around a stable Zoom meeting", async () => {
  const scheduler = fakeScheduler();
  let phase = "idle";
  let recordingOrigin = null;
  let starts = 0;
  let stops = 0;
  const controller = new ZoomAutoRecordingController({
    getEnabled: () => true,
    getPhase: () => phase,
    getRecordingOrigin: () => recordingOrigin,
    onStart: async () => {
      starts += 1;
      phase = "recording";
      recordingOrigin = "zoom-auto";
      return true;
    },
    onStop: async () => {
      stops += 1;
      phase = "idle";
      recordingOrigin = null;
    },
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  controller.updateZoomState({ meetingOpen: true, participants: [] });
  assert.equal(scheduler.size, 0, "a Zoom window without participants is not a meeting");

  controller.updateZoomState({ meetingOpen: true, participants: ["Alice"] });
  assert.equal(scheduler.next().delay, 2_500);
  assert.equal(controller.snapshot().pending, "start");
  await scheduler.runNext();
  assert.equal(starts, 1);
  assert.equal(recordingOrigin, "zoom-auto");

  controller.updateZoomState({ meetingOpen: true, participants: [] });
  assert.equal(scheduler.size, 0, "temporary participant-tree loss must not end the meeting");
  controller.updateZoomState({ meetingOpen: false, screenSharing: true, participants: [] });
  assert.equal(scheduler.size, 0, "screen sharing must preserve the current recording");
  assert.equal(controller.snapshot().meetingOpen, true);
  controller.updateZoomState({ meetingOpen: true, screenSharing: false, participants: ["Alice"] });

  controller.updateZoomState({ meetingOpen: false, participants: [] });
  assert.equal(scheduler.next().delay, 5_000);
  controller.updateZoomState({ meetingOpen: true, participants: ["Alice"] });
  assert.equal(scheduler.size, 0, "a reconnect inside the grace period must not stop recording");
  assert.equal(stops, 0);

  controller.updateZoomState({ meetingOpen: false, participants: [] });
  await scheduler.runNext();
  assert.equal(stops, 1);
  assert.equal(phase, "idle");
});

test("manual Stop suppresses automatic restart until the current meeting ends", () => {
  const scheduler = fakeScheduler();
  let phase = "recording";
  let recordingOrigin = "zoom-auto";
  const controller = new ZoomAutoRecordingController({
    getEnabled: () => true,
    getPhase: () => phase,
    getRecordingOrigin: () => recordingOrigin,
    onStart: async () => true,
    onStop: async () => {},
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  controller.updateZoomState({ meetingOpen: true, participants: ["Alice"] });
  controller.manualStopRequested();
  phase = "idle";
  recordingOrigin = null;
  controller.recordingStateChanged();
  assert.equal(controller.snapshot().suppressed, true);
  assert.equal(scheduler.size, 0);
  controller.updateZoomState({ meetingOpen: true, participants: [] });
  assert.equal(controller.snapshot().suppressed, true);

  controller.updateZoomState({ meetingOpen: false, participants: [] });
  controller.updateZoomState({ meetingOpen: true, participants: ["Alice"] });
  assert.equal(controller.snapshot().suppressed, false);
  assert.equal(scheduler.next().delay, 2_500);
});
