const test = require("node:test");
const assert = require("node:assert/strict");

const { alignWords, isFiller, syllables, offsetWords } = require("../src/word-align");

/** Speech-like bursts (a loud tone) between near-silence, at 16 kHz. */
function bursts(spans, length) {
  const rate = 16000;
  const samples = new Float32Array(Math.round(length * rate));
  for (let index = 0; index < samples.length; index += 1) samples[index] = (Math.random() - 0.5) * 0.002;
  for (const [from, to] of spans) {
    for (let index = Math.round(from * rate); index < Math.round(to * rate); index += 1) samples[index] = 0.4 * Math.sin((index / rate) * 2 * Math.PI * 220);
  }
  return samples;
}

test("words are laid over the speech, not the silence around it", () => {
  // Three one-syllable words, spoken at 1–1.4 s, 2–2.4 s and 3–3.4 s of a 5 s line.
  const samples = bursts([[1, 1.4], [2, 2.4], [3, 3.4]], 5);
  const [line] = alignWords(samples, [{ start: 0, end: 5, text: "one two three" }]);
  assert.equal(line.words.length, 3);
  const [one, two, three] = line.words;
  assert.ok(Math.abs(one.start - 1) < 0.08, `one starts at ${one.start}`);
  assert.ok(two.start > 1.3 && two.start < 2.1, `two starts at ${two.start}`);
  assert.ok(three.start > 2.3 && three.start < 3.1, `three starts at ${three.start}`);
  assert.ok(Math.abs(three.end - 3.4) < 0.08, `three ends at ${three.end}`);
  for (const word of line.words) assert.ok(word.end > word.start);
});

test("longer words get more of the speech", () => {
  const samples = bursts([[0.5, 2.5]], 3);
  const [line] = alignWords(samples, [{ start: 0, end: 3, text: "a wonderfully" }])
  const [short, long] = line.words;
  assert.ok(long.end - long.start > (short.end - short.start) * 2);
});

test("fillers are recognised in their usual spellings, and real words aren't", () => {
  for (const word of ["um", "Um,", "uh", "Uhh.", "umm", "er", "erm", "ah", "hmm", "mm"]) assert.ok(isFiller(word), word);
  for (const word of ["umbrella", "a", "her", "I", "mum", "okay", "uhuh!x"]) assert.ok(!isFiller(word), word);
});

test("syllables are counted roughly", () => {
  assert.equal(syllables("cat"), 1);
  assert.equal(syllables("recording"), 3);
  assert.equal(syllables("make"), 1);
  assert.equal(syllables("2026"), 4);
});

test("Parakeet's word times are moved to the piece's place in the recording", () => {
  assert.deepEqual(offsetWords([{ text: " Okay, ", start: 0, end: 0.55 }, { text: "", start: 1, end: 2 }], 12), [{ text: "Okay,", start: 12, end: 12.55 }]);
});
