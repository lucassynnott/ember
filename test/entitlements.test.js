const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const packageJson = require("../package.json");

const entitlementPath = path.join(__dirname, "..", "build", "entitlements.mac.plist");

test("signs the app and helpers with microphone audio-input access", () => {
  assert.equal(packageJson.build.mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(packageJson.build.mac.entitlementsInherit, "build/entitlements.mac.plist");

  const entitlements = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", entitlementPath], {
      encoding: "utf8",
    }),
  );

  assert.equal(entitlements["com.apple.security.device.audio-input"], true);
});
