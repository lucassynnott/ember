const test = require("node:test");
const assert = require("node:assert/strict");

const { CallCoach } = require("../src/call-coach");

const settings = { coachFramework: "auto", coachCues: true, callGoals: true, knowledgeCues: true, speakerName: "Sam" };
const passages = [{ file: "/kb/playbook.md", name: "playbook.md", text: "# Pricing\n\nWhen the price is too expensive, ask what they compare it to.", score: 6, coverage: 0.6 }];

function coach(options = {}) {
  let now = 1_000_000;
  const prompts = [];
  const instance = new CallCoach({
    startedAt: now,
    settings,
    search: (query) => (prompts.push(query), /objection timing|think about it/.test(query) ? [] : passages),
    ai: async (system, user) => {
      prompts.push(user);
      if (/goal/.test(system) && /Reply with JSON only: \{"goal"/.test(system)) return '{"goal":"Agree a pilot start date","why":"Your playbook says first calls end with a date.","framework":"bant","cite":["kb:1"]}';
      return '{"covered":["budget"],"next":{"title":"Ask who signs","text":"Say: \\"Who else signs off?\\"","cite":["kb:1"]}}';
    },
    now: () => now,
    ...options,
  });
  return { instance, prompts, advance: (ms) => (now += ms) };
}

test("the goal is suggested from the calendar and the playbook, and picks the framework", async () => {
  const { instance, prompts } = coach();
  const states = [];
  instance.on("state", (state) => states.push(state));
  instance.setCalendar({ title: "Acme pricing call", attendees: ["Dana"], end: 1_000_000 + 30 * 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const state = instance.state();
  assert.equal(state.goal.text, "Agree a pilot start date");
  assert.equal(state.goal.sources["kb:1"].name, "playbook.md");
  assert.equal(state.framework, "bant");
  assert.equal(state.minutesLeft, 30);
  assert.ok(prompts.some((prompt) => /When the price is too expensive/.test(prompt)), "the playbook went into the prompt");
  assert.ok(states.length >= 1);
});

test("their questions and objections are the moment for a tip; pricing brings up the playbook instantly", () => {
  const { instance } = coach();
  assert.equal(instance.onSegment([{ you: false, text: "How long does setup take?", start: 0, end: 3 }]).tip, "question");
  assert.equal(instance.onSegment([{ you: false, text: "We'd need to think it over.", start: 0, end: 3 }]).tip, "objection");
  assert.equal(instance.onSegment([{ you: true, text: "How are you?", start: 0, end: 3 }]).tip ?? null, null);
  const { knowledgeCue } = instance.onSegment([{ you: false, text: "The price seems too expensive.", start: 4, end: 6 }]);
  assert.equal(knowledgeCue.title, "Pricing");
  assert.match(knowledgeCue.text, /compare it to/);
});

test("the checklist fills in from the call, with a next step from the playbook", async () => {
  const { instance, advance } = coach();
  instance.setFramework("bant");
  advance(80_000);
  await instance.tick([{ you: true, text: "What's your budget?", start: 0, end: 2 }, { you: false, text: "About twenty thousand.", start: 2, end: 4 }], 100);
  const state = instance.state();
  assert.equal(state.items.find((item) => item.id === "budget").done, true);
  assert.equal(state.next.title, "Ask who signs");
  assert.equal(state.next.sources["kb:1"].file, "/kb/playbook.md");
  instance.toggleItem("budget");
  assert.equal(instance.state().items.find((item) => item.id === "budget").done, false);
});

test("near the end of the calendar slot it says what's still open", async () => {
  const { instance, advance } = coach({ ai: null });
  instance.setFramework("bant");
  instance.setCalendar({ title: "Call", end: 1_000_000 + 20 * 60_000 });
  const cues = [];
  instance.on("cue", (cue) => cues.push(cue));
  advance(11 * 60_000);
  await instance.tick([], 0);
  assert.match(cues[0].text, /^9 min left\. Not covered yet: budget and who decides and 3 more\.$/);
});

test("delivery cues reach the chip", async () => {
  const { instance, advance } = coach({ ai: null });
  advance(30_000);
  await instance.tick([{ you: false, text: "What's the price?", start: 10, end: 12 }], 3);
  assert.equal(instance.state().cue.id, "unanswered");
  advance(13_000);
  assert.equal(instance.state().cue, null, "and fade after a few seconds");
});

test("the coach mode sets the checklist, the cues and what the prompts look for", async () => {
  const prompts = [];
  let now = 1_000_000;
  const assistant = new CallCoach({
    startedAt: now,
    settings: { ...settings, coachMode: "assistant" },
    search: () => passages,
    ai: async (system) => (prompts.push(system), '{"covered":[],"next":null}'),
    now: () => now,
  });
  const state = assistant.state();
  assert.equal(state.mode.label, "Executive assistant");
  assert.deepEqual(state.items.map((item) => item.label).slice(0, 2), ["Agenda agreed", "Decisions made"]);
  assert.equal(assistant.onSegment([{ you: false, text: "The price seems too expensive.", start: 0, end: 2 }]).knowledgeCue, null, "no sales cues");
  const long = [{ you: false, text: "Go on.", start: 0, end: 2 }, { you: true, text: "word ".repeat(400), start: 2, end: 150 }];
  now += 160_000;
  await assistant.tick(long, 400);
  assert.equal(assistant.state().cue, null, "no delivery cues for an assistant");
  assert.match(prompts[0], /executive assistant/);
});
