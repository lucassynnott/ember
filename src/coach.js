// Speaking coach: how you came across in a call. Talk share, pace, filler words, questions,
// interruptions and your longest stretch without a break. Everything is worked out on this Mac
// from the transcript; calls recorded before the coach existed get the measures that don't need timing.
const fs = require("node:fs/promises");
const path = require("node:path");
const { wordCount } = require("./stats");

// "like" is left out: it's a filler far less often than it's a real word.
const FILLERS = ["um", "uh", "erm", "you know", "i mean", "basically", "literally", "actually", "sort of", "kind of"];
const FILLER_PATTERN = new RegExp(`(?<![\\p{L}'])(${FILLERS.map((word) => word.replace(" ", "\\s+")).join("|")})(?![\\p{L}'])`, "giu");
// A new turn within this long of someone else still talking counts as cutting in.
const INTERRUPT_MARGIN_S = 0.6;
// Turns of yours with a gap shorter than this are one stretch of talking.
const MONOLOGUE_GAP_S = 2.5;

function countFillers(text) {
  const counts = {};
  for (const match of String(text).matchAll(FILLER_PATTERN)) {
    const word = match[1].toLowerCase().replace(/\s+/g, " ");
    counts[word] = (counts[word] || 0) + 1;
  }
  return counts;
}

function questionCount(text) {
  return (String(text).match(/\?/g) || []).length;
}

/**
 * segments: [{ speaker, text, you?, start?, end? }] in order, start/end in seconds from the call's start.
 * you: your name, used when a segment doesn't say whether it's yours.
 */
function coachStats(segments, { you = "" } = {}) {
  const lines = (segments || []).filter((segment) => segment?.text?.trim());
  const mine = (segment) => (typeof segment.you === "boolean" ? segment.you : Boolean(you) && segment.speaker === you);
  const yours = lines.filter(mine);
  const totalWords = lines.reduce((sum, segment) => sum + wordCount(segment.text), 0);
  const yourWords = yours.reduce((sum, segment) => sum + wordCount(segment.text), 0);
  if (!yourWords || !totalWords) return null;

  const fillers = {};
  for (const segment of yours) {
    for (const [word, count] of Object.entries(countFillers(segment.text))) fillers[word] = (fillers[word] || 0) + count;
  }
  const fillerTotal = Object.values(fillers).reduce((sum, count) => sum + count, 0);
  const timed = lines.every((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end >= segment.start);

  const stats = {
    timed,
    yourWords,
    totalWords,
    talkShare: yourWords / totalWords,
    fillers: fillerTotal,
    fillersPer100: (fillerTotal / yourWords) * 100,
    topFillers: Object.entries(fillers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word, count]) => ({ word, count })),
    questions: yours.reduce((sum, segment) => sum + questionCount(segment.text), 0),
    wordsPerMinute: null,
    longestMonologueSeconds: null,
    longestMonologueWords: 0,
    interruptions: null,
  };

  if (timed) {
    const yourSeconds = yours.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
    const allSeconds = lines.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
    // Time is the fairer talk share when it's known: it isn't skewed by how fast people speak.
    if (allSeconds > 0) stats.talkShare = yourSeconds / allSeconds;
    stats.wordsPerMinute = yourSeconds >= 20 ? Math.round(yourWords / (yourSeconds / 60)) : null;
    let interruptions = 0;
    const others = lines.filter((segment) => !mine(segment));
    for (const segment of yours) {
      if (others.some((other) => segment.start > other.start + INTERRUPT_MARGIN_S && segment.start < other.end - INTERRUPT_MARGIN_S)) interruptions += 1;
    }
    stats.interruptions = interruptions;
  }

  // Your longest stretch: your turns back to back, until someone else speaks or there's a long pause.
  let best = { seconds: 0, words: 0 };
  let run = null;
  for (const segment of lines) {
    if (!mine(segment)) {
      run = null;
      continue;
    }
    const words = wordCount(segment.text);
    if (run && (!timed || segment.start - run.end < MONOLOGUE_GAP_S)) {
      run.words += words;
      if (timed) run.end = segment.end;
    } else {
      run = { start: segment.start, end: segment.end, words };
    }
    const seconds = timed ? run.end - run.start : 0;
    if (timed ? seconds > best.seconds : run.words > best.words) best = { seconds, words: run.words };
  }
  stats.longestMonologueWords = best.words;
  if (timed) stats.longestMonologueSeconds = Math.round(best.seconds);
  return stats;
}

/** One week's calls together, weighted by how much you said in each. */
function combineStats(list) {
  const calls = list.filter(Boolean);
  if (!calls.length) return null;
  const words = calls.reduce((sum, stats) => sum + stats.yourWords, 0);
  const weighted = (key) => calls.reduce((sum, stats) => sum + stats[key] * stats.yourWords, 0) / words;
  const paced = calls.filter((stats) => stats.wordsPerMinute);
  const pacedWords = paced.reduce((sum, stats) => sum + stats.yourWords, 0);
  return {
    calls: calls.length,
    talkShare: weighted("talkShare"),
    fillersPer100: weighted("fillersPer100"),
    wordsPerMinute: paced.length ? Math.round(paced.reduce((sum, stats) => sum + stats.wordsPerMinute * stats.yourWords, 0) / pacedWords) : null,
    questions: calls.reduce((sum, stats) => sum + stats.questions, 0),
  };
}

/** Timed copies of each call's turns, kept beside the speaker files so older notes stay as they are. */
class CoachStore {
  constructor(folder) {
    this.folder = folder;
  }

  #file(stem) {
    return path.join(this.folder, `${path.basename(String(stem))}.json`);
  }

  async save(stem, segments) {
    const turns = segments
      .filter((segment) => segment.text?.trim())
      .map((segment) => ({ you: Boolean(segment.you), speaker: segment.speaker, start: segment.start, end: segment.end, text: segment.text }));
    // Without timing, the transcript in the note already has everything the coach can use.
    if (!turns.some((turn) => Number.isFinite(turn.start))) return;
    await fs.mkdir(this.folder, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.#file(stem), JSON.stringify({ version: 1, turns }), { mode: 0o600 });
  }

  async load(stem) {
    try {
      const data = JSON.parse(await fs.readFile(this.#file(stem), "utf8"));
      return Array.isArray(data.turns) ? data.turns : null;
    } catch {
      return null;
    }
  }

  async remove(stem) {
    await fs.rm(this.#file(stem), { force: true });
  }

  /** The stats for a call: timed when this Mac kept its turns, otherwise from the transcript. */
  async statsFor(meeting, { you }) {
    const turns = await this.load(meeting.id);
    return coachStats(turns || meeting.transcript || [], { you });
  }
}

module.exports = { CoachStore, FILLERS, coachStats, combineStats, countFillers };
