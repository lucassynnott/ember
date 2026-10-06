const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  RecordingsStore,
  formatClock,
  newRecordingId,
  parseWriteUp,
  timedSegments,
  wavToSamples,
  writeUpPrompt,
} = require("../src/recordings");
const { encodeWav } = require("../src/phonon-transcription");

test("recording ids are dated and never collide", () => {
  const date = new Date(2026, 9, 5, 9, 4, 7);
  assert.equal(newRecordingId(date), "20261005-090407");
  const taken = new Set(["20261005-090407", "20261005-090407-2"]);
  assert.equal(newRecordingId(date, (id) => taken.has(id)), "20261005-090407-3");
});

test("clock times", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(75.9), "1:15");
  assert.equal(formatClock(3725), "1:02:05");
});

test("reads the WAV the record helper writes", () => {
  const input = new Float32Array([0, 0.5, -0.5, 0.25]);
  const { samples, rate } = wavToSamples(Buffer.from(encodeWav(input, 16000)));
  assert.equal(rate, 16000);
  assert.equal(samples.length, 4);
  assert.ok(Math.abs(samples[1] - 0.5) < 0.001 && Math.abs(samples[2] + 0.5) < 0.001);
  assert.throws(() => wavToSamples(Buffer.from("nope")));
});

test("pieces keep their place in the recording", () => {
  const whole = new Float32Array(16000 * 10);
  const pieces = [whole.subarray(0, 16000 * 4), whole.subarray(16000 * 4, 16000 * 7), whole.subarray(16000 * 7)];
  const segments = timedSegments(whole, pieces, [" Hello there ", "", "And this"]);
  assert.deepEqual(segments, [
    { start: 0, end: 4, text: "Hello there" },
    { start: 7, end: 10, text: "And this" },
  ]);
});

test("the write-up prompt shows times", () => {
  const prompt = writeUpPrompt([{ start: 65, end: 70, text: "Now the pricing page" }], 120);
  assert.match(prompt, /Length: 2:00/);
  assert.match(prompt, /\[1:05\] Now the pricing page/);
});

test("write-ups are cleaned and chapters kept in order", () => {
  const result = parseWriteUp(
    {
      title: "“Walkthrough of the new onboarding.”",
      summary: "  Shows   the flow. ",
      chapters: [
        { start: 3, title: "Intro" },
        { start: 4, title: "Too close" },
        { start: 60, title: "Pricing" },
        { start: 30, title: "Out of order" },
        { start: 500, title: "Past the end" },
        { start: "x", title: "Bad" },
      ],
    },
    200,
  );
  assert.equal(result.title, "Walkthrough of the new onboarding");
  assert.equal(result.summary, "Shows the flow.");
  assert.deepEqual(result.chapters, [
    { start: 0, title: "Intro" },
    { start: 60, title: "Pricing" },
  ]);
  assert.deepEqual(parseWriteUp({ title: "Short", chapters: [{ start: 0, title: "A" }, { start: 30, title: "B" }] }, 60).chapters, []);
  assert.deepEqual(parseWriteUp(null, 10), { title: "", summary: "", chapters: [] });
});

test("the store lists, searches, updates and removes recordings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-recordings-"));
  try {
    const store = new RecordingsStore({ dir });
    await store.add("20261005-090000", { createdAt: "2026-10-05T09:00:00.000Z", duration: 30, transcript: [{ start: 0, end: 5, text: "the pricing page" }] });
    await store.add("20261005-100000", { createdAt: "2026-10-05T10:00:00.000Z", duration: 40, status: "processing", title: "Bug repro" });
    assert.deepEqual(store.list().map((item) => item.id), ["20261005-100000", "20261005-090000"]);
    assert.deepEqual(store.list("pricing").map((item) => item.id), ["20261005-090000"]);
    assert.match(store.list()[1].title, /^Recording, 5 Oct at/);
    assert.throws(() => store.folder("../etc"));

    // Reopened: a write-up cut short by quitting is picked up again.
    const reopened = new RecordingsStore({ dir });
    assert.equal(reopened.get("20261005-100000").status, "pending");
    await reopened.update("20261005-090000", { title: "Pricing walkthrough", status: "ready" });
    assert.equal(reopened.detail("20261005-090000").transcript.length, 1);

    fs.mkdirSync(reopened.folder("20261005-090000"), { recursive: true });
    await reopened.remove("20261005-090000");
    assert.equal(fs.existsSync(path.join(dir, "20261005-090000")), false);
    assert.equal(new RecordingsStore({ dir }).list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
