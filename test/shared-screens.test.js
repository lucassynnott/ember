const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { screenTarget, placeSlides } = require("../src/shared-screens");
const { formatMeetingNote } = require("../src/note");
const { parseNote } = require("../src/library");
const { NotionSync } = require("../src/notion-sync");
const { liveHelpMessages } = require("../src/live-help");

test("watches the right window for the call", () => {
  assert.deepEqual(screenTarget({ zoom: { meetingOpen: true }, call: null }), { bundle: "us.zoom.xos", label: "Zoom" });
  assert.deepEqual(screenTarget({ zoom: { screenSharing: true, meetingOpen: false } }), { display: true, label: "your shared screen" });
  assert.deepEqual(screenTarget({ call: { bundleId: "net.imput.helium", app: "Google Meet", browser: true } }), {
    bundle: "net.imput.helium",
    title: "Meet|meet\\.google",
    label: "Google Meet",
  });
  assert.equal(screenTarget({ call: { bundleId: "com.microsoft.teams2", app: "Microsoft Teams", browser: false } }).bundle, "com.microsoft.teams2");
  assert.equal(screenTarget({}), null);
});

test("slides are summarised, kept beside the note and read back", async () => {
  const { summarizeTranscript } = require("../src/summary");
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: ["a"], decisions: [], actionItems: [], screens: [{ slide: 1, caption: "Three pricing tiers" }] }) } }] }));
  };
  try {
    const analysis = await summarizeTranscript("Dana: thoughts?", { openRouterKey: "k", openRouterModel: "m" }, () => {}, {
      sharedScreens: [{ time: "03:10", text: "Q4 pricing\nStarter $49" }],
    });
    assert.match(request.messages[0].content, /"screens" array/);
    assert.match(request.messages[1].content, /<shared_screen>\n\[slide 1 at 03:10\]\nQ4 pricing\nStarter \$49\n<\/shared_screen>/);
    assert.deepEqual(analysis.screens, [{ slide: 1, caption: "Three pricing tiers" }]);
  } finally {
    global.fetch = originalFetch;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slides-"));
  const captured = path.join(root, "capture");
  await fs.mkdir(captured);
  await fs.writeFile(path.join(captured, "slide-001.jpg"), "jpeg");
  const placed = await placeSlides([{ file: path.join(captured, "slide-001.jpg") }], root, "2026-10-02-1400");
  assert.deepEqual(placed, ["./2026-10-02-1400-shared/slide-001.jpg"]);
  assert.equal(await fs.readFile(path.join(root, "2026-10-02-1400-shared", "slide-001.jpg"), "utf8"), "jpeg");

  const markdown = formatMeetingNote({
    startedAt: new Date(2026, 9, 2, 14),
    endedAt: new Date(2026, 9, 2, 14, 30),
    transcript: "Dana: hi",
    audioFileName: "x.webm",
    analysis: { summary: ["a"], decisions: [], actionItems: [], transcriptionProvider: "P", summaryProvider: "m", slides: [{ time: "03:10", caption: "Three pricing tiers", image: placed[0] }] },
  });
  assert.match(markdown, /## Shared on screen\n\n### 03:10 · Three pricing tiers\n\n!\[Slide 1\]\(\.\/2026-10-02-1400-shared\/slide-001\.jpg\)/);
  assert.deepEqual(parseNote(markdown).slides, [{ time: "03:10", caption: "Three pricing tiers", image: "./2026-10-02-1400-shared/slide-001.jpg" }]);
  await fs.rm(root, { recursive: true, force: true });
});

test("slide images go under their headings in the Notion page", async () => {
  const calls = [];
  const heading = (id, type, text) => ({ id, type, [type]: { rich_text: [{ plain_text: text }] } });
  const sync = new NotionSync({
    ledgerPath: "/nonexistent",
    getSettings: () => ({}),
    request: async (method, apiPath, body) => {
      calls.push({ method, apiPath, body });
      if (method === "GET") {
        return { results: [heading("h1", "heading_2", "Summary"), heading("h2", "heading_2", "Shared on screen"), heading("s1", "heading_3", "03:10 · Pricing"), heading("s2", "heading_3", "05:00 · Timeline"), { id: "d", type: "divider" }, heading("h3", "heading_2", "Full transcript")] };
      }
      return {};
    },
    uploadImage: async (file) => (file.endsWith("2.jpg") ? null : `upload-${path.basename(file)}`),
  });
  assert.equal(await sync.attachSlides("page", ["/a/slide-001.jpg", "/a/slide-002.jpg"]), 1);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.apiPath, "v1/blocks/page/children");
  assert.equal(patch.body.after, "s1");
  assert.deepEqual(patch.body.children[0].image, { type: "file_upload", file_upload: { id: "upload-slide-001.jpg" } });
});

test("live help knows what's on screen now", () => {
  const messages = liveHelpMessages({ question: "What's on this slide?", transcript: "", onScreen: "Rollout timeline\nPilot in October" });
  assert.match(messages[1].content, /<on_screen_now>\nThe latest slide or document shared on screen:\nRollout timeline\nPilot in October\n<\/on_screen_now>/);
});
