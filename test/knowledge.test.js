const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { KnowledgeBase, chunkText, knowledgeBlock, supported } = require("../src/knowledge");
const { liveHelpMessages } = require("../src/live-help");

test("splits documents into passages under their headings", () => {
  const chunks = chunkText("# Price objections\n\nDon't discount.\n\n## Timing\n\nAsk what would change.", 1100);
  assert.deepEqual(chunks, ["# Price objections\n\nDon't discount.", "## Timing\n\nAsk what would change."]);
  const long = chunkText(`# Guide\n\n${"A sentence that goes on. ".repeat(100)}`, 300);
  assert.ok(long.length > 3);
  assert.ok(long.every((chunk) => chunk.length <= 320));
  assert.ok(long.slice(1).every((chunk) => chunk.startsWith("Guide\n")), "later passages keep their heading");
  assert.equal(supported("Playbook.PDF"), true);
  assert.equal(supported("photo.jpg"), false);
});

test("indexes a folder on this Mac and finds the right passages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-"));
  const docs = path.join(root, "docs");
  await fs.mkdir(path.join(docs, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(docs, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(docs, "objections.md"), "# Price objections\n\nWhen they say it's too expensive, ask what they compare it to.\n\n## Timing\n\nIf it's not the right time, book the follow-up now.");
  await fs.writeFile(path.join(docs, "close.docx"), "binary");
  await fs.writeFile(path.join(docs, "training.vtt"), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nAlways summarise next steps before closing.\n");
  await fs.writeFile(path.join(docs, ".hidden", "secret.md"), "secret pricing");
  await fs.writeFile(path.join(docs, "node_modules", "x.md"), "ignored");
  let conversions = 0;
  const kb = new KnowledgeBase({
    indexPath: path.join(root, "index.json"),
    convert: async () => {
      conversions += 1;
      return "Closing checklist: confirm the decision maker and budget.";
    },
  });
  const status = await kb.index([docs]);
  assert.deepEqual({ files: status.files, indexing: status.indexing }, { files: 3, indexing: false });

  assert.equal(kb.search("they said it is too expensive")[0].name, "objections.md");
  assert.equal(kb.search("how do I close")[0].name, "close.docx", "closing matches close");
  assert.equal(kb.search("next steps")[0].name, "training.vtt");
  assert.deepEqual(kb.search("secret ignored"), []);

  await kb.index([docs]);
  assert.equal(conversions, 1, "unchanged files aren't read again");
  const reloaded = new KnowledgeBase({ indexPath: path.join(root, "index.json") });
  await reloaded.load();
  assert.equal(reloaded.status().files, 3);

  const block = knowledgeBlock(kb.search("too expensive"));
  assert.match(block.text, /\[\[kb:1\]\] from "objections.md"/);
  assert.equal(block.sources["kb:1"].name, "objections.md");
  await fs.rm(root, { recursive: true, force: true });
});

test("live help answers briefly from the call, the knowledge base and earlier calls", () => {
  const messages = liveHelpMessages({
    question: "How do I handle the price objection?",
    transcript: "Lucas: So what do you think?\nDana Lee: Honestly it feels expensive.",
    notes: { summary: ["Dana is evaluating."], decisions: [], actionItems: [] },
    knowledge: '<knowledge_base>\n[[kb:1]] from "objections.md"\nAsk what they compare it to.\n</knowledge_base>',
    earlier: [{ id: "2026-09-24-1000", title: "Acme intro", startedAt: Date.now(), summary: ["Budget is tight."], decisions: [], actionItems: [] }],
    speakerName: "Lucas",
    history: [{ role: "user", content: "What's their budget?" }, { role: "assistant", content: "Not said yet." }],
  });
  assert.match(messages[0].content, /at most three short/);
  assert.match(messages[0].content, /exact words in quotes/);
  assert.match(messages[1].content, /<current_call>\nLucas: So what do you think\?\nDana Lee: Honestly it feels expensive\.\n<\/current_call>/);
  assert.match(messages[1].content, /Summary so far: Dana is evaluating\./);
  assert.match(messages[1].content, /\[\[kb:1\]\] from "objections.md"/);
  assert.match(messages[1].content, /\[\[2026-09-24-1000\]\] Acme intro/);
  assert.deepEqual(messages.slice(-3).map((message) => message.role), ["user", "assistant", "user"]);
  const long = liveHelpMessages({ question: "x", transcript: "y".repeat(20000) });
  assert.match(long[1].content, /\[earlier part of the call cut\]/);
});
