const test = require("node:test");
const assert = require("node:assert/strict");
const { createMediaPermissions } = require("../src/media-permissions");
function fixture(platform, capture = async () => {}) {
  const calls = [];
  const permissions = createMediaPermissions({
    platform,
    systemPreferences: {
      getMediaAccessStatus: (kind) => { calls.push(["status", kind]); return "not-determined"; },
      askForMediaAccess: async (kind) => { assert.equal(platform, "darwin"); calls.push(["native-prompt", kind]); return true; },
      isTrustedAccessibilityClient: (prompt) => { assert.equal(platform, "darwin"); calls.push(["accessibility", prompt]); return false; },
    },
    shell: { openExternal: async (url) => calls.push(["settings", url]) },
    capture: async (action) => { calls.push(["capture", action]); await capture(action); },
  });
  return { permissions, calls };
}
test("Windows microphone/camera requests use real capture rather than macOS APIs", async () => {
  const { permissions, calls } = fixture("win32");
  assert.equal(await permissions.request("microphone"), true);
  assert.equal(await permissions.request("camera"), true);
  assert.equal(await permissions.request("accessibility"), true);
  assert.equal(permissions.status("accessibility"), "granted");
  assert.deepEqual(calls, [["capture", "request-microphone-permission"], ["capture", "request-camera-permission"]]);
});
test("Windows denial propagates and settings use Windows privacy pages", async () => {
  const { permissions, calls } = fixture("win32", async () => { throw new Error("Permission denied"); });
  await assert.rejects(permissions.request("microphone"), /Permission denied/);
  await permissions.openSettings("microphone");
  await permissions.openSettings("camera");
  assert.deepEqual(calls.slice(1), [["settings", "ms-settings:privacy-microphone"], ["settings", "ms-settings:privacy-webcam"]]);
});
test("screen access is verified with capture on both platforms", async () => {
  for (const platform of ["darwin", "win32"]) {
    const { permissions, calls } = fixture(platform);
    assert.equal(await permissions.request("screen"), true);
    assert.deepEqual(calls, [["capture", "request-screen-permission"]]);
  }
});
test("macOS retains native prompts and explicit accessibility prompting", async () => {
  const { permissions, calls } = fixture("darwin");
  await permissions.request("microphone");
  await permissions.request("camera");
  assert.equal(permissions.status("accessibility", true), "not-granted");
  await permissions.openSettings("screen");
  assert.deepEqual(calls, [["native-prompt", "microphone"], ["native-prompt", "camera"], ["accessibility", true], ["settings", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]]);
});
test("unknown permission names fail before opening external URLs", async () => {
  const { permissions, calls } = fixture("win32");
  assert.throws(() => permissions.openSettings("invalid"), /Unknown permission/);
  await assert.rejects(permissions.request("invalid"), /Unknown permission/);
  assert.deepEqual(calls, []);
});
