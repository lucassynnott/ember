const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ClipboardHistory } = require("../src/clipboard-history");

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
  let now = 1_000_000_000_000;
  const history = new ClipboardHistory(path.join(dir, "clipboard-history.json"), { now: () => now });
  return { dir, history, tick: (ms) => (now += ms) };
}

test("keeps copies newest first, moves repeats to the top and tells links from text", async () => {
  const { dir, history, tick } = store();
  await history.add({ text: "Hi Dana, quick recap below", app: "Mail" });
  tick(1000);
  await history.add({ text: "https://example.com/pricing", app: "Safari" });
  tick(1000);
  await history.add({ text: "Hi Dana, quick recap below", app: "Slack" });
  const { entries } = await history.list();
  assert.deepEqual(entries.map((entry) => [entry.text, entry.kind, entry.app]), [
    ["Hi Dana, quick recap below", "text", "Slack"],
    ["https://example.com/pricing", "link", "Safari"],
  ]);
  assert.equal((await history.list({ query: "safari" })).entries.length, 1);
  assert.equal((await history.list({ kind: "link" })).entries.length, 1);
  assert.equal(await history.add({ text: "   " }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pinned items stay first and survive pruning and clearing", async () => {
  const { dir, history, tick } = store();
  const old = await history.add({ text: "my calendar link https://cal.example/alex" });
  await history.pin(old.id, true);
  await history.add({ text: "old note" });
  tick(40 * 24 * 60 * 60 * 1000);
  await history.add({ text: "fresh note" });
  assert.equal(await history.prune(30), 1);
  assert.deepEqual((await history.list()).entries.map((entry) => entry.text), ["my calendar link https://cal.example/alex", "fresh note"]);
  await history.clear();
  assert.deepEqual((await history.list()).entries.map((entry) => entry.text), ["my calendar link https://cal.example/alex"]);
  assert.equal((await history.list({ kind: "pinned" })).entries.length, 1);
  await history.clear({ includePinned: true });
  assert.equal((await history.list()).total, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stores images as files, de-duplicates them and deletes the file with the entry", async () => {
  const { dir, history } = store();
  const png = Buffer.from("89504e470d0a1a0a-fake-png");
  const first = await history.addImage({ png, width: 10, height: 10, app: "Preview" });
  const again = await history.addImage({ png, app: "Finder" });
  assert.equal(first.id, again.id);
  const file = history.imagePath(first);
  assert.ok(fs.existsSync(file));
  // Windows uses the user profile directory ACL instead of POSIX mode bits.
  if (process.platform !== "win32") assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  await history.remove(first.id);
  assert.ok(!fs.existsSync(file));
  const reopened = new ClipboardHistory(path.join(dir, "clipboard-history.json"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await reopened.list()).total, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
