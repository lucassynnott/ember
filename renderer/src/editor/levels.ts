// The recording's sound level every 10 ms (from the record helper), and what the editor reads from it: loudness on
// a decibel scale (so quiet speech still shows), where it's silent, and which pauses are long.

export interface Levels {
  /** Readings per second. */
  rate: number
  /** The loudest sample of each reading, 0 to 1 of full scale. */
  peak: number[]
  /** The RMS level of each reading, 0 to 1 of full scale. */
  rms: number[]
}

/** The decibel range the waveform shows: −54 dB (barely there) to 0 dB (full scale). */
export const FLOOR_DB = -54

export function toDb(value: number) {
  return value > 0 ? 20 * Math.log10(value) : -120
}

/** A level as a height from 0 to 1 on the waveform's decibel scale. */
export function dbHeight(value: number) {
  return Math.min(1, Math.max(0, (toDb(value) - FLOOR_DB) / -FLOOR_DB))
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return -120
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

/**
 * The level below which the recording counts as silent: a little above its own background noise, worked out from
 * the recording itself so a noisy room and a quiet one both read right.
 */
export function silenceThreshold(levels: Levels) {
  const db = levels.rms.filter((value) => value > 0).map(toDb)
  const floor = percentile(db, 0.08)
  const speech = percentile(db, 0.85)
  return Math.max(floor + 6, Math.min(speech - 18, floor + (speech - floor) * 0.35), -62)
}

/** Silent stretches at least `minimum` seconds long, as [start, end] in the recording's time. */
export function silences(levels: Levels, minimum = 0.35, threshold = silenceThreshold(levels)): [number, number][] {
  const spans: [number, number][] = []
  let from = -1
  for (let index = 0; index <= levels.rms.length; index += 1) {
    const quiet = index < levels.rms.length && toDb(levels.rms[index]) < threshold
    if (quiet && from < 0) from = index
    if (!quiet && from >= 0) {
      if ((index - from) / levels.rate >= minimum) spans.push([from / levels.rate, index / levels.rate])
      from = -1
    }
  }
  return spans
}

/**
 * The cuts that shorten pauses longer than `longest` seconds down to `keep` seconds (half kept each side, so speech
 * isn't clipped), within [from, to] of the recording.
 */
export function pauseCuts(levels: Levels, longest: number, keep = 0.3, within?: [number, number]): [number, number][] {
  return silences(levels, longest)
    .filter(([start, end]) => !within || (start >= within[0] && end <= within[1]))
    .map(([start, end]): [number, number] => [start + keep / 2, end - keep / 2])
    .filter(([start, end]) => end - start > 0.05)
}

/** How loud a stretch is, for its colour: "quiet", "normal", "loud" or "clipping". */
export function loudness(peak: number, rms: number): "quiet" | "normal" | "loud" | "clipping" {
  if (peak >= 0.98) return "clipping"
  const db = toDb(rms)
  if (db > -6) return "loud"
  if (db < -36) return "quiet"
  return "normal"
}

/** The loudest peak and RMS between two times of the recording. */
export function levelAt(levels: Levels, start: number, end: number) {
  const from = Math.max(0, Math.floor(start * levels.rate))
  const to = Math.min(levels.rms.length, Math.max(from + 1, Math.ceil(end * levels.rate)))
  let peak = 0
  let rms = 0
  for (let index = from; index < to; index += 1) {
    peak = Math.max(peak, levels.peak[index] || 0)
    rms = Math.max(rms, levels.rms[index] || 0)
  }
  return { peak, rms }
}

/** The quietest moment between two times, for placing a cut where it won't be heard. */
export function quietestBetween(levels: Levels | null, start: number, end: number) {
  if (!levels || !(end > start)) return (start + end) / 2
  const from = Math.max(0, Math.floor(start * levels.rate))
  const to = Math.min(levels.rms.length - 1, Math.ceil(end * levels.rate))
  let best = from
  for (let index = from; index <= to; index += 1) if ((levels.rms[index] ?? 1) < (levels.rms[best] ?? 1)) best = index
  return Math.min(end, Math.max(start, best / levels.rate))
}
