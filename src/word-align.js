// Word timings for a recording's transcript, so it can be edited word by word. Parakeet gives real timings; for
// other models (Phonon, Whisper), each line's words are laid over the stretches where someone is actually speaking,
// weighted by syllables, with edges moved to the pauses and dips between words.

const FRAME = 0.01; // seconds per loudness reading

/** Loudness in decibels, every 10 ms, for samples between two times. */
function framesDb(samples, start, end, rate) {
  const size = Math.max(1, Math.round(rate * FRAME));
  const from = Math.max(0, Math.floor(start * rate));
  const to = Math.min(samples.length, Math.ceil(end * rate));
  const db = [];
  for (let at = from; at < to; at += size) {
    let sum = 0;
    const stop = Math.min(to, at + size);
    for (let index = at; index < stop; index += 1) sum += samples[index] * samples[index];
    const rms = Math.sqrt(sum / Math.max(1, stop - at));
    db.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  return db;
}

function percentile(values, fraction) {
  if (!values.length) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

/** Where someone is speaking within a line, as frame ranges [from, to), with short gaps and blips smoothed out. */
function speechRuns(db) {
  const floor = percentile(db, 0.1);
  const loud = percentile(db, 0.9);
  const threshold = Math.max(floor + 6, floor + (loud - floor) * 0.3);
  const voiced = db.map((value) => value > threshold);
  // Fill gaps under 60 ms (inside words), then drop blips under 40 ms (clicks).
  for (let index = 0; index < voiced.length; ) {
    if (voiced[index]) {
      index += 1
      continue
    }
    let end = index;
    while (end < voiced.length && !voiced[end]) end += 1;
    if (index > 0 && end < voiced.length && end - index < 6) for (let fill = index; fill < end; fill += 1) voiced[fill] = true;
    index = end;
  }
  const runs = [];
  for (let index = 0; index < voiced.length; ) {
    if (!voiced[index]) {
      index += 1
      continue
    }
    let end = index;
    while (end < voiced.length && voiced[end]) end += 1;
    if (end - index >= 4) runs.push([index, end]);
    index = end;
  }
  return runs.length ? runs : [[0, db.length]];
}

/** A rough syllable count: groups of vowels, at least one; numbers and symbols count by their length. */
function syllables(word) {
  const letters = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!letters) return 1;
  if (/^\d+$/.test(letters)) return Math.max(1, letters.length);
  const groups = letters.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** The quietest frame near a frame, within a window, so a word edge lands in the dip between words. */
function quietest(db, around, reach) {
  let best = around;
  for (let index = Math.max(0, around - reach); index <= Math.min(db.length - 1, around + reach); index += 1) if (db[index] < db[best]) best = index;
  return best;
}

const round = (value) => Math.round(value * 1000) / 1000;

/** One line's words timed against its sound: { text, start, end } in seconds of the recording. */
function alignLine(samples, line, rate) {
  const words = String(line.text || "").split(/\s+/).filter(Boolean);
  if (!words.length || !(line.end > line.start)) return [];
  const db = framesDb(samples, line.start, line.end, rate);
  if (!db.length) return [];
  const runs = speechRuns(db);
  // The speaking frames, back to back, and each word's share of them.
  const spoken = runs.reduce((sum, [from, to]) => sum + (to - from), 0);
  const weights = words.map((word) => syllables(word) + (/[.,!?;:]$/.test(word) ? 0.3 : 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const toFrame = (position) => {
    // A position along the spoken frames, mapped back to a frame of the line.
    let left = position;
    for (const [from, to] of runs) {
      if (left <= to - from) return from + left;
      left -= to - from;
    }
    return runs[runs.length - 1][1];
  };
  const edges = [0];
  let acc = 0;
  for (const weight of weights) {
    acc += weight;
    edges.push((acc / total) * spoken);
  }
  // Edges that fall inside speech move to the quietest moment nearby; edges at a run's end stay on the pause.
  const frames = edges.map((position, index) => {
    const frame = toFrame(position);
    if (index === 0 || index === edges.length - 1) return Math.round(frame);
    const atRunEdge = runs.some(([from, to]) => Math.abs(frame - from) < 2 || Math.abs(frame - to) < 2);
    return atRunEdge ? Math.round(frame) : quietest(db, Math.round(frame), 6);
  });
  for (let index = 1; index < frames.length; index += 1) frames[index] = Math.max(frames[index], frames[index - 1] + 1);
  return words.map((text, index) => ({
    text,
    start: round(line.start + frames[index] * FRAME),
    end: round(Math.min(line.end, line.start + frames[index + 1] * FRAME)),
  }));
}

/** Transcript lines with each word timed against the sound (`samples` at `rate`, mono, -1 to 1). */
function alignWords(samples, lines, rate = 16000) {
  return lines.map((line) => ({ ...line, words: alignLine(samples, line, rate) }));
}

/** Words from Parakeet (times within the piece starting at `offset`), as words of the recording. */
function offsetWords(words, offset) {
  return (words || [])
    .filter((word) => String(word.text || "").trim())
    .map((word) => ({ text: String(word.text).trim(), start: round(offset + Number(word.start || 0)), end: round(offset + Number(word.end || 0)) }));
}

// Hesitations, not words: "um", "uh", "er", "ah", "hmm", "mm", in their usual spellings.
const FILLER = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+|eh+)$/i;

/** Whether a transcript word is a filler like "um" or "uh". */
function isFiller(text) {
  return FILLER.test(String(text || "").replace(/[^\p{L}]/gu, ""));
}

module.exports = { alignWords, alignLine, offsetWords, isFiller, syllables, speechRuns, framesDb };
