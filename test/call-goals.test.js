const test = require("node:test");
const assert = require("node:assert/strict");

const { checklistFor, goalMessages, parseGoal, coverageMessages, parseCoverage, minutesLeft, timeNudge, knowledgeQuery } = require("../src/call-goals");

test("frameworks give checklists, and custom ones come from your own lines", () => {
  assert.deepEqual(checklistFor("bant").map((item) => item.id), ["budget", "authority", "need", "timeline", "next"]);
  assert.deepEqual(checklistFor("custom", "- Ask about the team\n2. Book a demo\n\n"), [
    { id: "c1", label: "Ask about the team" },
    { id: "c2", label: "Book a demo" },
  ]);
  assert.equal(checklistFor("unknown")[0].id, "situation", "falls back to discovery");
});

test("the goal is suggested from the calendar, earlier calls and the knowledge base", () => {
  const [system, user] = goalMessages({
    calendar: { title: "Acme intro", attendees: ["Dana"] },
    earlier: [{ title: "Acme scoping", startedAt: Date.UTC(2026, 8, 1), actionItems: [{ owner: "Me", task: "Send pricing", done: false }] }],
    knowledge: '<knowledge_base>\n[[kb:1]] from "playbook.md"\nFirst calls end with a booked demo.\n</knowledge_base>',
  });
  assert.match(system.content, /knowledge base/);
  assert.match(user.content, /Acme intro/);
  assert.match(user.content, /Send pricing/);
  assert.match(user.content, /First calls end with a booked demo/);
  const goal = parseGoal('```json\n{"goal":"Book a demo with Dana — and her boss","why":"Your playbook says so.","framework":"discovery","cite":["kb:1","bogus"]}\n```');
  assert.equal(goal.goal, "Book a demo with Dana, and her boss");
  assert.equal(goal.framework, "discovery");
  assert.deepEqual(goal.cite, ["kb:1"]);
  assert.equal(parseGoal("no"), null);
});

test("coverage only counts open points, and the next move can cite a playbook", () => {
  const items = checklistFor("bant");
  const [, user] = coverageMessages({ transcript: "Me: What's your budget?\nDana: About 20k.", goal: "Qualify", items, covered: ["need"], knowledge: "<knowledge_base>x</knowledge_base>", minutesLeft: 12 });
  assert.doesNotMatch(user.content.split("<already_covered>")[0], /need: Need/);
  assert.match(user.content, /About 12 minutes are left/);
  const result = parseCoverage('{"covered":["budget","nonsense"],"next":{"title":"Ask who signs","text":"Say: \\"Who else signs off on this?\\"","cite":["kb:2"]}}', items);
  assert.deepEqual(result.covered, ["budget"]);
  assert.equal(result.next.cite[0], "kb:2");
  assert.equal(parseCoverage('{"covered":[],"next":null}', items).next, null);
});

test("time nudges near the calendar end name what's still open, once each", () => {
  const items = checklistFor("bant");
  const now = Date.UTC(2026, 9, 9, 10, 0);
  assert.equal(minutesLeft({ end: now + 9 * 60_000 }, now), 9);
  assert.equal(minutesLeft(null, now), null);
  const sent = new Set();
  assert.equal(timeNudge({ items, covered: [], left: 20, sent }), null);
  const nudge = timeNudge({ items, covered: ["budget"], left: 9.6, sent });
  assert.match(nudge.text, /^10 min left\. Not covered yet: who decides and need and 2 more\.$/);
  assert.equal(timeNudge({ items, covered: ["budget"], left: 8, sent }), null);
  assert.match(timeNudge({ items, covered: ["budget", "authority", "need", "timeline", "next"], left: 2.5, sent }).text, /Confirm the next step/);
});

test("knowledge queries look at what they just said, the goal and what's still open", () => {
  const query = knowledgeQuery({
    segments: [{ you: false, text: "Honestly it seems expensive next to Gong." }, { you: true, text: "Fair." }],
    goal: "Agree a pilot",
    items: checklistFor("bant"),
    covered: ["budget"],
  });
  assert.match(query, /expensive next to Gong/);
  assert.match(query, /Agree a pilot/);
  assert.match(query, /Timeline/);
  assert.doesNotMatch(query, /Budget/);
});
