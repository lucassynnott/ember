const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const packageJson = require("../package.json");

const entitlementPath = path.join(__dirname, "..", "build", "entitlements.mac.plist");

test("signs the app and helpers with microphone audio-input access", () => {
  assert.equal(packageJson.build.mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(packageJson.build.mac.entitlementsInherit, "build/entitlements.mac.plist");

  // Inspect the committed entitlement on every build host without depending on Apple's plutil.
  const xml = require("node:fs").readFileSync(entitlementPath, "utf8");
  assert.match(xml, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/);
});
