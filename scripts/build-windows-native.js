const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const arch = process.argv[2] || "x64";
if (!["x64", "arm64"].includes(arch)) throw new Error("Expected Windows architecture x64 or arm64.");
const local = path.join(root, ".windows-tools", "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
const dotnet = process.env.EMBER_DOTNET || (fs.existsSync(local) ? local : "dotnet");
const result = spawnSync(dotnet, ["publish", path.join(root, "native/windows/Hotkey/Hotkey.csproj"), "-c", "Release", "-r", `win-${arch}`, "-o", path.join(root, "native/windows/bin"), "--nologo"], {
  cwd: root, stdio: "inherit", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
