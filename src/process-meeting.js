const path = require("node:path");
const { transcribeAudio } = require("./transcription");
const { summarizeTranscript } = require("./summary");
const { formatMeetingNote, writeMeetingNote } = require("./note");

async function processMeeting({
  audioPath,
  notePath,
  startedAt,
  endedAt,
  settings,
  transcript,
  transcriptionProvider,
  onProgress,
  writeNote = true,
}) {
  const transcription = transcript?.trim()
    ? {
        text: transcript.trim(),
        provider: transcriptionProvider || "Parakeet TDT 0.6B v3",
      }
    : await transcribeAudio(audioPath, settings, onProgress);
  const summary = await summarizeTranscript(transcription.text, settings, onProgress);

  const analysis = {
    ...summary,
    transcriptionProvider: transcription.provider,
    summaryProvider: summary.provider,
  };
  const markdown = formatMeetingNote({
    startedAt,
    endedAt,
    transcript: transcription.text,
    analysis,
    audioFileName: path.basename(audioPath),
  });

  if (writeNote) {
    onProgress("Saving meeting note…");
    await writeMeetingNote(notePath, markdown);
  }
  return { notePath, audioPath, analysis, transcript: transcription.text, markdown, noteWritten: writeNote };
}

module.exports = { processMeeting };
