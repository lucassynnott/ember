const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SettingsStore } = require("../src/settings-store");

const safeStorage = { isEncryptionAvailable: () => false };

function store(data) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "destination-test-"));
  const filePath = path.join(directory, "settings.json");
  if (data) fs.writeFileSync(filePath, JSON.stringify(data));
  return new SettingsStore({ filePath, safeStorage, defaults: { notesDir: directory } });
}

test("older settings map the Notion switch onto a notes destination", async () => {
  assert.equal((await store({ notionSyncEnabled: true }).load()).runtime().notesDestination, "both");
  assert.equal((await store({ notionSyncEnabled: false }).load()).runtime().notesDestination, "folder");
  // New installs start with a folder; the welcome window offers Notion.
  assert.equal((await store().load()).runtime().notesDestination, "folder");
});

test("the welcome window shows once for new installs and never for people already set up", async () => {
  const fresh = await store().load();
  assert.equal(fresh.onboardingCompleted(), false);
  assert.equal((await fresh.save({ onboardingCompleted: true })).onboardingCompleted, true);
  assert.equal((await new SettingsStore({ filePath: fresh.filePath, safeStorage, defaults: {} }).load()).onboardingCompleted(), true);

  const existing = await store({ speakerName: "Lucas", notesDestination: "notion" }).load();
  assert.equal(existing.onboardingCompleted(), true);
});

test("choosing a destination keeps Notion sync in step and persists", async () => {
  const settings = await store({ notionSyncEnabled: true }).load();
  let state = await settings.save({ notesDestination: "folder" });
  assert.equal(state.notesDestination, "folder");
  assert.equal(settings.runtime().notionSyncEnabled, false);

  state = await settings.save({ notesDestination: "notion" });
  assert.equal(state.notesDestination, "notion");
  assert.equal(settings.runtime().notionSyncEnabled, true);

  const reloaded = await new SettingsStore({ filePath: settings.filePath, safeStorage, defaults: {} }).load();
  assert.equal(reloaded.runtime().notesDestination, "notion");

  await settings.save({ notesDestination: "nonsense" });
  assert.equal(settings.runtime().notesDestination, "notion");
});

test("a Notion-only meeting skips the Markdown file but keeps the note for a fallback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "destination-note-"));
  const summaryPath = require.resolve("../src/summary");
  const original = require.cache[summaryPath];
  require.cache[summaryPath] = {
    id: summaryPath,
    filename: summaryPath,
    loaded: true,
    exports: {
      summarizeTranscript: async () => ({ summary: ["One"], decisions: [], actionItems: [], provider: "Test" }),
    },
  };
  delete require.cache[require.resolve("../src/process-meeting")];
  try {
    const { processMeeting } = require("../src/process-meeting");
    const meeting = {
      audioPath: path.join(directory, "call.webm"),
      notePath: path.join(directory, "call.md"),
      startedAt: new Date(2026, 9, 1, 11, 0),
      endedAt: new Date(2026, 9, 1, 11, 20),
      settings: {},
      transcript: "Alex: hello",
      transcriptionProvider: "Phonon-2",
      onProgress: () => {},
    };
    const notionOnly = await processMeeting({ ...meeting, writeNote: false });
    assert.equal(notionOnly.noteWritten, false);
    assert.equal(fs.existsSync(meeting.notePath), false);
    assert.match(notionOnly.markdown, /## Full transcript/);

    const folder = await processMeeting(meeting);
    assert.equal(folder.noteWritten, true);
    assert.equal(fs.readFileSync(meeting.notePath, "utf8"), folder.markdown);
  } finally {
    if (original) require.cache[summaryPath] = original;
    else delete require.cache[summaryPath];
    delete require.cache[require.resolve("../src/process-meeting")];
  }
});
