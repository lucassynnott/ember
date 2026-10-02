const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SpeakerTracker, VoiceBank, normalize } = require("../src/speakers");

// Synthetic voice prints: a random direction per person (seeded), plus a little noise per stretch.
function random(seed) {
  let state = seed * 2654435761;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
function voice(seed) {
  const next = random(seed);
  return Array.from({ length: 64 }, next);
}
function sample(base, noise = 0.15, salt = 0) {
  const next = random(1000 + salt);
  return base.map((value) => value + noise * next());
}

test("groups voice prints into speakers and tidies them after the call", () => {
  const priya = voice(1);
  const sam = voice(2);
  const tracker = new SpeakerTracker();
  const live = [
    tracker.add(sample(priya, 0.1, 1), 5),
    tracker.add(sample(sam, 0.1, 2), 6),
    tracker.add(sample(priya, 0.1, 3), 4),
    tracker.add(sample(voice(3), 0.1, 4), 1.5),
    tracker.add(sample(sam, 0.1, 5), 0.4),
  ];
  assert.deepEqual(live, ["Speaker 1", "Speaker 2", "Speaker 1", "Speaker 3", null]);

  const { labels, speakers } = tracker.finalize([{ id: "v1", name: "Sam Okafor", embedding: normalize(sam) }]);
  assert.equal(labels["Speaker 1"], "Speaker 1");
  assert.equal(labels["Speaker 2"], "Sam Okafor", "a known voice gets its name");
  assert.ok(["Speaker 1", "Sam Okafor"].includes(labels["Speaker 3"]), "a 1.5 s scrap joins a real speaker");
  assert.deepEqual(Object.keys(speakers).sort(), ["Sam Okafor", "Speaker 1"]);
  assert.equal(speakers["Sam Okafor"].known, true);
});

test("an unfamiliar voice is never given a known name", () => {
  const tracker = new SpeakerTracker();
  tracker.add(voice(7), 10);
  const { labels } = tracker.finalize([{ id: "v1", name: "Harry", embedding: normalize(voice(8)) }]);
  assert.equal(labels["Speaker 1"], "Speaker 1");
});

test("remembers named voices on this Mac and forgets them on request", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voices-"));
  const file = path.join(directory, "voices.json");
  const bank = new VoiceBank(file);
  assert.equal(await bank.learn("Harry", voice(1), 3), null, "too little speech to learn from");
  const harry = await bank.learn("  Harry  ", voice(1), 20);
  await bank.learn("harry", sample(voice(1)), 10);
  const reloaded = new VoiceBank(file);
  const voices = await reloaded.list();
  assert.equal(voices.length, 1);
  assert.equal(voices[0].name, "Harry");
  assert.equal(voices[0].seconds, 30);
  assert.deepEqual((await reloaded.summary()).map((entry) => entry.name), ["Harry"]);
  await reloaded.forget(harry.id);
  assert.deepEqual(await new VoiceBank(file).list(), []);
  await fs.rm(directory, { recursive: true, force: true });
});
