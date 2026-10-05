const test = require("node:test");
const assert = require("node:assert/strict");
const { callNoteCommand } = require("../src/call-notes");

test("spoken call-notes commands are recognised; ordinary dictation isn't", () => {
  assert.deepEqual(callNoteCommand("Action item: Priya sends pricing Thursday."), { kind: "action", line: "Action item: Priya sends pricing Thursday" });
  assert.deepEqual(callNoteCommand("action item priya sends pricing thursday"), { kind: "action", line: "Action item: Priya sends pricing thursday" });
  assert.deepEqual(callNoteCommand("Todo, book the follow-up"), { kind: "action", line: "Action item: Book the follow-up" });
  assert.deepEqual(callNoteCommand("Decision - we launch on the 14th"), { kind: "decision", line: "Decision: We launch on the 14th" });
  assert.deepEqual(callNoteCommand("Note: Dana prefers quarterly billing"), { kind: "note", line: "Dana prefers quarterly billing" });
  assert.deepEqual(callNoteCommand("Add a note the deck needs a pricing slide"), { kind: "note", line: "The deck needs a pricing slide" });
  assert.equal(callNoteCommand("Notes from yesterday are in the doc"), null, "a word that only starts the same");
  assert.equal(callNoteCommand("I'll note that down later"), null);
  assert.equal(callNoteCommand("Action item."), null, "nothing after the command");
});
