import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight02Icon,
  BubbleChatSearchIcon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  File01Icon,
  KeyboardIcon,
  Mic01Icon,
  TextSelectionIcon,
  UserGroupIcon,
  Video01Icon,
  VoiceIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SPEAKER_PALETTE } from "@/lib/speaker-colors"
import { cn } from "@/lib/utils"
import type { DashboardStats, MeetingSummary, TodayEvent } from "@/types/bridge"

import { ActionCheck } from "./actions"
import { useCoachWeek } from "./coach"
import { Card, IconTile, Page, PageHeader, SectionTitle } from "./page"

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function formatNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K` : value.toLocaleString()
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

function ago(time: number | null) {
  if (!time) return ""
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  const date = new Date(time)
  return `${date.getDate()} ${date.toLocaleString("en", { month: "short" })}`
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

function greeting(name: string | undefined) {
  const hour = new Date().getHours()
  const part = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
  const first = name?.trim().split(/\s+/)[0]
  return first ? `${part}, ${first}` : "Welcome back"
}

/* Quick actions: Eden's four cards across the top. */

function QuickAction({
  icon,
  tint,
  title,
  text,
  onClick,
  disabled,
  live,
}: {
  icon: typeof Mic01Icon
  tint: string
  title: string
  text: string
  onClick: () => void
  disabled?: boolean
  live?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex min-h-[136px] flex-col items-start gap-1 rounded-2xl border border-border bg-panel p-[18px] text-left transition-colors",
        "hover:border-white/[0.14] hover:bg-[#1f1f1f] disabled:pointer-events-none disabled:opacity-50",
        live && "border-rec/40",
      )}
    >
      <IconTile icon={icon} tint={tint} className={cn("mb-auto", live && "bg-rec/15")} />
      <span className="mt-5 w-full truncate text-[16px] font-semibold tracking-[-0.01em] text-foreground">{title}</span>
      <span className="w-full truncate text-[13.5px] text-muted-foreground">{text}</span>
    </button>
  )
}

/* This week: one strip split four ways, like Eden's Analytics. */

function Stat({ icon, label, value, unit, note }: { icon: typeof Mic01Icon; label: string; value: string; unit?: string; note?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col p-5">
      <p className="flex items-center gap-2 text-[14px] font-medium text-muted-foreground">
        <HugeiconsIcon icon={icon} strokeWidth={1.7} className="size-4" />
        {label}
      </p>
      <p className="mt-4 flex items-baseline gap-1.5">
        <span className="tabular text-[36px] leading-none font-semibold tracking-[-0.035em] text-foreground">{value}</span>
        {unit ? <span className="text-[13px] text-faint">{unit}</span> : null}
      </p>
      <p className="mt-3 truncate text-[13px] text-faint">{note || " "}</p>
    </div>
  )
}

/* Today's calendar, for the left of Recents. */

function TodayList({ events, now }: { events: TodayEvent[]; now: number }) {
  const upcoming = events.filter((event) => event.end > now)
  if (!upcoming.length) return <p className="text-[14px] text-muted-foreground">Nothing else on your calendar today.</p>
  return (
    <ol className="-mx-2 flex flex-col gap-0.5">
      {upcoming.slice(0, 4).map((event, index) => {
        const live = event.start <= now
        const minutesAway = Math.round((event.start - now) / 60000)
        return (
          <li key={`${event.start}-${index}`} className={cn("grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-[10px] px-2 py-2", live && "bg-gold-soft")}>
            <span className={cn("tabular text-[13px]", live ? "font-semibold text-gold" : "text-muted-foreground")}>{clock(event.start)}</span>
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-medium text-foreground">{event.title}</span>
              <span className="block truncate text-[12.5px] text-faint">
                {live ? "Happening now" : minutesAway < 60 ? `In ${minutesAway} min` : `Until ${clock(event.end)}`}
                {event.attendees.length ? ` · ${event.attendees.slice(0, 3).join(", ")}` : ""}
              </span>
            </span>
            {event.link ? (
              <Button size="xs" variant={live || index === 0 ? "light" : "pill"} onClick={() => void window.meetingRecorder.openCalendarLink(event.link!)}>
                Join
              </Button>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/* Page */

export function Dashboard({
  name,
  banners,
  recording,
  canStart,
  meetings,
  onOpenMeeting,
  onOpenMeetings,
  onOpenActions,
  onShowLive,
}: {
  name?: string
  banners?: React.ReactNode
  recording: { active: boolean; title?: string; elapsed?: string }
  canStart: boolean
  meetings: MeetingSummary[]
  onOpenMeeting: (id: string) => void
  onOpenMeetings: () => void
  onOpenActions: () => void
  onShowLive: () => void
}) {
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
  // Ticked here: shown struck through until the next refresh drops them.
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const talkShare = stats && stats.words ? Math.round((stats.yourWords / stats.words) * 100) : null
  const time = formatMinutes(stats?.minutes || 0)
  const change = stats ? stats.meetings - stats.lastWeekMeetings : 0
  const peopleColors = useMemo(() => new Map((stats?.people || []).map((person, index) => [person.name, SPEAKER_PALETTE[index % SPEAKER_PALETTE.length]])), [stats])
  const recent = useMemo(() => [...meetings].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 5), [meetings])
  const busiest = stats?.meetings ? DAYS[stats.byDay.indexOf(Math.max(...stats.byDay))] : null

  return (
    <Page>
      <PageHeader
        title={greeting(name)}
        actions={
          recording.active ? (
            <Button variant="pill" size="sm" onClick={onShowLive} className="gap-2">
              <span className="size-2 rounded-full bg-rec" aria-hidden />
              <span className="tabular">{recording.elapsed}</span>
              Show call
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-4 gap-3.5 max-[1060px]:grid-cols-2">
        {recording.active ? (
          <QuickAction icon={Video01Icon} tint="var(--rec)" title="Recording now" text={recording.title || "Show the live call"} onClick={onShowLive} live />
        ) : (
          <QuickAction
            icon={Video01Icon}
            tint="var(--gold)"
            title="Record a call"
            text="Zoom, Meet, Teams and more"
            disabled={!canStart}
            onClick={() => void window.meetingRecorder.startAppRecording()}
          />
        )}
        <QuickAction
          icon={UserGroupIcon}
          tint="#6fcfbf"
          title="In-person meeting"
          text="Record the room"
          disabled={!canStart || recording.active}
          onClick={() => void window.meetingRecorder.startAppRecording({ inPerson: true })}
        />
        <QuickAction icon={BubbleChatSearchIcon} tint="#7fb5f5" title="Ask your meetings" text="Search every call you've had" onClick={onOpenMeetings} />
        <QuickAction icon={TextSelectionIcon} tint="#f2a65e" title="Grab text" text="Copy text off your screen" onClick={() => void window.meetingRecorder.grabText(false)} />
      </div>

      {banners}

      <div className="flex flex-col gap-3.5">
        <SectionTitle aside="This week">Your calls</SectionTitle>
        <Card className="grid grid-cols-4 divide-x divide-border max-[1060px]:grid-cols-2 max-[1060px]:divide-x-0">
          <Stat
            icon={Video01Icon}
            label="Calls"
            value={String(stats?.meetings ?? "–")}
            note={stats ? (change === 0 ? "Same as last week" : `${change > 0 ? "+" : "−"}${Math.abs(change)} vs last week`) : null}
          />
          <Stat
            icon={Clock01Icon}
            label="Time in calls"
            value={stats ? time.value : "–"}
            unit={time.unit}
            note={stats?.meetings ? `${Math.round(stats.minutes / stats.meetings)} min per call · busiest ${busiest}` : null}
          />
          <Stat
            icon={Mic01Icon}
            label="Words spoken"
            value={stats ? formatNumber(stats.words) : "–"}
            unit="words"
            note={talkShare !== null ? `You ${talkShare}% · everyone else ${100 - talkShare}%` : null}
          />
          <Stat
            icon={KeyboardIcon}
            label="Words dictated"
            value={stats ? formatNumber(stats.dictation.weekWords) : "–"}
            unit="words"
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
        </Card>
      </div>

      <div className="flex flex-col gap-3.5">
        <SectionTitle>Recents</SectionTitle>
        <Card className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] overflow-hidden max-[1060px]:grid-cols-1">
          <div className="flex flex-col justify-center gap-3 border-r border-border p-8 max-[1060px]:border-r-0 max-[1060px]:border-b">
            {calendar.enabled ? (
              <>
                <span className="flex size-10 items-center justify-center rounded-full bg-tile">
                  <HugeiconsIcon icon={Calendar03Icon} strokeWidth={1.7} className="size-[18px] text-foreground/80" />
                </span>
                <h3 className="text-[17px] font-semibold tracking-[-0.01em]">Today</h3>
                <TodayList events={calendar.events} now={now} />
              </>
            ) : (
              <>
                <span className="flex size-10 items-center justify-center rounded-full bg-tile">
                  <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.7} className="size-[18px] text-foreground/80" />
                </span>
                <h3 className="mt-2 text-[17px] font-semibold tracking-[-0.01em]">Pick up where you left off</h3>
                <p className="text-[14px] leading-[1.6] text-muted-foreground">Jump back into a recent call: its notes, transcript and action items, with Ask ready for questions.</p>
                <Button variant="pill" className="mt-2 self-start" onClick={onOpenMeetings}>
                  <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} data-icon="inline-start" />
                  View meetings
                </Button>
              </>
            )}
          </div>
          <ul className="flex flex-col py-2">
            {recent.length ? (
              recent.map((meeting) => (
                <li key={meeting.id}>
                  <button
                    type="button"
                    onClick={() => onOpenMeeting(meeting.id)}
                    className="flex w-full items-center gap-3.5 px-6 py-3 text-left transition-colors hover:bg-white/[0.03]"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-tile">
                      <HugeiconsIcon icon={File01Icon} strokeWidth={1.7} className="size-4 text-foreground/70" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-foreground">{meeting.title || "Untitled call"}</span>
                    <span className="tabular shrink-0 text-[12.5px] text-faint">{ago(meeting.startedAt)}</span>
                  </button>
                </li>
              ))
            ) : (
              <li className="px-6 py-8 text-[14px] text-muted-foreground">Your calls show up here once you've recorded one.</li>
            )}
          </ul>
        </Card>
      </div>

      <div className="flex flex-col gap-3.5">
        <SectionTitle aside={stats?.actions.length ? `${stats.actions.length} open` : undefined}>Your week</SectionTitle>
        <div className="grid grid-cols-3 gap-3.5 max-[1060px]:grid-cols-1">
          <Card className="col-span-2 row-span-2 flex flex-col gap-3 p-5 max-[1060px]:col-span-1">
            <p className="flex items-center gap-2 text-[14px] font-medium text-muted-foreground">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.7} className="size-4" />
              Your open action items
            </p>
            {stats?.actions.length ? (
              <ul className="-mx-2 flex flex-col">
                {stats.actions.map((action) => {
                  const id = `${action.meetingId}#${action.index}`
                  const done = ticked.has(id)
                  return (
                    <li key={id} className="flex items-start gap-2.5 rounded-[10px] px-2 py-2 transition-colors hover:bg-white/[0.03]">
                      <ActionCheck
                        done={done}
                        label={action.task}
                        className="mt-px"
                        onToggle={() => {
                          setTicked((current) => {
                            const next = new Set(current)
                            if (done) next.delete(id)
                            else next.add(id)
                            return next
                          })
                          void window.meetingRecorder.setActionDone(action.meetingId, action.index, !done).catch(() => void load())
                        }}
                      />
                      <button type="button" onClick={() => onOpenMeeting(action.meetingId)} className="min-w-0 flex-1 text-left">
                        <span className={cn("block text-[14px] leading-5 transition-colors", done ? "text-faint line-through" : "text-foreground/90")}>{action.task}</span>
                        <span className="block truncate text-[12px] text-faint">{action.meetingTitle || "Untitled call"}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-[14px] text-muted-foreground">Nothing open for you from this week's calls.</p>
            )}
            <Button variant="pill" size="sm" className="mt-auto self-start" onClick={onOpenActions}>
              All action items
              <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} data-icon="inline-end" />
            </Button>
          </Card>

          <Card className="flex flex-col gap-3 p-5">
            <p className="flex items-center gap-2 text-[14px] font-medium text-muted-foreground">
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={1.7} className="size-4" />
              Who you met
            </p>
            {stats?.people.length ? (
              <ul className="flex flex-col gap-2.5">
                {stats.people.slice(0, 5).map((person) => (
                  <li key={person.name} className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold text-background"
                      style={{ background: peopleColors.get(person.name) }}
                    >
                      {initials(person.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-foreground/90">{person.name}</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="tabular text-[12px] text-faint">{person.calls}</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {person.calls} {person.calls === 1 ? "call" : "calls"} this week
                      </TooltipContent>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-muted-foreground">Named speakers from this week's calls show up here.</p>
            )}
          </Card>

          <Card className="flex flex-col gap-3 p-5">
            <p className="flex items-center gap-2 text-[14px] font-medium text-muted-foreground">
              <HugeiconsIcon icon={VoiceIcon} strokeWidth={1.7} className="size-4" />
              Speaking coach
            </p>
            {coach ? (
              <>
                <p className="flex items-baseline gap-1.5">
                  <span className="tabular text-[36px] leading-none font-semibold tracking-[-0.035em]">{Math.round(coach.talkShare * 100)}%</span>
                  <span className="text-[13px] text-faint">of the talking</span>
                </p>
                <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-border pt-3">
                  {(
                    [
                      ["Words/min", coach.wordsPerMinute ? String(coach.wordsPerMinute) : "–"],
                      ["Fillers", `${coach.fillersPer100.toFixed(1)}%`],
                      ["Questions", String(coach.questions)],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex flex-col gap-0.5">
                      <dt className="text-[11.5px] text-faint">{label}</dt>
                      <dd className="tabular text-[14px] font-medium text-foreground">{value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="text-[14px] text-muted-foreground">Your talk share, pace and fillers across this week's calls show up here.</p>
            )}
          </Card>
        </div>
      </div>
    </Page>
  )
}
