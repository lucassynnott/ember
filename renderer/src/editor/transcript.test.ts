import { describe, expect, test } from "bun:test"

import { dbHeight, loudness, pauseCuts, silenceThreshold, silences, type Levels } from "./levels"
import { allWords, fillerSpans, isFiller, wordsSpan } from "./transcript"

/** Levels at 100 a second: speech (−20 dB) where `speaking` says so, room noise (−60 dB) elsewhere. */
function levels(seconds: number, speaking: (t: number) => boolean): Levels {
  const rms: number[] = []
  const peak: number[] = []
  for (let index = 0; index < seconds * 100; index += 1) {
    const loud = speaking(index / 100)
    rms.push(loud ? 0.1 : 0.001)
    peak.push(loud ? 0.4 : 0.003)
  }
  return { rate: 100, rms, peak }
}

describe("the waveform's levels", () => {
  test("heights are on a decibel scale, so quiet speech still shows", () => {
    expect(dbHeight(1)).toBe(1)
    expect(dbHeight(0)).toBe(0)
    expect(dbHeight(0.01)).toBeGreaterThan(0.2) // −40 dB is still visible
    expect(dbHeight(0.001)).toBe(0) // −60 dB, below the floor
  })

  test("silences are found against the recording's own background noise", () => {
    const sound = levels(10, (t) => t < 3 || (t > 4.5 && t < 8))
    const threshold = silenceThreshold(sound)
    expect(threshold).toBeGreaterThan(-60)
    expect(threshold).toBeLessThan(-20)
    const spans = silences(sound, 0.35)
    expect(spans.length).toBe(2)
    expect(spans[0][0]).toBeCloseTo(3, 1)
    expect(spans[0][1]).toBeCloseTo(4.5, 1)
  })

  test("long pauses are shortened, keeping a little silence each side", () => {
    const sound = levels(10, (t) => t < 3 || (t > 4.5 && t < 5) || t > 5.4)
    const cuts = pauseCuts(sound, 1, 0.3)
    expect(cuts.length).toBe(1) // the 0.4 s pause is left alone
    expect(cuts[0][0]).toBeCloseTo(3.15, 1)
    expect(cuts[0][1]).toBeCloseTo(4.35, 1)
  })

  test("loudness reads as quiet, normal, loud or clipping", () => {
    expect(loudness(0.01, 0.005)).toBe("quiet")
    expect(loudness(0.4, 0.1)).toBe("normal")
    expect(loudness(0.9, 0.6)).toBe("loud")
    expect(loudness(1, 0.5)).toBe("clipping")
  })
})

describe("the transcript's words", () => {
  const lines = [
    { start: 0, end: 4, text: "So um this works", words: [{ text: "So", start: 0.2, end: 0.5 }, { text: "um", start: 0.8, end: 1.1 }, { text: "this", start: 1.4, end: 1.7 }, { text: "works", start: 1.8, end: 2.3 }] },
    { start: 4, end: 6, text: "uh, uh okay", words: [{ text: "uh,", start: 4.2, end: 4.4 }, { text: "uh", start: 4.5, end: 4.7 }, { text: "okay", start: 5, end: 5.4 }] },
  ]

  test("words come in order with their paragraph", () => {
    const words = allWords(lines)
    expect(words.map((word) => word.text).join(" ")).toBe("So um this works uh, uh okay")
    expect(words[4].line).toBe(1)
  })

  test("a word's cut runs through the gaps either side, not into the next word", () => {
    const words = allWords(lines)
    const [start, end] = wordsSpan(words, 1, 1, null)
    expect(start).toBeGreaterThan(0.5)
    expect(start).toBeLessThan(0.8)
    expect(end).toBeGreaterThan(1.1)
    expect(end).toBeLessThan(1.4)
  })

  test("fillers are found, and next-to-each-other ones go in one cut", () => {
    expect(isFiller("Um,")).toBe(true)
    expect(isFiller("umbrella")).toBe(false)
    const spans = fillerSpans(allWords(lines), null)
    expect(spans.length).toBe(2)
    expect(spans[1][0]).toBeLessThan(4.2)
    expect(spans[1][1]).toBeGreaterThan(4.7)
    expect(spans[1][1]).toBeLessThan(5)
  })
})
