const test = require("node:test");
const assert = require("node:assert/strict");
const { FREQUENCIES, NudgeScheduler, WARMUP_MS, nudgeMessages, parseNudge } = require("../src/live-nudges");

test("checks wait for the warm-up, enough new words and the interval", () => {
  let time = 0;
  const scheduler = new NudgeScheduler({ frequency: "normal", now: () => time, startedAt: 0 });
  const { everyMs, minWords } = FREQUENCIES.normal;
  assert.equal(scheduler.due(1000), false, "not during the warm-up");
  time = WARMUP_MS + 1;
  assert.equal(scheduler.due(minWords - 1), false, "not enough said yet");
  assert.equal(scheduler.due(minWords), true);
  scheduler.checked(minWords);
  time += everyMs - 1;
  assert.equal(scheduler.due(minWords * 3), false, "too soon after the last check");
  time += 2;
  assert.equal(scheduler.due(minWords * 3), true);
  scheduler.off = true;
  assert.equal(scheduler.due(minWords * 9), false, "turned off for this call");
});

test("a tip much like one already shown is a repeat", () => {
  const scheduler = new NudgeScheduler();
  scheduler.record("You promised Priya the pricing sheet last Tuesday");
  assert.equal(scheduler.isRepeat("Reminder: you promised Priya the pricing sheet"), true);
  assert.equal(scheduler.isRepeat("Sam asked about the security review date"), false);
});

test("the model's reply becomes a tip, or nothing", () => {
  assert.equal(parseNudge('{"tip": null}'), null);
  assert.equal(parseNudge("not json"), null);
  assert.equal(parseNudge('{"tip": {"title": "x", "text": "ok"}}'), null, "too short to be useful");
  const tip = parseNudge('Sure: {"tip": {"title": "Open promise", "text": "Last call you said you\'d send the security questionnaire. Say \\"I\'ll send it today.\\"", "cite": ["2026-09-29-1605", "kb:2", "javascript:x"]}}');
  assert.equal(tip.title, "Open promise");
  assert.match(tip.text, /security questionnaire/);
  assert.deepEqual(tip.cite, ["2026-09-29-1605", "kb:2"]);
});

test("the prompt carries the call, earlier promises and tips already shown", () => {
  const [system, user] = nudgeMessages({
    transcript: "Priya Shah: Did you get a chance to look at the security review?",
    speakerName: "Alex Rivera",
    earlier: [{ id: "2026-09-29-1605", title: "Acme renewal", startedAt: Date.UTC(2026, 8, 29), actionItems: [{ owner: "Alex Rivera", task: "Send the security questionnaire" }] }],
    shown: ["Answer Priya's pricing question"],
  });
  assert.match(system.content, /Most of the time the right answer is no tip/);
  assert.match(user.content, /security review/);
  assert.match(user.content, /\[\[2026-09-29-1605\]\][\s\S]*Send the security questionnaire/);
  assert.match(user.content, /<tips_already_shown>[\s\S]*pricing question/);
});

test("tips never show em dashes", () => {
  const tip = parseNudge('{"tip": {"title": "Price — anchor", "text": "Don\'t discount yet — ask what they compare it to."}}');
  assert.equal(tip.title, "Price, anchor");
  assert.equal(tip.text, "Don't discount yet, ask what they compare it to.");
});

test("a question or objection from them is checked straight away, but not twice in half a minute", () => {
  let now = 0;
  const scheduler = new NudgeScheduler({ startedAt: 0, now: () => now });
  now = 60_000;
  assert.equal(scheduler.dueForEvent(), false, "not during the warm-up");
  now = 130_000;
  assert.equal(scheduler.dueForEvent(), true);
  scheduler.checked(10);
  now += 20_000;
  assert.equal(scheduler.dueForEvent(), false);
  now += 15_000;
  assert.equal(scheduler.dueForEvent(), true);
});
