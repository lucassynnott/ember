// Editing a recording by its transcript: the words, in the recording's time, and the cuts that remove them.
import { quietestBetween, type Levels } from "./levels"

export interface Word {
  text: string
  start: number
  end: number
}

export interface TranscriptLine {
  start: number
  end: number
  text: string
  words?: Word[]
}

/** Every word in order, each knowing the transcript line (paragraph) it's in. */
export function allWords(lines: TranscriptLine[]): (Word & { line: number; index: number })[] {
  const words: (Word & { line: number; index: number })[] = []
  lines.forEach((line, lineIndex) => {
    for (const word of line.words || []) words.push({ ...word, line: lineIndex, index: words.length })
  })
  return words
}

// Hesitations, not words: "um", "uh", "er", "ah", "hmm", "mm", in their usual spellings (as src/word-align.js).
const FILLER = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+|eh+)$/i

export function isFiller(text: string) {
  return FILLER.test(text.replace(/[^\p{L}]/gu, ""))
}

/**
 * The span of the recording that removes words `first` to `last`: from the quietest moment in the gap before the
 * first to the quietest in the gap after the last, so neighbouring words keep their edges and the cut is silent.
 */
export function wordsSpan(words: Word[], first: number, last: number, levels: Levels | null): [number, number] {
  const a = words[first]
  const b = words[last]
  const before = words[first - 1]
  const after = words[last + 1]
  const start = before ? quietestBetween(levels, before.end, a.start) : Math.max(0, a.start - 0.05)
  const end = after ? quietestBetween(levels, b.end, after.start) : b.end + 0.05
  return [Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000]
}

/** The cuts that remove every filler word, each as a span (joined when fillers are next to each other). */
export function fillerSpans(words: Word[], levels: Levels | null): [number, number][] {
  const spans: [number, number][] = []
  for (let index = 0; index < words.length; index += 1) {
    if (!isFiller(words[index].text)) continue
    let last = index
    while (last + 1 < words.length && isFiller(words[last + 1].text)) last += 1
    spans.push(wordsSpan(words, index, last, levels))
    index = last
  }
  return spans
}

/** Whether a word still plays: its middle is in the edited video. */
export function wordKept(word: Word, keptAt: (source: number) => boolean) {
  return keptAt((word.start + word.end) / 2)
}
