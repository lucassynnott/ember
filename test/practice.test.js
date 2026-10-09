const test = require("node:test");
const assert = require("node:assert/strict");

const { cleanReply, practiceReviewMessages, prospectMessages, scenarioFor } = require("../src/practice");

test("the AI plays the other side from your knowledge base, and stays in character", () => {
  const scenario = scenarioFor("pricing");
  const [system, user] = prospectMessages({
    scenario,
    difficulty: "hard",
    knowledge: '<knowledge_base>\n[[kb:1]] from "objections.md"\nCustomers often say it costs more than Northwind.\n</knowledge_base>',
    history: [{ role: "you", text: "Hi, thanks for making time." }],
  });
  assert.match(system.content, /too expensive/);
  assert.match(system.content, /push back firmly/);
  assert.match(system.content, /never step out of character/);
  assert.match(user.content, /costs more than Northwind/);
  assert.match(user.content, /You: Hi, thanks/);
  assert.match(prospectMessages({ scenario }).at(-1).content, /just starting/);
});

test("custom scenarios, and replies cleaned of labels and stage directions", () => {
  assert.match(scenarioFor("custom", "A CFO who hates software").brief, /CFO/);
  assert.equal(scenarioFor("custom", "  ").label, "First discovery call");
  assert.equal(cleanReply('Dana: "Honestly *sighs* it\'s a lot — for us."'), "Honestly it's a lot, for us.");
});

test("the review holds the practice call to the playbooks", () => {
  const [system, user] = practiceReviewMessages({ scenario: scenarioFor("stall"), history: [{ role: "them", text: "Let me think about it." }], knowledge: "<knowledge_base>x</knowledge_base>", focus: { label: "Ask more questions" } });
  assert.match(system.content, /knowledge base/);
  assert.match(user.content, /Them: Let me think about it/);
  assert.match(user.content, /Ask more questions/);
});
