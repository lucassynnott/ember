// macOS prompts are native. Windows prompts are issued by Chromium capture;
// asking Electron for macOS accessibility consent throws on Windows.
function createMediaPermissions({ systemPreferences, shell, capture, platform = process.platform }) {
  const panes = { microphone: "Privacy_Microphone", screen: "Privacy_ScreenCapture", accessibility: "Privacy_Accessibility", camera: "Privacy_Camera" };
  function status(kind, prompt = false) {
    if (kind === "accessibility") return platform === "darwin"
      ? (systemPreferences.isTrustedAccessibilityClient(prompt) ? "granted" : "not-granted") : "granted";
    if (kind === "screen" && platform !== "darwin") return "granted";
    return systemPreferences.getMediaAccessStatus(kind);
  }
  function openSettings(kind) {
    const url = platform === "win32"
      ? ({ microphone: "ms-settings:privacy-microphone", camera: "ms-settings:privacy-webcam", screen: "ms-settings:privacy-screenshot", accessibility: "ms-settings:easeofaccess" })[kind]
      : `x-apple.systempreferences:com.apple.preference.security?${panes[kind]}`;
    if (!url || !panes[kind]) throw new Error(`Unknown permission: ${kind}`);
    return shell.openExternal(url);
  }
  async function request(kind) {
    if (kind === "accessibility") {
      if (platform === "darwin") return systemPreferences.isTrustedAccessibilityClient(true);
      return true;
    }
    if (kind === "screen") {
      await capture("request-screen-permission");
      return true;
    }
    if (!["microphone", "camera"].includes(kind)) throw new Error(`Unknown permission: ${kind}`);
    if (platform === "darwin") return systemPreferences.askForMediaAccess(kind);
    // getMediaAccessStatus is only a snapshot; actually opening a device verifies access.
    await capture(`request-${kind}-permission`);
    return true;
  }
  return { status, request, openSettings };
}
module.exports = { createMediaPermissions };
