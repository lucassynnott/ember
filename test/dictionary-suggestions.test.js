const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DictionarySuggestions, checkMisheard } = require("../src/dictionary-suggestions");
const { normalizeAnalysis } = require("../src/summary");

const transcript = "Alex: We moved the Fonon build to Friday. Priya: and the phone on demo too. Sam: the weather is nice.";

test("keeps only misheard spellings that are really in the transcript", () => {
  const checked = checkMisheard(
    [
      { term: "Phonon", heardAs: ["Fonon", "phone on", "Foenon"] },
      { term: "Okafor", heardAs: ["Okafur"] },
      { term: "weather", heardAs: ["weather"] },
      { term: "a very long made up product name here", heardAs: ["Fonon"] },
    ],
    transcript,
  );
  assert.deepEqual(checked, [{ term: "Phonon", heardAs: ["Fonon", "phone on"] }]);
  assert.deepEqual(checkMisheard(undefined, transcript), []);
});

test("reads the misheard list from the notes JSON", () => {
  const analysis = normalizeAnalysis({ summary: [], misheard: [{ term: "Phonon", heardAs: "Fonon" }, { term: "", heardAs: ["x"] }] });
  assert.deepEqual(analysis.misheard, [{ term: "Phonon", heardAs: ["Fonon"] }]);
});

test("merges repeat suggestions, skips known and dismissed words", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suggest-"));
  const store = new DictionarySuggestions(path.join(dir, "s.json"));
  assert.equal(await store.add([{ term: "Phonon", heardAs: ["Fonon"] }, { term: "Okafor", heardAs: ["Okafur"] }], { meeting: "Standup", dictionary: [{ term: "okafor", heardAs: [] }] }), 1);
  await store.add([{ term: "phonon", heardAs: ["phone on"] }], { meeting: "Pricing review" });
  const [first] = await store.list();
  assert.deepEqual(first, { term: "Phonon", heardAs: ["Fonon", "phone on"], meeting: "Pricing review", calls: 2 });
  await store.take("Phonon", { dismiss: true });
  assert.equal(await store.add([{ term: "Phonon", heardAs: ["Fonon"] }]), 0);
  const reopened = new DictionarySuggestions(path.join(dir, "s.json"));
  assert.deepEqual(await reopened.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
