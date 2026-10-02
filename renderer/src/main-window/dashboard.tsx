import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Calendar03Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  KeyboardIcon,
  Mic01Icon,
  UserGroupIcon,
  Video01Icon,
  VoiceIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SPEAKER_PALETTE } from "@/lib/speaker-colors"
import { cn } from "@/lib/utils"
import type { DashboardStats, TodayEvent } from "@/types/bridge"

import { useCoachWeek } from "./coach"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function formatNumber(value: number) {
  return value >= 10_000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : value.toLocaleString()
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return { value: String(minutes), unit: "min" }
  const hours = minutes / 60
  return { value: hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1), unit: hours === 1 ? "hour" : "hours" }
}

function clock(time: number) {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

/* Pieces */

function Tile({
  title,
  icon,
  className,
  children,
}: {
  title: string
  icon: typeof Clock01Icon
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-panel p-5", className)}>
      <h2 className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-3.5 text-gold" />
        {title}
      </h2>
      {children}
    </section>
  )
}

function Footnotes({ items }: { items: [string, string][] }) {
  return (
    <dl className="mt-auto grid grid-cols-2 gap-3 border-t border-border pt-3">
      {items.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-[11px] text-faint">{label}</dt>
          <dd className="tabular text-[14px] font-medium text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function BigNumber({ value, unit, note }: { value: string; unit?: string; note?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-baseline gap-1.5">
        <span className="tabular gold-text text-[34px] leading-none font-semibold tracking-[-0.03em]">{value}</span>
        {unit ? <span className="text-[13px] text-muted-foreground">{unit}</span> : null}
      </p>
      {note ? <p className="text-[12px] leading-4 text-faint">{note}</p> : null}
    </div>
  )
}

// One gold bar per day, Monday to Sunday. Empty days keep a faint track so the week reads as a week.
function WeekBars({ byDay, today }: { byDay: number[]; today: number }) {
  const max = Math.max(1, ...byDay)
  return (
    <div className="mt-auto flex h-14 items-end gap-[2px]" role="img" aria-label={`Calls per day: ${byDay.map((count, index) => `${DAYS[index]} ${count}`).join(", ")}`}>
      {byDay.map((count, index) => (
        <Tooltip key={index}>
          <TooltipTrigger asChild>
            <div className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div
                className={cn("w-full max-w-[18px] rounded-t-[4px]", count ? "gold-fill" : "bg-foreground/[0.07]", index > today && "opacity-40")}
                style={{ height: count ? `${Math.max(14, (count / max) * 100)}%` : "4px" }}
              />
              <span className={cn("text-[10px] leading-none", index === today ? "font-semibold text-foreground" : "text-faint")}>{DAYS[index][0]}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {DAYS[index]}: {count} {count === 1 ? "call" : "calls"}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/* Today's calendar */

function CalendarTile({ events, now, className }: { events: TodayEvent[]; now: number; className?: string }) {
  const nextIndex = events.findIndex((event) => event.end > now)
  const rows: React.ReactNode[] = []
  let placedNow = false
  events.forEach((event, index) => {
    const live = event.start <= now && event.end > now
    const past = event.end <= now
    if (!placedNow && event.start > now) {
      placedNow = true
      rows.push(<NowLine key="now" now={now} />)
    }
    const minutesAway = Math.round((event.start - now) / 60000)
    rows.push(
      <li
        key={`${event.start}-${index}`}
        className={cn(
          "grid grid-cols-[46px_1fr_auto] items-start gap-3 rounded-lg px-2.5 py-2",
          live && "bg-gold-soft",
          index === nextIndex && !live && "bg-foreground/[0.04]",
          past && "opacity-45",
        )}
      >
        <span className={cn("tabular pt-px text-[12px]", live ? "font-semibold text-gold" : "text-muted-foreground")}>{clock(event.start)}</span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-foreground">{event.title}</span>
          <span className="block truncate text-[12px] text-faint">
            {live ? "Happening now" : index === nextIndex && minutesAway > 0 ? `In ${minutesAway < 60 ? `${minutesAway} min` : `${Math.round(minutesAway / 60)} h`}` : `Until ${clock(event.end)}`}
            {event.attendees.length ? ` · ${event.attendees.slice(0, 3).join(", ")}${event.attendees.length > 3 ? ` +${event.attendees.length - 3}` : ""}` : ""}
          </span>
        </span>
        {event.link && !past ? (
          <Button size="xs" variant={live || index === nextIndex ? "default" : "secondary"} onClick={() => void window.meetingRecorder.openCalendarLink(event.link!)}>
            Join
          </Button>
        ) : null}
      </li>,
    )
  })
  if (!placedNow) rows.push(<NowLine key="now" now={now} />)

  return (
    <Tile title="Today" icon={Calendar03Icon} className={className}>
      {events.length ? (
        <ol className="-mx-2.5 flex min-h-0 flex-col gap-0.5 overflow-y-auto">{rows}</ol>
      ) : (
        <p className="text-[13px] text-muted-foreground">Nothing else on your calendar today.</p>
      )}
    </Tile>
  )
}

function NowLine({ now }: { now: number }) {
  return (
    <li aria-label={`Now, ${clock(now)}`} className="flex items-center gap-2 px-2.5 py-0.5">
      <span className="tabular text-[11px] font-semibold text-gold">{clock(now)}</span>
      <span className="h-px flex-1 bg-gold/70" />
      <span className="size-1.5 rounded-full bg-gold" />
    </li>
  )
}

/* Page */

export function Dashboard({ hero, notice, onOpenMeeting }: { hero: React.ReactNode; notice?: React.ReactNode; onOpenMeeting: (id: string) => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [calendar, setCalendar] = useState<{ enabled: boolean; events: TodayEvent[] }>({ enabled: false, events: [] })
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const [nextStats, nextCalendar] = await Promise.all([
      window.meetingRecorder.dashboard().catch(() => null),
      window.meetingRecorder.calendarToday().catch(() => ({ enabled: false, events: [] })),
    ])
    if (nextStats) setStats(nextStats)
    setCalendar(nextCalendar)
    setNow(Date.now())
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    const listener = () => void load()
    window.meetingRecorder.onDashboardChanged(listener)
    window.meetingRecorder.onLibraryChanged(listener)
    return () => window.clearInterval(timer)
  }, [load])

  const coach = useCoachWeek(stats)
  const talkShare = stats && stats.words ? Math.round((stats.yourWords / stats.words) * 100) : null
  const time = formatMinutes(stats?.minutes || 0)
  const change = stats ? stats.meetings - stats.lastWeekMeetings : 0
  const showCalendar = calendar.enabled
  const peopleColors = useMemo(() => new Map((stats?.people || []).map((person, index) => [person.name, SPEAKER_PALETTE[index % SPEAKER_PALETTE.length]])), [stats])

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto grid max-w-[1180px] grid-cols-4 gap-3 p-6 max-[1100px]:grid-cols-2">
        {notice}
        <div className={cn("col-span-2 flex", showCalendar ? "row-span-2" : "row-span-2")}>{hero}</div>

        {showCalendar ? (
          <CalendarTile events={calendar.events} now={now} className="col-span-2 row-span-2 max-h-[340px]" />
        ) : (
          <>
            <Tile title="This week" icon={Video01Icon}>
              <BigNumber
                value={String(stats?.meetings ?? "–")}
                unit={stats?.meetings === 1 ? "call" : "calls"}
                note={stats ? (change === 0 ? "Same as last week" : `${Math.abs(change)} ${change > 0 ? "more" : "fewer"} than last week`) : null}
              />
              {stats ? <WeekBars byDay={stats.byDay} today={stats.today} /> : null}
            </Tile>
            <Tile title="Time in calls" icon={Clock01Icon}>
              <BigNumber value={stats ? time.value : "–"} unit={time.unit} note="This week, from your recordings" />
              {stats ? <CallFootnotes stats={stats} /> : null}
            </Tile>
            <Tile title="Words spoken in calls" icon={Mic01Icon} className="col-span-2">
              <SpokenWords stats={stats} talkShare={talkShare} />
            </Tile>
          </>
        )}

        {showCalendar ? (
          <>
            <Tile title="This week" icon={Video01Icon}>
              <BigNumber
                value={String(stats?.meetings ?? "–")}
                unit={stats?.meetings === 1 ? "call" : "calls"}
                note={stats ? (change === 0 ? "Same as last week" : `${Math.abs(change)} ${change > 0 ? "more" : "fewer"} than last week`) : null}
              />
              {stats ? <WeekBars byDay={stats.byDay} today={stats.today} /> : null}
            </Tile>
            <Tile title="Time in calls" icon={Clock01Icon}>
              <BigNumber value={stats ? time.value : "–"} unit={time.unit} note="This week, from your recordings" />
              {stats ? <CallFootnotes stats={stats} /> : null}
            </Tile>
            <Tile title="Words spoken in calls" icon={Mic01Icon}>
              <SpokenWords stats={stats} talkShare={talkShare} compact />
            </Tile>
          </>
        ) : null}

        <Tile title="Words dictated" icon={KeyboardIcon}>
          <BigNumber
            value={stats ? formatNumber(stats.dictation.weekWords) : "–"}
            unit="this week"
            note={
              !stats
                ? null
                : stats.dictation.weekWords
                  ? `About ${stats.dictation.minutesSaved} min of typing saved`
                  : stats.dictationEnabled
                    ? "Hold your dictation key in any app"
                    : "Turn on dictation in Settings"
            }
          />
          {stats ? (
            <Footnotes
              items={[
                ["Today", formatNumber(stats.dictation.today)],
                ["All time", formatNumber(stats.dictation.totalWords)],
              ]}
            />
          ) : null}
        </Tile>

        <Tile title="Your open action items" icon={CheckmarkCircle02Icon} className="col-span-2">
          {stats?.actions.length ? (
            <ul className="-mx-2 flex flex-col">
              {stats.actions.map((action, index) => (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => onOpenMeeting(action.meetingId)}
                    className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <span aria-hidden className="mt-[5px] size-2 shrink-0 rounded-full border border-gold" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] leading-5 text-foreground/90">{action.task}</span>
                      <span className="block truncate text-[11px] text-faint">{action.meetingTitle || "Untitled call"}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">Nothing assigned to you from this week's calls.</p>
          )}
        </Tile>

        <Tile title="Who you met" icon={UserGroupIcon} className={showCalendar ? "col-span-2" : "col-span-1"}>
          {stats?.people.length ? (
            <ul className="flex flex-col gap-2">
              {stats.people.slice(0, 5).map((person) => (
                <li key={person.name} className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-background"
                    style={{ background: peopleColors.get(person.name) }}
                  >
                    {initials(person.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{person.name}</span>
                  <span className="tabular text-[11px] text-faint">{person.calls}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">Named speakers from this week's calls show up here.</p>
          )}
        </Tile>

        {coach ? (
          <Tile title="Speaking coach" icon={VoiceIcon} className={showCalendar ? "col-span-2" : "col-span-4 max-[1100px]:col-span-2"}>
            <BigNumber
              value={`${Math.round(coach.talkShare * 100)}%`}
              unit="of the talking"
              note={`Across ${coach.calls} ${coach.calls === 1 ? "call" : "calls"} this week. Open a call for its full breakdown.`}
            />
            <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-border pt-3">
              {(
                [
                  ["Pace", coach.wordsPerMinute ? `${coach.wordsPerMinute} wpm` : "–"],
                  ["Fillers", `${coach.fillersPer100.toFixed(1)} per 100`],
                  ["Questions", String(coach.questions)],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <dt className="text-[11px] text-faint">{label}</dt>
                  <dd className="tabular text-[14px] font-medium text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </Tile>
        ) : null}
      </div>
    </ScrollArea>
  )
}

function CallFootnotes({ stats }: { stats: DashboardStats }) {
  const average = stats.meetings ? Math.round(stats.minutes / stats.meetings) : 0
  const longestDay = stats.byDay.indexOf(Math.max(...stats.byDay))
  return (
    <Footnotes
      items={[
        ["Per call", stats.meetings ? `${average} min` : "–"],
        ["Busiest day", stats.meetings ? DAYS[longestDay] : "–"],
      ]}
    />
  )
}

function SpokenWords({ stats, talkShare, compact }: { stats: DashboardStats | null; talkShare: number | null; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <BigNumber value={stats ? formatNumber(stats.words) : "–"} unit="words this week" />
      {talkShare !== null ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex h-2 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`You spoke ${talkShare}% of the words`}>
            <div className="gold-fill h-full rounded-l-full" style={{ width: `${Math.max(talkShare, 2)}%` }} />
            <div className="h-full flex-1 rounded-r-full bg-foreground/15" />
          </div>
          <p className="flex justify-between text-[12px] text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">You {talkShare}%</span>
            </span>
            {compact ? null : <span>Everyone else {100 - talkShare}%</span>}
          </p>
        </div>
      ) : null}
    </div>
  )
}
