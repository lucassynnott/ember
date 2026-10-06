const test = require("node:test");
const assert = require("node:assert/strict");
const { supportDirectory, executableName, nativeHelperPath } = require("../src/platform");
test("Windows stores models and libraries in roaming app data", () => {
  assert.equal(supportDirectory("MeetingNotes", { platform: "win32", home: "C:\\Users\\Lucas", env: { APPDATA: "D:\\Profile\\Roaming" } }), "D:\\Profile\\Roaming\\MeetingNotes");
  assert.equal(supportDirectory("MeetingNotes", { platform: "win32", home: "C:\\Users\\Lucas", env: {} }), "C:\\Users\\Lucas\\AppData\\Roaming\\MeetingNotes");
});
test("macOS upgrade preserves the model directory", () => {
  assert.equal(supportDirectory("MeetingNotes", { platform: "darwin", home: "/Users/lucas", env: {} }), "/Users/lucas/Library/Application Support/MeetingNotes");
});
test("Windows helper lookup uses packaged executable or development output", () => {
  const app = { isPackaged: true, getAppPath: () => "C:\\Ember" };
  assert.equal(nativeHelperPath(app, "hotkey", { platform: "win32", resourcesPath: "C:\\Ember\\resources" }), "C:\\Ember\\resources\\bin\\meeting-notes-hotkey.exe");
  app.isPackaged = false;
  assert.equal(nativeHelperPath(app, "hotkey", { platform: "win32" }), "C:\\Ember\\native\\windows\\bin\\meeting-notes-hotkey.exe");
  assert.equal(executableName("worker.exe", "win32"), "worker.exe");
});

test("Windows media tools prefer verified bundled binaries and retain PATH fallback", () => {
  const { mediaToolPath } = require("../src/platform");
  const options = { platform: "win32", resourcesPath: "C:\\Ember\\resources", root: "C:\\Code\\Ember" };
  assert.equal(mediaToolPath("ffmpeg", { ...options, exists: (file) => file === "C:\\Ember\\resources\\bin\\ffmpeg.exe" }), "C:\\Ember\\resources\\bin\\ffmpeg.exe");
  assert.equal(mediaToolPath("ffmpeg", { ...options, exists: (file) => file === "C:\\Code\\Ember\\native\\windows\\bin\\ffmpeg.exe" }), "C:\\Code\\Ember\\native\\windows\\bin\\ffmpeg.exe");
  assert.equal(mediaToolPath("ffmpeg", { ...options, exists: () => false }), "ffmpeg.exe");
  assert.equal(mediaToolPath("ffmpeg", { platform: "darwin" }), "ffmpeg");
});
