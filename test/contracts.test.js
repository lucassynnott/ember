const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");
const { pickPreferredMicrophone } = require("../src/capture-config");
const { formatFileStamp, formatMeetingNote } = require("../src/note");
const { normalizeAnalysis, splitTranscript } = require("../src/summary");

test("selects the mapped Microphone despite Chromium's device suffix", () => {
  const selected = pickPreferredMicrophone([
    { kind: "audioinput", label: "Music (Aggregate)", deviceId: "music" },
    { kind: "audioinput", label: "Microphone (Virtual)", deviceId: "main-mic" },
    { kind: "audioinput", label: "Default - Microphone (Virtual)", deviceId: "default" },
  ]);

  assert.equal(selected.deviceId, "main-mic");
});

test("writes the required note sections and keeps the transcript below the divider", () => {
  const startedAt = new Date(2026, 6, 30, 9, 5, 0);
  const markdown = formatMeetingNote({
    startedAt,
    endedAt: new Date(startedAt.getTime() + 65000),
    transcript: "Alice said ship Friday.",
    audioFileName: "2026-07-30-0905.webm",
    analysis: {
      summary: ["One", "Two", "Three", "Four", "Five"],
      decisions: ["Ship Friday"],
      actionItems: [{ owner: "Alice", task: "Prepare release notes" }],
      transcriptionProvider: "whisper.cpp (ggml-medium.bin)",
      summaryProvider: "Ollama (qwen3.6:27b)",
    },
  });

  assert.equal(formatFileStamp(startedAt), "2026-07-30-0905");
  assert.equal(markdown.match(/^## Summary$/gm)?.length, 1);
  assert.match(markdown, /## Decisions made[\s\S]*- Ship Friday/);
  assert.match(markdown, /- \[ \] \*\*Alice\*\* — Prepare release notes/);
  assert.ok(markdown.indexOf("---") < markdown.indexOf("## Full transcript"));
  assert.ok(markdown.indexOf("## Full transcript") < markdown.indexOf("Alice said ship Friday."));
});

test("normalizes LLM output to exactly five summary bullets", () => {
  const analysis = normalizeAnalysis(
    JSON.stringify({
      summary: ["One", "Two"],
      decisions: [],
      actionItems: [{ owner: "", task: "Follow up" }],
    }),
  );

  assert.equal(analysis.summary.length, 5);
  assert.deepEqual(analysis.actionItems, [{ owner: "Unassigned", task: "Follow up" }]);
});

test("splits long transcripts without dropping content", () => {
  const transcript = `${"a".repeat(100)}. ${"b".repeat(100)}. ${"c".repeat(100)}`;
  const chunks = splitTranscript(transcript, 120);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("").replace(/\s/g, ""), transcript.replace(/\s/g, ""));
});

test("renders the waveform menu bar icon and its recording frames", () => {
  const probePath = path.join(__dirname, "..", "scripts", "tray-icon-probe.cjs");
  const result = spawnSync(electronPath, [probePath], {
    encoding: "utf8",
    timeout: 60000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TRAY_ICON_OK/);
});
