const test = require("node:test");
const assert = require("node:assert/strict");
const { buildContext, buildMessages, rankPassages, streamCompletion } = require("../src/ask");
const { cleanDictation, lightCleanup } = require("../src/dictation-cleanup");
const { DictationController } = require("../src/dictation");

const meeting = (id, title, transcript, extra = {}) => ({
  id,
  title,
  startedAt: new Date(2026, 8, 30, 17, 1).getTime(),
  duration: 600,
  folder: null,
  tags: [],
  summary: [`${title} summary.`],
  decisions: [],
  actionItems: [{ owner: "Lucas", task: `Follow up on ${title}` }],
  transcript: transcript.map(([speaker, text]) => ({ speaker, text })),
  ...extra,
});

const MEETINGS = [
  meeting("2026-09-30-1701", "Harry website", [["Harry Maule", "The VSL video on my website has been blank for weeks."], ["Lucas", "Use the Loom iframe embed."]]),
  meeting("2026-09-28-1000", "Team sync", [["Priya", "Hiring is on track."], ["Sam", "Roadmap review next week."]]),
];

test("light cleanup removes fillers and stutters but keeps real words", () => {
  assert.equal(lightCleanup("um so I I think we should uh ship it"), "So I think we should ship it");
  assert.equal(lightCleanup("Er, 3,000 users, um, signed up."), "3,000 users signed up.");
  assert.equal(lightCleanup("The summer was great, umbrella in hand."), "The summer was great, umbrella in hand.");
  assert.equal(lightCleanup("this is very very good, he had had enough"), "This is very very good, he had had enough");
  assert.equal(lightCleanup("i think so"), "I think so");
});

test("cleanup modes: off, light, and AI with fallbacks", async () => {
  const text = "um meet on tuesday no wait wednesday";
  assert.equal((await cleanDictation(text, { dictationCleanup: "off" })).text, text);
  assert.equal((await cleanDictation(text, { dictationCleanup: "light" })).text, "Meet on tuesday no wait wednesday");
  assert.equal((await cleanDictation(text, { dictationCleanup: "ai" })).mode, "light", "no key means Light");

  const ai = { dictationCleanup: "ai", openRouterKey: "k", openRouterModel: "m" };
  const good = await cleanDictation(text, ai, { call: async () => '{"text":"Meet on Wednesday."}' });
  assert.deepEqual(good, { text: "Meet on Wednesday.", mode: "ai", snippets: 0 });

  const answered = await cleanDictation("what is the capital of france", ai, {
    call: async () => JSON.stringify({ text: "The capital of France is Paris. It has been the capital since the 10th century and is home to many landmarks." }),
  });
  assert.equal(answered.mode, "light");
  assert.equal(answered.text, "What is the capital of france");

  const slow = await cleanDictation(text, ai, {
    timeoutMs: 20,
    call: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  assert.equal(slow.mode, "light");
  assert.equal(slow.fallback, "AI cleanup took too long");
});

test("dictation pastes the cleaned text", async () => {
  const { EventEmitter } = require("node:events");
  const helper = Object.assign(new EventEmitter(), { setDictating() {}, focus: async () => ({ editable: true, app: "Notes" }), paste: async () => {} });
  const overlay = { show() {}, hide() {}, startCapture: async () => {}, stopCapture: async () => new Float32Array(16000).fill(0.1), cancelCapture() {} };
  const pasted = [];
  const clipboard = { snapshot: () => null, writeText: (text) => pasted.push(text), readText: () => "", restore() {} };
  const controller = new DictationController({
    helper,
    overlay,
    clipboard,
    transcribe: async () => "um hello",
    clean: async (text) => text.replace("um ", "").replace("hello", "Hello"),
    getSettings: () => ({ dictationMode: "hold", dictationKeepOnClipboard: true }),
  });
  await controller.start();
  await controller.finish();
  assert.deepEqual(pasted, ["Hello"]);
});

test("Ask finds the right transcript passages and builds a cited prompt", () => {
  const ranked = rankPassages(MEETINGS, "What did Harry say about the VSL video?");
  assert.equal(ranked[0].id, "2026-09-30-1701");
  assert.equal(rankPassages(MEETINGS, "the and of").length, 0);

  const context = buildContext(MEETINGS, "VSL video");
  assert.match(context, /\[\[2026-09-30-1701\]\] Harry website/);
  assert.match(context, /\[\[2026-09-28-1000\]\] Team sync/);
  assert.match(context, /VSL video on my website/);
  assert.doesNotMatch(context.split("<transcript_excerpts>")[1], /Hiring is on track/);

  const single = buildContext([MEETINGS[1]], "anything");
  assert.match(single, /Full transcript:\nPriya: Hiring is on track\./);

  const messages = buildMessages({
    meetings: MEETINGS,
    question: "And Sam?",
    history: [{ role: "user", content: "Who talked about hiring?" }, { role: "assistant", content: "Priya [[2026-09-28-1000]]." }],
    speakerName: "Lucas",
    now: new Date(2026, 9, 2, 12, 0),
  });
  assert.match(messages[0].content, /Today is Friday 2 October 2026/);
  assert.match(messages[0].content, /mean Lucas/);
  assert.deepEqual(messages.slice(-3).map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(messages.at(-1).content, "And Sam?");
});

test("Ask streams the answer from OpenRouter", async () => {
  const events = [
    'data: {"choices":[{"delta":{"content":"Harry said "}}]}\n\n',
    ": keep-alive\n\n",
    'data: {"choices":[{"delta":{"content":"the video was blank [[2026-09-30-1701]]."}}]}\n',
    "\ndata: [DONE]\n\n",
  ];
  let request;
  const fetchImpl = async (url, options) => {
    request = JSON.parse(options.body);
    return new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }));
  };
  const deltas = [];
  const text = await streamCompletion({ key: "k", model: "m", messages: [], onDelta: (delta) => deltas.push(delta), fetchImpl });
  assert.equal(text, "Harry said the video was blank [[2026-09-30-1701]].");
  assert.equal(deltas.length, 2);
  assert.equal(request.stream, true);

  const failing = async () => new Response("nope", { status: 401 });
  await assert.rejects(streamCompletion({ key: "k", model: "m", messages: [], onDelta() {}, fetchImpl: failing }), /OpenRouter failed \(401\)/);
});
