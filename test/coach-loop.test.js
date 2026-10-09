const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TipFeedback, focusProgress, parseScorecard, scorecardMessages, weeklyFocus } = require("../src/coach-loop");

test("the weekly focus is the habit furthest from good, or the one you picked", () => {
  const week = { calls: 4, talkShare: 0.72, fillersPer100: 2.2, wordsPerMinute: 160, questions: 20 };
  const focus = weeklyFocus(week);
  assert.equal(focus.id, "talk-less");
  assert.equal(focus.currentText, "72% talk share");
  assert.equal(weeklyFocus({ calls: 3, talkShare: 0.45, fillersPer100: 1, wordsPerMinute: 150, questions: 24 }), null, "nothing far off");
  assert.equal(weeklyFocus(week, "slow-down").id, "slow-down");
  assert.equal(weeklyFocus(null), null);
});

test("progress on the focus call by call", () => {
  const perCall = [0.75, 0.7, 0.55, 0.48].map((talkShare, index) => ({ id: `m${index}`, stats: { talkShare, questions: 3 } }));
  const progress = focusProgress("talk-less", perCall);
  assert.equal(progress.values.length, 4);
  assert.equal(progress.met, 1);
  assert.equal(progress.trend, "better");
});

test("the scorecard prompt holds the call to its goal, checklist and playbooks", () => {
  const [system, user] = scorecardMessages({
    goal: "Book a demo",
    framework: "bant",
    items: [{ id: "budget", label: "Budget" }, { id: "timeline", label: "Timeline" }],
    covered: ["budget"],
    stats: { talkShare: 0.7, wordsPerMinute: 170, questions: 4, fillersPer100: 3.1, longestMonologueSeconds: 95, interruptions: 1 },
    focus: { label: "Talk less, listen more" },
    knowledge: '<knowledge_base>\n[[kb:1]] from "playbook.md"\nAlways end with a date.\n</knowledge_base>',
    transcript: "Me: Hi.",
  });
  assert.match(system.content, /knowledge base/);
  assert.match(user.content, /\[x\] Budget/);
  assert.match(user.content, /\[ \] Timeline/);
  assert.match(user.content, /Talk share 70%/);
  assert.match(user.content, /Talk less, listen more/);
  const card = parseScorecard('{"goal":"partly","verdict":"Good start — no date.","wins":["Clear agenda"],"missed":["No timeline"],"tryNext":{"text":"End with: \\"Does Tuesday work?\\"","cite":["kb:1","x"]}}');
  assert.equal(card.goal, "partly");
  assert.equal(card.verdict, "Good start, no date.");
  assert.deepEqual(card.tryNext.cite, ["kb:1"]);
  assert.equal(parseScorecard("nope"), null);
});

test("tip feedback steers kinds and frequency", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-"));
  const feedback = new TipFeedback(path.join(root, "coach-feedback.json"));
  for (let index = 0; index < 4; index += 1) await feedback.record({ kind: "contradiction", helpful: false, title: "Check the number", text: "They said 40 seats." });
  for (let index = 0; index < 3; index += 1) await feedback.record({ kind: "objection", helpful: true });
  assert.deepEqual(feedback.summary().unhelpful, ["contradiction"]);
  assert.deepEqual(feedback.summary().helped, ["objection"]);
  assert.match(feedback.promptHint(), /unhelpful.*contradiction/);
  assert.match(feedback.promptHint(), /Check the number/);
  assert.equal(feedback.adjustedFrequency("normal"), "normal");
  for (let index = 0; index < 8; index += 1) await feedback.record({ kind: "knowledge", helpful: false });
  assert.equal(feedback.adjustedFrequency("normal"), "rarely");
  const reloaded = await new TipFeedback(path.join(root, "coach-feedback.json")).load();
  assert.equal(reloaded.data.kinds.objection.up, 3);
  await fs.rm(root, { recursive: true, force: true });
});
