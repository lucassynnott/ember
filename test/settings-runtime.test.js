const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SettingsStore } = require("../src/settings-store");
const { getSettings } = require("../src/config");

// The app runs on getSettings(store.runtime()); a field missing from config.js is silently dropped.
test("every setting the store keeps reaches the running app", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-"));
  const safeStorage = { isEncryptionAvailable: () => false };
  const store = await new SettingsStore({ filePath: path.join(dir, "settings.json"), safeStorage, defaults: {} }).load();
  await store.save({ liveNudges: false, liveNudgeFrequency: "rarely", aiProvider: "local", localAiModelId: "gemma-4-e4b", dictationWhisper: true });
  const runtime = store.runtime();
  const settings = getSettings(runtime);
  const ignored = new Set(["whatsNewSeen", "onboardingCompleted"]);
  const missing = Object.keys(runtime).filter((key) => !ignored.has(key) && !(key in settings));
  assert.deepEqual(missing, []);
  assert.equal(settings.liveNudges, false);
  assert.equal(settings.liveNudgeFrequency, "rarely");
  assert.equal(settings.aiProvider, "local");
  assert.equal(settings.localAiModelId, "gemma-4-e4b");
  await fs.rm(dir, { recursive: true, force: true });
});
