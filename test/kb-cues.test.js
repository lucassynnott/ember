const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { KnowledgeBase } = require("../src/knowledge");
const { KnowledgeCues, excerpt } = require("../src/kb-cues");

async function base() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kb-cues-"));
  const docs = path.join(root, "docs");
  await fs.mkdir(docs);
  await fs.writeFile(
    path.join(docs, "objections.md"),
    "# Pricing objections\n\nWhen they say the price is too expensive, ask what they compare it to. Then anchor on the cost of the problem. Never discount on the first call.\n\n## Timing\n\nIf it's not the right time, ask what would need to change and book the follow-up now.",
  );
  await fs.writeFile(path.join(docs, "battlecard-competitors.md"), "# Northwind\n\nNorthwind records calls but has no live coaching. Lead with live tips.\n\n# Overview\n\nHow we compare.");
  await fs.writeFile(path.join(docs, "recipes.md"), "# Soup\n\nA good soup needs time and a little salt.");
  const kb = new KnowledgeBase({ indexPath: path.join(root, "index.json") });
  await kb.index([docs]);
  return { kb, root };
}

test("pricing and objections bring up the matching playbook passage straight away", async () => {
  const { kb, root } = await base();
  let now = 0;
  const cues = new KnowledgeCues({ search: (query, options) => kb.search(query, options), now: () => now });
  const cue = cues.check("Honestly, the price feels too expensive for us.");
  assert.equal(cue.title, "Pricing");
  assert.equal(cue.name, "objections.md");
  assert.match(cue.text, /compare it to/);
  assert.equal(cues.check("Still, the price is a lot."), null, "not again straight away");
  now += 4 * 60_000;
  assert.match(cues.check("It's just not the right time for us.")?.text || "", /what would need to change/);
  assert.equal(cues.check("We had a nice lunch."), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("competitors named in battlecards are spotted", async () => {
  const { kb, root } = await base();
  const competitors = KnowledgeCues.competitorsFrom(kb.topics(), ["Acme"]);
  assert.ok(competitors.includes("Northwind"));
  assert.ok(!competitors.includes("Overview"));
  assert.ok(!competitors.includes("Soup"), "only from competitor files");
  const cues = new KnowledgeCues({ search: (query, options) => kb.search(query, options), competitors });
  const cue = cues.check("We're also looking at Northwind.");
  assert.equal(cue.title, "Northwind");
  assert.match(cue.text, /no live coaching/);
  await fs.rm(root, { recursive: true, force: true });
});

test("excerpts keep the sentences about what was said", () => {
  const text = "# Pricing\n\nWe have three plans. Ask what they compare the price to. Our office is in Dublin.";
  assert.equal(excerpt(text, "compare price"), "We have three plans. Ask what they compare the price to.");
});
