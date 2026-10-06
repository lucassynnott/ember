const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NotionSync, buildPageRequest } = require("../src/notion-sync");

const analysis = {
  summary: ["Launch moves to 14 October.", "# not a heading"],
  decisions: ["Sarah owns pricing."],
  actionItems: [{ owner: "Lucas", task: "Send the deck" }],
  transcriptionProvider: "Phonon-2",
  summaryProvider: "OpenRouter (openai/gpt-5.6-luna)",
};

function meeting(overrides = {}) {
  return {
    startedAt: new Date(2026, 8, 30, 18, 0, 0),
    endedAt: new Date(2026, 8, 30, 18, 42, 30),
    origin: "zoom-auto",
    transcript: "Lucas: Let's move the launch.\nSarah: - agreed, <b>Friday</b>.",
    analysis,
    notePath: path.join(os.homedir(), "MeetingNotes", "2026-09-30-1800.md"),
    audioPath: path.join(os.homedir(), "MeetingNotes", "2026-09-30-1800.webm"),
    ...overrides,
  };
}

test("builds a Notion page with properties and the full note as Markdown", () => {
  const request = buildPageRequest({ ...meeting(), dataSourceId: "ds-1" });
  assert.deepEqual(request.parent, { type: "data_source_id", data_source_id: "ds-1" });
  assert.equal(request.properties.Name.title[0].text.content, "Meeting — Wed 30 Sep 2026, 18:00");
  assert.match(request.properties.Date.date.start, /^2026-09-30T18:00:00[+-]\d\d:\d\d$/);
  assert.equal(request.properties["Duration (min)"].number, 42.5);
  assert.equal(request.properties.Source.select.name, "Zoom auto");
  assert.equal(request.properties["Action items"].number, 1);
  assert.equal(request.properties.Transcription.select.name, "Phonon-2");
  assert.equal(request.properties["Local note"].rich_text[0].text.content, path.join("~", "MeetingNotes", "2026-09-30-1800.md"));
  assert.match(request.markdown, /## Summary\n\n- Launch moves to 14 October\.\n- \\# not a heading/);
  assert.match(request.markdown, /- \[ \] \*\*Lucas\*\* — Send the deck/);
  assert.match(request.markdown, /\*\*Lucas:\*\* Let's move the launch\.\n\n\*\*Sarah:\*\* \\- agreed, &lt;b>Friday&lt;\/b>\./);
});

function fakeNtn(directory, behaviour) {
  const script = path.join(directory, "ntn.cjs");
  const log = path.join(directory, "calls.log");
  fs.writeFileSync(script, `
const fs = require("node:fs");
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const log = ${JSON.stringify(log)};
  fs.appendFileSync(log, body + "\\n");
  if (fs.existsSync(${JSON.stringify(path.join(directory, "fail"))})) {
    console.log(JSON.stringify({object:"error", code:"service_unavailable", message:"Notion is down"})); process.exitCode = 1;
  } else {
    const count = fs.readFileSync(log, "utf8").trim().split("\\n").length;
    console.log(JSON.stringify({object:"page",id:"page-" + count,url:"https://app.notion.com/p/x"}));
  }
});
`, { mode: 0o755 });
  if (behaviour === "fail") fs.writeFileSync(path.join(directory, "fail"), "");
  return { script, log };
}

test("queues a failed save, retries it later and never saves a call twice", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notion-sync-test-"));
  const { script, log } = fakeNtn(directory, "fail");
  const previous = process.env.NTN_BIN;
  process.env.NTN_BIN = script;
  try {
    const sync = new NotionSync({
      ledgerPath: path.join(directory, "notion-sync.json"),
      getSettings: () => ({ notionSyncEnabled: true, notionDataSourceId: "ds-1" }),
    });

    await assert.rejects(sync.saveMeeting(meeting()), /Notion is down/);
    let ledger = JSON.parse(fs.readFileSync(path.join(directory, "notion-sync.json"), "utf8"));
    assert.equal(Object.keys(ledger.pending).length, 1);

    fs.rmSync(path.join(directory, "fail"));
    const { saved, failed } = await sync.retryPending();
    assert.equal(saved.length, 1);
    assert.equal(failed.length, 0);
    ledger = JSON.parse(fs.readFileSync(path.join(directory, "notion-sync.json"), "utf8"));
    assert.deepEqual(ledger.pending, {});
    assert.equal(Object.keys(ledger.synced).length, 1);

    const again = await sync.saveMeeting(meeting());
    assert.equal(again.duplicate, true);
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 2);
    const sent = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[1]);
    assert.equal(sent.parent.data_source_id, "ds-1");
  } finally {
    if (previous === undefined) delete process.env.NTN_BIN;
    else process.env.NTN_BIN = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does nothing when Notion sync is off or has no database", async () => {
  for (const settings of [
    { notionSyncEnabled: false, notionDataSourceId: "ds-1" },
    { notionSyncEnabled: true, notionDataSourceId: "" },
  ]) {
    const sync = new NotionSync({ ledgerPath: "/nonexistent/ledger.json", getSettings: () => settings });
    assert.equal(sync.enabled(), false);
    assert.deepEqual(await sync.saveMeeting(meeting()), { skipped: true });
  }
});
