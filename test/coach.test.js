const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CoachStore, coachStats, combineStats, countFillers } = require("../src/coach");

test("fillers are counted as whole words, not inside others", () => {
  assert.deepEqual(countFillers("Um, so basically I mean the plan, uh, you know, is fine. Umbrella actually."), {
    um: 1,
    basically: 1,
    "i mean": 1,
    uh: 1,
    "you know": 1,
    actually: 1,
  });
  assert.deepEqual(countFillers("the kind of person who said humbug"), { "kind of": 1 });
});

test("untimed transcripts give word-based talk share, fillers and questions", () => {
  const stats = coachStats(
    [
      { speaker: "Alex Rivera", text: "Um, can we ship on Friday? I think we can." },
      { speaker: "Priya Shah", text: "Yes, the pricing copy is final and approved by legal." },
      { speaker: "Alex Rivera", text: "Great. Basically that's everything." },
    ],
    { you: "Alex Rivera" },
  );
  assert.equal(stats.timed, false);
  assert.equal(stats.yourWords, 14);
  assert.equal(stats.totalWords, 24);
  assert.equal(stats.fillers, 2);
  assert.equal(stats.questions, 1);
  assert.equal(stats.wordsPerMinute, null);
  assert.equal(stats.interruptions, null);
  assert.equal(stats.longestMonologueWords, 10);
  assert.equal(coachStats([{ speaker: "Priya Shah", text: "Hello" }], { you: "Alex Rivera" }), null);
});

test("timed turns give pace, time-based talk share, interruptions and the longest stretch", () => {
  const words = (count) => Array.from({ length: count }, () => "word").join(" ");
  const stats = coachStats([
    { you: true, speaker: "Alex", start: 0, end: 30, text: words(75) },
    { you: true, speaker: "Alex", start: 31, end: 40, text: words(25) },
    { you: false, speaker: "Priya", start: 42, end: 72, text: words(80) },
    // Alex starts while Priya is mid-sentence.
    { you: true, speaker: "Alex", start: 60, end: 64, text: "wait, can I add something?" },
  ]);
  assert.equal(stats.timed, true);
  assert.equal(stats.interruptions, 1);
  assert.equal(stats.longestMonologueSeconds, 40);
  assert.equal(stats.longestMonologueWords, 100);
  assert.ok(Math.abs(stats.talkShare - 43 / 73) < 1e-9);
  assert.equal(stats.wordsPerMinute, Math.round(105 / (43 / 60)));
  assert.equal(stats.questions, 1);
});

test("a week combines calls weighted by how much you said", () => {
  const week = combineStats([
    { yourWords: 300, talkShare: 0.6, fillersPer100: 2, wordsPerMinute: 150, questions: 3 },
    { yourWords: 100, talkShare: 0.2, fillersPer100: 6, wordsPerMinute: null, questions: 1 },
    null,
  ]);
  assert.equal(week.calls, 2);
  assert.ok(Math.abs(week.talkShare - 0.5) < 1e-9);
  assert.ok(Math.abs(week.fillersPer100 - 3) < 1e-9);
  assert.equal(week.wordsPerMinute, 150);
  assert.equal(week.questions, 4);
  assert.equal(combineStats([]), null);
});

test("the coach store keeps timed turns and falls back to the transcript", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coach-"));
  const store = new CoachStore(dir);
  const transcript = [{ speaker: "Alex Rivera", text: "Um, hello there everyone." }];
  const fromTranscript = await store.statsFor({ id: "2026-10-01-0900", transcript }, { you: "Alex Rivera" });
  assert.equal(fromTranscript.timed, false);

  await store.save("2026-10-01-0900", [
    { you: true, speaker: "Alex Rivera", text: "Um, hello there everyone, thanks for joining today.", start: 0, end: 25 },
    { you: false, speaker: "Priya Shah", text: "Thanks Alex.", start: 26, end: 27 },
  ]);
  const timed = await store.statsFor({ id: "2026-10-01-0900", transcript }, { you: "Alex Rivera" });
  assert.equal(timed.timed, true);
  assert.equal(timed.wordsPerMinute, Math.round(8 / (25 / 60)));

  // Untimed segments aren't worth a file.
  await store.save("2026-10-01-1000", [{ speaker: "Alex", text: "hi" }]);
  assert.equal(await store.load("2026-10-01-1000"), null);
  await store.remove("2026-10-01-0900");
  assert.equal(await store.load("2026-10-01-0900"), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("practice stats time your speech from first word to last", () => {
  const { practiceStats } = require("../src/coach");
  const rate = 16000;
  // 2 s of silence, 20 s of speech, 3 s of silence.
  const samples = new Float32Array(rate * 25);
  for (let index = rate * 2; index < rate * 22; index += 1) samples[index] = 0.1 * Math.sin(index / 9);
  const words = Array.from({ length: 48 }, () => "word").join(" ");
  const stats = practiceStats(`Um, so ${words}. You know, does that work?`, samples);
  assert.equal(stats.seconds, 20);
  assert.equal(stats.words, 55);
  assert.equal(stats.wordsPerMinute, 165);
  assert.equal(stats.fillers, 2);
  assert.equal(stats.questions, 1);
  assert.equal(practiceStats("", new Float32Array(rate)).wordsPerMinute, null);
});
