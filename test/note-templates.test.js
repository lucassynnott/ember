const test = require("node:test");
const assert = require("node:assert/strict");
const { templateFor, templatePrompt } = require("../src/note-templates");
const { normalizeAnalysis } = require("../src/summary");
const { formatMeetingNote } = require("../src/note");
const { parseNote } = require("../src/library");

test("the template follows the call's choice, then the setting, then the calendar title", () => {
  assert.equal(templateFor({ title: "Acme demo" }).id, "sales");
  assert.equal(templateFor({ title: "Weekly 1:1 with Priya" }).id, "one-on-one");
  assert.equal(templateFor({ title: "Daily standup" }).id, "standup");
  assert.equal(templateFor({ title: "Candidate interview: Sam" }).id, "interview");
  assert.equal(templateFor({ title: "Lunch" }).id, "general");
  assert.equal(templateFor({ setting: "interview", title: "Acme demo" }).id, "interview");
  assert.equal(templateFor({ chosen: "standup", setting: "interview", title: "Acme demo" }).id, "standup");
  assert.match(templatePrompt(templateFor({ title: "Acme demo" })), /"Objections"/);
  assert.equal(templatePrompt(templateFor({ title: "Lunch" })), "");
});

test("template sections go from the model's JSON into the note and back", () => {
  const analysis = normalizeAnalysis(
    JSON.stringify({
      title: "Acme renewal",
      summary: ["One."],
      decisions: [],
      actionItems: [],
      sections: [
        { heading: "Objections", items: ["Price feels high next to Otter", "Timing this quarter"] },
        { heading: "## Next steps", items: ["Send the comparison by Wednesday"] },
        { heading: "Budget and timeline", items: [] },
      ],
    }),
  );
  assert.deepEqual(analysis.sections.map((section) => section.heading), ["Objections", "Next steps", "Budget and timeline"]);
  const markdown = formatMeetingNote({
    startedAt: new Date(2026, 9, 5, 11),
    endedAt: new Date(2026, 9, 5, 11, 30),
    transcript: "Dana Lee: It's expensive.",
    audioFileName: "x.webm",
    analysis: { ...analysis, template: "Sales call", transcriptionProvider: "Phonon-2", summaryProvider: "OpenRouter" },
  });
  assert.match(markdown, /- \*\*Template:\*\* Sales call/);
  assert.match(markdown, /## Objections\n\n- Price feels high next to Otter/);
  const note = parseNote(markdown);
  assert.equal(note.template, "Sales call");
  assert.deepEqual(note.sections, [
    { heading: "Objections", items: ["Price feels high next to Otter", "Timing this quarter"] },
    { heading: "Next steps", items: ["Send the comparison by Wednesday"] },
    { heading: "Budget and timeline", items: [] },
  ]);
  assert.equal(note.summary[0], "One.");
});
