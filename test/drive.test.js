const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DriveService, safeName } = require("../src/drive");

test("names are made safe for any drive", () => {
  assert.equal(safeName('Q3: plan / "final"?'), "Q3- plan - -final--");
  assert.equal(safeName("   "), "Untitled");
  assert.equal(safeName("a".repeat(200)).length, 80);
});

test("there's no drive without its helper app", () => {
  assert.equal(DriveService.supported("/nonexistent/Ember Drive.app"), false);
});

test("backups copy new and changed files into the Ember folder, and skip unchanged ones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  const mount = path.join(root, "mount");
  fs.mkdirSync(mount);
  const file = path.join(root, "note.md");
  fs.writeFileSync(file, "first");
  const drive = new DriveService({ helperApp: "/nonexistent" });
  drive.status = { supported: true, mounted: true, path: mount };
  assert.equal(await drive.backUp(file, "Notes/note.md"), true);
  assert.equal(fs.readFileSync(path.join(mount, "Ember", "Notes", "note.md"), "utf8"), "first");
  assert.equal(await drive.backUp(file, "Notes/note.md"), false);
  fs.writeFileSync(file, "second, longer");
  assert.equal(await drive.backUp(file, "Notes/note.md"), true);
  assert.equal(fs.readFileSync(path.join(mount, "Ember", "Notes", "note.md"), "utf8"), "second, longer");
  // Not mounted: nothing is copied.
  drive.status = { supported: true, mounted: false };
  assert.equal(await drive.backUp(file, "Notes/other.md"), false);
  fs.rmSync(root, { recursive: true, force: true });
});
