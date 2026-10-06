const os = require("node:os");
const path = require("node:path");

// Keep existing macOS locations so upgrading never moves a user's library.
function supportDirectory(name = "MeetingNotes", { platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") return paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), name);
  if (platform === "darwin") return paths.join(home, "Library", "Application Support", name);
  return paths.join(env.XDG_CONFIG_HOME || paths.join(home, ".config"), name);
}

function executableName(name, platform = process.platform) {
  return platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
}

function nativeHelperPath(app, helper, { platform = process.platform, resourcesPath = process.resourcesPath } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const name = executableName(`meeting-notes-${helper}`, platform);
  if (app.isPackaged) return paths.join(resourcesPath, "bin", name);
  if (platform === "win32") return paths.join(app.getAppPath(), "native", "windows", "bin", name);
  return paths.join(app.getAppPath(), "native", helper, name);
}

function mediaToolPath(name, { platform = process.platform, resourcesPath = process.resourcesPath, root = path.resolve(__dirname, ".."), exists = require("node:fs").existsSync } = {}) {
  if (platform !== "win32") return name;
  const candidates = [
    ...(resourcesPath ? [path.win32.join(resourcesPath, "bin", executableName(name, platform))] : []),
    path.win32.join(root, "native", "windows", "bin", executableName(name, platform)),
  ];
  return candidates.find(exists) || executableName(name, platform);
}

module.exports = { supportDirectory, executableName, nativeHelperPath, mediaToolPath };
