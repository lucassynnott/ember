const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { formatTranscript, helperPaths, segmentWords } = require("../src/media-transcribe");

const word = (text, start, end) => ({ text, start, end });
const WORDS = [
  word("Hi", 0, 0.3),
  word("team,", 0.3, 0.8),
  word("welcome", 0.8, 1.2),
  word("back.", 1.2, 1.6),
  word("Today", 1.7, 2),
  word("we", 2, 2.2),
  word("ship.", 2.2, 2.6),
  word("Questions?", 4, 4.6),
];

test("segments break after sentences, at pauses and when long", () => {
  const segments = segmentWords(WORDS);
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ["Hi team, welcome back.", "Today we ship.", "Questions?"],
  );
  assert.equal(segments[1].start, 1.7);
  assert.equal(segments[1].end, 2.6);
  assert.deepEqual(segments.map((segment) => segment.id), [0, 1, 2]);

  const long = Array.from({ length: 40 }, (_, index) => word(`w${index}`, index * 0.3, index * 0.3 + 0.25));
  assert.ok(segmentWords(long).every((segment) => segment.words.length <= 28 && segment.end - segment.start <= 10.5));
  assert.deepEqual(segmentWords([]), []);
});

test("a short sentence doesn't end a segment on its own", () => {
  const segments = segmentWords([word("Yes.", 0, 0.4), word("Let's", 0.45, 0.7), word("go.", 0.7, 1)]);
  assert.equal(segments.length, 1);
});

const RESULT = { source: "/Users/someone/Movies/Demo.mp4", duration: 5, model: "parakeet-tdt-0.6b-v3-int8", segments: segmentWords(WORDS) };

test("JSON is valid, Whisper-style, with every word timed", () => {
  const data = JSON.parse(formatTranscript(RESULT, "json"));
  assert.equal(data.source, "Demo.mp4");
  assert.equal(data.text, "Hi team, welcome back. Today we ship. Questions?");
  assert.equal(data.segments.length, 3);
  assert.deepEqual(data.segments[0].words[1], { word: "team,", start: 0.3, end: 0.8 });
  assert.equal(data.segments.flatMap((segment) => segment.words).length, WORDS.length);
});

test("the word list has one word a line, segments apart", () => {
  const text = formatTranscript(RESULT, "words");
  const lines = text.trim().split("\n");
  assert.match(lines[0], /^# Demo\.mp4/);
  assert.equal(lines[1], "0.00 0.30 Hi");
  assert.ok(text.includes("1.60 back.\n\n1.70 2.00 Today"));
});

test("subtitles and text", () => {
  assert.equal(formatTranscript(RESULT, "srt").split("\n").slice(0, 3).join("\n"), "1\n00:00:00,000 --> 00:00:01,600\nHi team, welcome back.");
  assert.match(formatTranscript(RESULT, "vtt"), /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.600\nHi team/);
  assert.equal(formatTranscript(RESULT, "txt").split("\n")[2], "[00:04] Questions?");
  assert.throws(() => formatTranscript(RESULT, "docx"), /Unknown format/);
});

test("helpers come from the app bundle or a checkout", () => {
  const bundled = helperPaths("/Applications/Ember.app/Contents/Resources/app.asar");
  assert.equal(bundled.record, "/Applications/Ember.app/Contents/Resources/bin/meeting-notes-record");
  assert.equal(bundled.parakeet, "/Applications/Ember.app/Contents/Resources/bin/meeting-notes-parakeet-worker");
  const checkout = helperPaths("/code/ember");
  assert.equal(checkout.record, path.join("/code/ember", "native", "record", "meeting-notes-record"));
});

test("the CLI saves several files to a folder, not one --out file", async () => {
  const { run } = require("../src/cli");
  const file = __filename;
  await assert.rejects(run(["transcribe", file, file, "--out", "x.json"], { tools: {}, out: () => {} }), /--out is for one file/);
  await assert.rejects(run(["transcribe", file, "--format", "docx"], { tools: {}, out: () => {} }), /Unknown format/);
});
