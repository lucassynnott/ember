// Captions from the recording's transcript (made on this Mac when it was recorded): phrases split
// at sentence ends, at most 12 seconds and at least 0.8, with each word's timing for highlighting.
import { newId, type Caption, type CaptionWord } from "./model"

const MAX_PHRASE = 12
const MIN_PHRASE = 0.8
const MERGE_GAP = 0.4
const MERGE_UP_TO = 2.5
const MERGE_CHARS = 80

/** Words across a stretch of time, each getting time in proportion to its length. */
function spread(text: string, start: number, end: number): CaptionWord[] {
  const words = text.split(/\s+/).filter(Boolean)
  const weights = words.map((word) => Math.max(2, word.replace(/[^\p{L}\p{N}]/gu, "").length) + (/[.,!?;:]$/.test(word) ? 2 : 0))
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
  let at = start
  return words.map((word, index) => {
    const length = ((end - start) * weights[index]) / total
    const timed = { text: word, start: Math.round(at * 1000) / 1000, end: Math.round((at + length) * 1000) / 1000 }
    at += length
    return timed
  })
}

const ABBREVIATIONS = /\b(mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|inc|ltd)\.$/i

/** Splits words into phrases at sentence ends, and so none is longer than 12 seconds. */
function phrases(words: CaptionWord[]): CaptionWord[][] {
  const result: CaptionWord[][] = []
  let current: CaptionWord[] = []
  for (const word of words) {
    current.push(word)
    const sentenceEnd = /[.!?]["')\]]?$/.test(word.text) && !ABBREVIATIONS.test(word.text)
    const long = word.end - current[0].start >= MAX_PHRASE
    if ((sentenceEnd && word.end - current[0].start >= MIN_PHRASE) || long) {
      result.push(current)
      current = []
    }
  }
  if (current.length) result.push(current)
  return result
}

/** Captions from transcript lines ({ start, end, text } in the recording's time). */
export function captionsFromTranscript(lines: { start: number; end: number; text: string; words?: CaptionWord[] }[]): Caption[] {
  // Each word's real timing when the transcript has been timed word by word, otherwise spread across its line.
  const words = lines
    .filter((line) => line.text.trim() && line.end > line.start)
    .flatMap((line) => (line.words?.length ? line.words.map((word) => ({ text: word.text, start: word.start, end: word.end })) : spread(line.text.trim(), line.start, line.end)))
  const captions: Caption[] = []
  for (const phrase of phrases(words)) {
    const caption: Caption = { id: newId("t"), start: phrase[0].start, end: phrase[phrase.length - 1].end, text: phrase.map((word) => word.text).join(" "), words: phrase }
    const previous = captions[captions.length - 1]
    // Very short phrases right after another join it.
    if (
      previous &&
      caption.start - previous.end <= MERGE_GAP &&
      (caption.end - caption.start < MERGE_UP_TO || previous.end - previous.start < MIN_PHRASE) &&
      previous.text.length + caption.text.length + 1 <= MERGE_CHARS
    ) {
      previous.end = caption.end
      previous.text = `${previous.text} ${caption.text}`
      previous.words = [...previous.words, ...caption.words]
      continue
    }
    captions.push(caption)
  }
  return captions
}

/** A caption with new text: the words are spread again over its time. */
export function retextCaption(caption: Caption, text: string): Caption {
  return { ...caption, text, words: spread(text, caption.start, caption.end) }
}

export function retimeCaption(caption: Caption, start: number, end: number): Caption {
  return { ...caption, start, end, words: spread(caption.text, start, end) }
}

/** Splits a caption at a moment, between words. */
export function splitCaption(caption: Caption, at: number): [Caption, Caption] | null {
  const index = caption.words.findIndex((word) => word.start >= at)
  if (index <= 0 || index >= caption.words.length) return null
  const first = caption.words.slice(0, index)
  const second = caption.words.slice(index)
  return [
    { ...caption, end: first[first.length - 1].end, text: first.map((word) => word.text).join(" "), words: first },
    { id: newId("t"), start: second[0].start, end: caption.end, text: second.map((word) => word.text).join(" "), words: second },
  ]
}

export function mergeCaptions(first: Caption, second: Caption): Caption {
  return { ...first, end: second.end, text: `${first.text} ${second.text}`, words: [...first.words, ...second.words] }
}

const vttTime = (seconds: number) => {
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${(total % 60).toFixed(3).padStart(6, "0")}`
}

/** Captions as a WebVTT file, in the edited video's time. */
export function captionsVtt(captions: Caption[], toEdited: (source: number) => number | null) {
  const cues = captions
    .map((caption) => {
      const start = toEdited(caption.start)
      const end = toEdited(Math.max(caption.start, caption.end - 0.01))
      if (start === null || end === null || end <= start) return null
      return `${vttTime(start)} --> ${vttTime(end)}\n${caption.text.replace(/-->/g, "→")}`
    })
    .filter(Boolean)
  return `WEBVTT\n\n${cues.join("\n\n")}\n`
}
