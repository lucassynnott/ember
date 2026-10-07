const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("recording errors retain their message after being copied across the bridge", () => {
  let bridge;
  const sent = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: { send: (...args) => sent.push(args) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload.js"), "utf8"), {
    require: (name) => { assert.equal(name, "electron"); return electron; }, process,
  });
  // Electron copies error values; the receiving realm need not see an Error instance.
  bridge.failCommand("missing-mic", { name: "NotFoundError", message: "Requested device not found" });
  bridge.failCommand("native-error", new Error("Microphone permission denied"));
  bridge.failCommand("string-error", "System audio is unavailable");
  bridge.failCommand("unknown-error", {});
  assert.deepEqual(sent.map((args) => args[1].error), [
    "Requested device not found", "Microphone permission denied", "System audio is unavailable",
    "Recording failed. Check your microphone and recording permissions.",
  ]);
  assert.ok(sent.every((args) => args[0] === "recorder:command-result"));
});
