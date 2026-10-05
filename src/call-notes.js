// Dictating into a live call: "note …", "action item …" or "decision …" during a recording goes
// into that call's notes instead of the app you're in.

const COMMAND = /^\s*(?:(?:add\s+(?:a\s+)?)?note|action\s+item|to-?do|decision)\b[\s:,.\-–]*/i;

/** { kind, line } for a call-notes command, or null for ordinary dictation. */
function callNoteCommand(text) {
  const raw = String(text || "").trim();
  const match = COMMAND.exec(raw);
  if (!match) return null;
  const body = raw.slice(match[0].length).trim().replace(/[.\s]+$/, "");
  if (body.length < 3) return null;
  const word = match[0].trim().toLowerCase();
  const kind = word.startsWith("decision") ? "decision" : word.startsWith("note") || word.startsWith("add") ? "note" : "action";
  const sentence = body.charAt(0).toUpperCase() + body.slice(1);
  const line = kind === "action" ? `Action item: ${sentence}` : kind === "decision" ? `Decision: ${sentence}` : sentence;
  return { kind, line };
}

module.exports = { callNoteCommand };
