const test = require("node:test");
const assert = require("node:assert/strict");

const { LiveCoach, isQuestion } = require("../src/live-coach");

const say = (you, start, end, text) => ({ you, start, end, text });
const filler = (count) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");

test("a long stretch of you talking gets a check-in cue", () => {
  const coach = new LiveCoach();
  const segments = [say(false, 0, 10, "So tell me about it."), say(true, 10, 50, filler(100)), say(true, 50, 95, filler(100))];
  assert.equal(coach.check(segments, 60)?.id ?? null, null);
  assert.equal(coach.check(segments, 101).id, "monologue");
});

test("a question left hanging is surfaced after a few seconds", () => {
  const coach = new LiveCoach();
  const segments = [say(true, 0, 5, "Hi there."), say(false, 5, 9, "Sure. What does it cost per seat?")];
  assert.equal(coach.check(segments, 12), null);
  const cue = coach.check(segments, 18);
  assert.equal(cue.id, "unanswered");
  assert.match(cue.text, /What does it cost per seat\?/);
});

test("speaking fast is noticed, normal pace isn't", () => {
  const fast = new LiveCoach();
  assert.equal(fast.check([say(false, 0, 5, "Go on."), say(true, 5, 35, filler(110))], 36)?.id, "pace");
  const normal = new LiveCoach();
  assert.equal(normal.check([say(false, 0, 5, "Go on."), say(true, 5, 35, filler(70))], 36), null);
});

test("fillers in the last minute", () => {
  const coach = new LiveCoach();
  assert.equal(coach.check([say(false, 0, 2, "Okay."), say(true, 2, 20, "um so uh basically we um, uh, ship it um")], 21)?.id, "fillers");
});

test("doing most of the talking over several minutes", () => {
  const coach = new LiveCoach();
  const segments = [];
  for (let at = 0; at < 300; at += 60) segments.push(say(true, at, at + 50, `${filler(120)}?`), say(false, at + 50, at + 60, "Right."));
  const cue = coach.check(segments, 300);
  assert.equal(cue.id, "talk-share");
  assert.match(cue.text, /\d+% of the talking/);
});

test("their answers getting much shorter", () => {
  const coach = new LiveCoach();
  const segments = [];
  let at = 0;
  for (let index = 0; index < 5; index += 1) segments.push(say(true, at, at + 5, "And?"), say(false, at + 5, at + 20, filler(30))), (at += 20);
  for (let index = 0; index < 3; index += 1) segments.push(say(true, at, at + 5, "And then?"), say(false, at + 5, at + 6, "Sure.")), (at += 6);
  assert.equal(coach.check(segments, at + 1)?.id, "short-answers");
});

test("cues are spaced out, and the same one isn't repeated soon", () => {
  const coach = new LiveCoach();
  const segments = [say(false, 0, 4, "What's the price?")];
  assert.equal(coach.check(segments, 20).id, "unanswered");
  assert.equal(coach.check(segments, 40), null); // under 45 s since the last cue
  assert.equal(coach.check(segments, 100), null); // the same cue within 5 minutes
});

test("your weekly focus makes its cue come sooner", () => {
  const segments = [say(false, 0, 5, "Tell me."), say(true, 5, 75, filler(200))];
  assert.equal(new LiveCoach().check(segments, 70), null);
  assert.equal(new LiveCoach({ focus: "talk-less" }).check(segments, 70)?.id, "monologue");
});

test("questions are recognised by their mark", () => {
  assert.ok(isQuestion("Does it work with Zoom?"));
  assert.ok(!isQuestion("It works with Zoom."));
});
