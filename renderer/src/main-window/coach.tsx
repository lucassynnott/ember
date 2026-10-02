import { useEffect, useState } from "react"

import type { CoachStats, CoachWeek } from "@/types/bridge"

const percent = (value: number) => `${Math.round(value * 100)}%`

function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

/** The one thing most worth working on, or a note that it went well. */
export function coachTip(stats: CoachStats) {
  const top = stats.topFillers[0]
  if (stats.talkShare > 0.65 && stats.totalWords - stats.yourWords > 80)
    return "You did most of the talking. A question or two more would give the others room."
  if (stats.fillersPer100 >= 4 && top) return `“${top.word}” came up ${top.count} times. A short pause reads as more sure than a filler.`
  if (stats.interruptions !== null && stats.interruptions >= 3) return `You started talking over someone ${stats.interruptions} times. Let them finish first.`
  if (stats.wordsPerMinute !== null && stats.wordsPerMinute > 180) return "You spoke quickly. Slowing down a little makes key points easier to follow."
  if (stats.longestMonologueSeconds !== null && stats.longestMonologueSeconds > 150)
    return `Your longest stretch ran ${duration(stats.longestMonologueSeconds)}. Check in with the others more often.`
  if (stats.talkShare < 0.15 && stats.totalWords > 400) return "You were quiet in this one. Fine for listening; on your own calls, speak up more."
  return "A good balance: steady pace, few fillers and room for everyone."
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-1">
      <dt className="text-[12px] leading-4 text-faint">{label}</dt>
      <dd className="tabular text-[18px] leading-6 text-foreground">{value}</dd>
    </div>
  )
}

/** How you came across in one call. */
export function SpeakingCoach({ meetingId }: { meetingId: string }) {
  const [stats, setStats] = useState<CoachStats | null | undefined>(undefined)
  useEffect(() => {
    let current = true
    setStats(undefined)
    void window.meetingRecorder
      .coachStats(meetingId)
      .then((result) => current && setStats(result))
      .catch(() => current && setStats(null))
    return () => {
      current = false
    }
  }, [meetingId])

  if (!stats) return null
  const others = 1 - stats.talkShare
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-foreground">
            You <span className="tabular text-gold">{percent(stats.talkShare)}</span>
          </span>
          <span className="tabular text-muted-foreground">Others {percent(others)}</span>
        </div>
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`You talked ${percent(stats.talkShare)} of the call`}>
          <div className="rounded-l-full gold-fill" style={{ width: percent(stats.talkShare) }} />
          <div className="flex-1 rounded-r-full bg-foreground/15" />
        </div>
      </div>
      <dl
        className="grid gap-x-4 gap-y-3 rounded-lg border border-border bg-panel px-4 py-3"
        style={{ gridTemplateColumns: `repeat(${3 + (stats.wordsPerMinute !== null ? 1 : 0) + (stats.interruptions !== null ? 1 : 0)}, minmax(0, 1fr))` }}
      >
        {stats.wordsPerMinute !== null ? <Stat label="Pace" value={`${stats.wordsPerMinute} wpm`} /> : null}
        <Stat label="Fillers per 100" value={stats.fillersPer100.toFixed(1)} />
        <Stat label="Questions asked" value={String(stats.questions)} />
        {stats.interruptions !== null ? <Stat label="Talked over others" value={String(stats.interruptions)} /> : null}
        <Stat
          label="Longest stretch"
          value={stats.longestMonologueSeconds !== null ? duration(stats.longestMonologueSeconds) : `${stats.longestMonologueWords} words`}
        />
      </dl>
      <p className="text-[14px] leading-[1.5] text-foreground/85">{coachTip(stats)}</p>
      {stats.topFillers.length ? (
        <p className="text-[13px] text-muted-foreground">
          Your fillers: {stats.topFillers.map((filler) => `${filler.word} ${filler.count}`).join(", ")}
          {stats.wordsPerMinute !== null ? ". A pace of 130 to 170 wpm is easy to follow." : "."}
        </p>
      ) : null}
      {!stats.timed ? <p className="text-[12px] text-faint">Pace and talking over others are measured on calls recorded from version 1.9 on.</p> : null}
    </div>
  )
}

export function useCoachWeek(refresh: unknown) {
  const [week, setWeek] = useState<CoachWeek | null>(null)
  useEffect(() => {
    void window.meetingRecorder.coachWeek().then(setWeek).catch(() => setWeek(null))
  }, [refresh])
  return week
}
