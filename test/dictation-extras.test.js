const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeSnippets, protectSnippets, restoreSnippets } = require("../src/snippets");
const { cleanDictation } = require("../src/dictation-cleanup");
const { boostQuietSpeech, silenceLimit } = require("../src/dictation");
const { DictationHistory } = require("../src/dictation-history");

const LINK = "https://cal.com/alex/30min";

test("snippets are normalized and deduplicated", () => {
  const snippets = normalizeSnippets([
    { trigger: "  my calendar link ", text: LINK },
    { trigger: "My Calendar Link", text: "other" },
    { trigger: "", text: "x" },
    { trigger: "empty", text: "  " },
  ]);
  assert.deepEqual(snippets, [{ trigger: "my calendar link", text: LINK }]);
});

test("snippet triggers become placeholders and come back as their text", () => {
  const snippets = [
    { trigger: "my link", text: "short" },
    { trigger: "my calendar link", text: LINK },
  ];
  const protectedText = protectSnippets("Here is My Calendar Link, and my link.", snippets);
  assert.equal(protectedText.text, "Here is ⟦1⟧, and ⟦2⟧.");
  assert.equal(restoreSnippets(protectedText.text, protectedText.values), `Here is ${LINK}, and short.`);
  // Only whole words: "my linking" is left alone.
  assert.equal(protectSnippets("my linking", snippets).text, "my linking");
  // A placeholder the AI dropped is added at the end rather than lost.
  assert.equal(restoreSnippets("Here is", protectedText.values.slice(0, 1)), `Here is ${LINK}`);
});

test("light cleanup expands snippets", async () => {
  const result = await cleanDictation("um here is my calendar link", {
    dictationCleanup: "light",
    dictationSnippets: [{ trigger: "my calendar link", text: LINK }],
  });
  assert.equal(result.text, `Here is ${LINK}`);
  assert.equal(result.snippets, 1);
});

test("whisper mode lowers the silence limit and boosts quiet speech", () => {
  assert.ok(silenceLimit({ dictationWhisper: true }) < silenceLimit({}));
  const samples = new Float32Array(16000);
  for (let index = 0; index < samples.length; index += 1) samples[index] = 0.006 * Math.sin(index / 6);
  const boosted = boostQuietSpeech(samples);
  const peak = (values) => values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(peak(boosted) > peak(samples) * 5, "quiet speech gets louder");
  assert.ok(peak(boosted) <= 1, "never clips");
  // Normal speech is left about as it was.
  const loud = samples.map((value) => value * 20);
  assert.ok(peak(boostQuietSpeech(loud)) < peak(loud) * 1.6);
});

test("dictation history saves, searches, removes and clears", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-"));
  const file = path.join(dir, "dictation-history.json");
  const history = new DictationHistory(file);
  await history.add({ text: "Send Priya the deck", app: "Slack", at: 1 });
  const edit = await history.add({ text: "Shorter version", app: "Mail", kind: "edit", instruction: "make it shorter", at: 2 });
  await history.add({ text: "   " });

  let { entries, total } = await history.list();
  assert.equal(total, 2);
  assert.deepEqual(entries.map((entry) => entry.text), ["Shorter version", "Send Priya the deck"]);
  assert.equal((await history.list({ query: "priya slack" })).entries.length, 1);
  assert.equal((await history.list({ query: "shorter" })).entries[0].instruction, "make it shorter");

  // Survives a restart.
  const reopened = new DictationHistory(file);
  assert.equal((await reopened.list()).total, 2);
  await reopened.remove(edit.id);
  ({ entries } = await reopened.list());
  assert.deepEqual(entries.map((entry) => entry.text), ["Send Priya the deck"]);
  await reopened.clear();
  assert.equal((await new DictationHistory(file).list()).total, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
