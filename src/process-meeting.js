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
  userNotes = "",
  attendees = [],
  title = "",
  slides = [],
}) {
  const transcription = transcript?.trim()
    ? {
        text: transcript.trim(),
        provider: transcriptionProvider || "Parakeet TDT 0.6B v3",
      }
    : await transcribeAudio(audioPath, settings, onProgress);
  const summary = await summarizeTranscript(transcription.text, settings, onProgress, { userNotes, sharedScreens: slides });

  const analysis = {
    ...summary,
    // The calendar event's name beats the AI's guess.
    title: title || summary.title,
    // Captions from the notes, matched to the slides captured during the call.
    slides: slides.map((slide, index) => ({
      time: slide.time,
      image: slide.image,
      caption: summary.screens?.find((screen) => screen.slide === index + 1)?.caption || "",
    })),
    transcriptionProvider: transcription.provider,
    summaryProvider: summary.provider,
    attendees,
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
