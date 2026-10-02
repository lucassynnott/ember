const fs = require("node:fs/promises");
const path = require("node:path");

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatFileStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

async function allocateMeetingPaths(notesDir, startedAt) {
  await fs.mkdir(notesDir, { recursive: true });
  const base = formatFileStamp(startedAt);

  for (let sequence = 1; ; sequence += 1) {
    const suffix = sequence === 1 ? "" : `-${sequence}`;
    const stem = path.join(notesDir, `${base}${suffix}`);
    const notePath = `${stem}.md`;
    const audioPath = `${stem}.webm`;

    try {
      await fs.access(notePath);
    } catch {
      try {
        await fs.access(audioPath);
      } catch {
        return { stem, notePath, audioPath };
      }
    }
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function bullets(items, emptyLabel = "None captured.") {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${emptyLabel}`;
}

// The user's own notes, each followed by what the transcript adds.
function yourNotesLines(yourNotes = []) {
  return yourNotes.map(({ note, detail }) => (detail ? `- **${note}** — ${detail}` : `- **${note}**`)).join("\n");
}

// "## Shared on screen": each slide's time, a caption and the image beside the note.
function sharedScreenLines(slides = []) {
  return slides
    .map((slide, index) => `### ${slide.time} · ${slide.caption || `Slide ${index + 1}`}\n\n![Slide ${index + 1}](${slide.image})`)
    .join("\n\n");
}

function formatMeetingNote({ startedAt, endedAt, transcript, analysis, audioFileName }) {
  const actions = analysis.actionItems.length
    ? analysis.actionItems
        .map(({ owner, task }) => `- [ ] **${owner || "Unassigned"}** — ${task}`)
        .join("\n")
    : "- None captured.";

  return [
    `# ${analysis.title || "Meeting Notes"} — ${startedAt.toLocaleString()}`,
    "",
    `- **Duration:** ${formatDuration(endedAt.getTime() - startedAt.getTime())}`,
    `- **Audio:** [${audioFileName}](./${encodeURIComponent(audioFileName)})`,
    `- **Transcription:** ${analysis.transcriptionProvider}`,
    `- **Summary model:** ${analysis.summaryProvider}`,
    ...(analysis.attendees?.length ? [`- **Attendees:** ${analysis.attendees.join(", ")}`] : []),
    "",
    ...(analysis.yourNotes?.length ? ["## Your notes", "", yourNotesLines(analysis.yourNotes), ""] : []),
    "## Summary",
    "",
    bullets(analysis.summary),
    "",
    "## Decisions made",
    "",
    bullets(analysis.decisions),
    "",
    "## Action items",
    "",
    actions,
    "",
    ...(analysis.slides?.length ? ["## Shared on screen", "", sharedScreenLines(analysis.slides), ""] : []),
    "---",
    "",
    "## Full transcript",
    "",
    transcript.trim() || "_No speech was transcribed._",
    "",
  ].join("\n");
}

async function writeMeetingNote(notePath, content) {
  const temporaryPath = `${notePath}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, notePath);
}

module.exports = {
  yourNotesLines,
  allocateMeetingPaths,
  formatFileStamp,
  formatMeetingNote,
  writeMeetingNote,
};
