const test = require("node:test");
const assert = require("node:assert/strict");
const { followUpMessages, voiceSamples } = require("../src/follow-up");

const entry = (app, text) => ({ app, text, words: text.split(/\s+/).length });

test("picks past writing from the same kind of app first, skipping short and call-note dictations", () => {
  const entries = [
    entry("Slack", "hey all, quick one, can someone look at the staging deploy when you get a sec, cheers"),
    entry("Call notes", "Action item: Sam sends the contract to Dana before the end of the week please"),
    entry("Mail", "Hi Dana, thanks for the time today. Quick recap below, shout if I missed anything. Cheers, Alex"),
    entry("Notes", "ok"),
  ];
  const email = voiceSamples(entries, "email");
  assert.match(email[0], /^Hi Dana/);
  assert.equal(email.length, 2);
  assert.ok(!email.some((text) => text.startsWith("Action item")));
  assert.match(voiceSamples(entries, "slack")[0], /^hey all/);
  assert.deepEqual(voiceSamples([], "email"), []);
});

test("adds writing samples as style only, and leaves the prompt alone without them", () => {
  const meeting = { title: "Pricing review", summary: ["Agreed the new tiers."], transcript: [] };
  const plain = followUpMessages({ meeting });
  assert.ok(!plain[1].content.includes("<my_writing>"));
  const styled = followUpMessages({ meeting, samples: ["Hi Dana, quick recap below. Cheers, Alex"] });
  assert.match(styled[0].content, /Never take facts/);
  assert.match(styled[1].content, /<my_writing>\n<example>Hi Dana/);
});
