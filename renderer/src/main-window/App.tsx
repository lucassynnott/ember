import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AudioWave01Icon,
  Folder01Icon,
  FolderAddIcon,
  Files02Icon,
  Home01Icon,
  KeyboardIcon,
  CheckmarkCircle02Icon,
  ClipboardIcon,
  Bookmark02Icon,
  DashboardSquare01Icon,
  Add01Icon,
  Search01Icon,
  News01Icon,
  Mic01Icon,
  MoreHorizontalIcon,
  Settings02Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { speakerColors } from "@/lib/speaker-colors"
import { cn } from "@/lib/utils"
import type { Analysis, PermissionState, SavedBoard, TranscriptSegment } from "@/types/bridge"

import { Dashboard } from "./dashboard"
import { IconTile, PageHeader } from "./page"
import { DigestPage } from "./digest"
import { ClipboardPage } from "./clipboard"
import { BoardNameDialog, SavedPage } from "./saved"
import { HistoryPage } from "./history"
import { ActionsPage, useOpenActionCount } from "./actions"
import { WhatsNew } from "./whats-new"
import { LiveHelp } from "./live-help"
import { MeetingsPage, errorText, useLibrary, type FolderFilter } from "./meetings"
import { RecordingsPage } from "./recordings"
import { permissionsGranted, useMeeting, type MeetingState } from "./store"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function pad(value: number) {
  return String(value).padStart(2, "0")
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function meetingTitle(startedAt: number | null) {
  if (!startedAt) return "Ember"
  const date = new Date(startedAt)
  return `Meeting, ${WEEKDAYS[date.getDay()]} ${date.getHours()}:${pad(date.getMinutes())}`
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function homePath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~")
}

/* Title bar */

function TitleBar({ meeting, home = false }: { meeting: MeetingState; home?: boolean }) {
  const { phase, startedAt, endedAt, segments } = meeting
  const recording = phase === "recording"
  // This call's notes may still be written in the background after the app is ready for the next one.
  const finishing = !home && meeting.jobs.find((job) => job.startedAt === startedAt)
  const busy = phase === "starting" || phase === "stopping" || phase === "processing" || Boolean(finishing)
  const now = useNow(recording)
  // On Home the title stays "Ember"; REC and Stop still show while a call records.
  const hasMeeting = !home && Boolean(startedAt) && (phase !== "idle" || segments.length > 0)
  const canStart = phase === "idle" && permissionsGranted(meeting.permissions)

  return (
    <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-6">
      <h1 className="flex min-w-0 items-center gap-2.5 truncate text-[21px] font-normal tracking-[-0.02em]">
        {hasMeeting ? null : <HugeiconsIcon icon={AudioWave01Icon} strokeWidth={1.8} className="size-5 shrink-0 text-ember" aria-hidden />}
        <span className="truncate">{hasMeeting ? meeting.calendar?.title || meetingTitle(startedAt) : "Ember"}</span>
      </h1>
      <div className="ml-auto flex items-center gap-3">
        {recording && startedAt ? (
          <span className="tabular flex items-center gap-2 text-[14px]" aria-live="off">
            <span className="size-2 rounded-full bg-rec" aria-hidden />
            <span className="font-medium tracking-[0.04em] text-rec">REC</span>
            <span className="text-foreground">{formatElapsed(now - startedAt)}</span>
          </span>
        ) : null}
        {!recording && hasMeeting && endedAt && startedAt && !busy ? (
          <span className="tabular text-[13px] text-muted-foreground">
            Ended {formatElapsed(endedAt - startedAt)}
          </span>
        ) : null}
        {busy ? (
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner className="size-3.5" />
            {finishing ? finishing.message : meeting.message}
          </span>
        ) : null}
        {recording ? (
          <Button
            className="no-drag h-9 bg-rec bg-none px-8 text-[15px] text-[#18181b] hover:bg-rec/85"
            onClick={() => void window.meetingRecorder.stopAppRecording()}
          >
            Stop
          </Button>
        ) : (
          <div className="no-drag flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={!canStart}
                  onClick={() => void window.meetingRecorder.startAppRecording({ inPerson: true })}
                >
                  In person
                </Button>
              </TooltipTrigger>
              <TooltipContent>Everyone's in the room: tell people apart by voice from your microphone</TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              variant={hasMeeting ? "secondary" : "default"}
              disabled={!canStart}
              onClick={() => void window.meetingRecorder.startAppRecording()}
            >
              Start recording
            </Button>
          </div>
        )}
      </div>
    </header>
  )
}

/* Notes column */

function NotesSection({ title, children, large }: { title: string; children: React.ReactNode; large?: boolean }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className={cn("font-semibold text-foreground", large ? "text-[14px] text-muted-foreground" : "text-[14px]")}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function NoteLines({ items, empty, large, bullets }: { items: string[]; empty: string; large?: boolean; bullets?: boolean }) {
  if (!items.length) return <p className="text-[14px] leading-5 text-faint">{empty}</p>
  return (
    <ul
      className={cn(
        "flex flex-col",
        large ? "gap-1.5 text-[17px] leading-[1.45]" : "gap-1 text-[15px] leading-[1.45]",
        bullets && "list-disc pl-5 marker:text-faint",
      )}
      data-selectable
    >
      {items.map((item, index) => (
        <li key={index} className="text-foreground/90">
          {item}
        </li>
      ))}
    </ul>
  )
}

function Participants({ meeting }: { meeting: MeetingState }) {
  const { zoom, segments, settings } = meeting
  const speaking = zoom.activeSpeakers?.[0]
  const names = useMemo(() => {
    if (zoom.meetingOpen && zoom.participants?.length) return zoom.participants
    const fromTranscript = new Set<string>()
    for (const segment of segments) if (segment.speaker) fromTranscript.add(segment.speaker)
    return [...fromTranscript]
  }, [zoom.meetingOpen, zoom.participants, segments])
  if (!names.length) return null
  const you = settings?.speakerName

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[14px] font-semibold text-foreground">
        Participants ({names.length})
      </h2>
      <ul className="flex flex-col gap-2.5 pt-1 text-[14px]">
        {names.map((name) => {
          const live = name === speaking
          return (
            <li key={name} className="flex items-start gap-3">
              <span aria-hidden className="mt-[8px] flex w-3.5 shrink-0 flex-col gap-[3px]">
                <span className={cn("block w-full", live ? "h-[2px] bg-live" : "h-px bg-foreground/60")} />
                {live ? <span className="block h-[2px] w-full bg-live" /> : null}
              </span>
              <span className="flex flex-col">
                <span className="text-foreground/90">
                  {name}
                  {you && name === you ? " (You)" : ""}
                </span>
                {live ? <span className="text-[12px] text-muted-foreground">Speaking now</span> : null}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Your own notes during the call. When it ends, each line is expanded with what was said.
function YourNotes({ meeting }: { meeting: MeetingState }) {
  const [text, setText] = useState("")
  const timer = useRef<number | null>(null)
  const latest = useRef("")
  useEffect(() => {
    setText("")
    latest.current = ""
  }, [meeting.startedAt])
  const flush = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    void window.meetingRecorder.setUserNotes(latest.current)
  }
  useEffect(() => () => flush(), [])
  const editable = meeting.phase === "recording" || meeting.phase === "starting"
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-[14px] font-semibold text-foreground">Your notes</h2>
      <Textarea
        value={text}
        disabled={!editable}
        placeholder={"Jot anything down, one point per line.\nIt's filled in from the transcript when the call ends."}
        className="min-h-[96px] resize-none text-[14px] leading-[1.5]"
        onChange={(event) => {
          setText(event.target.value)
          latest.current = event.target.value
          if (timer.current) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(flush, 400)
        }}
        onBlur={flush}
      />
      {meeting.voiceNotes.length ? (
        <div className="flex flex-col gap-1 pt-1">
          <span className="text-[12px] text-faint">Added by voice</span>
          <ul className="flex flex-col gap-0.5 text-[13px] leading-5 text-foreground/90">
            {meeting.voiceNotes.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      ) : editable ? (
        <p className="text-[12px] text-faint">Tip: dictate "action item …" or "note …" to add a line by voice.</p>
      ) : null}
    </section>
  )
}

// The notes template for this call: Auto follows Settings and the calendar title.
function TemplatePicker({ startedAt }: { startedAt: number | null }) {
  const [templates, setTemplates] = useState<{ id: string; label: string }[]>([])
  const [value, setValue] = useState("auto")
  useEffect(() => {
    void window.meetingRecorder.noteTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])
  useEffect(() => setValue("auto"), [startedAt])
  if (!templates.length) return null
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-faint">Notes template</span>
      <Select
        value={value}
        onValueChange={(next) => {
          setValue(next)
          void window.meetingRecorder.setMeetingTemplate(next)
        }}
      >
        <SelectTrigger size="sm" className="h-7 w-[140px] text-[12px]" aria-label="Notes template">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto</SelectItem>
          {templates.map((template) => (
            <SelectItem key={template.id} value={template.id}>
              {template.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function NotesColumn({ meeting, finished }: { meeting: MeetingState; finished: boolean }) {
  const { analysis, phase } = meeting
  const writing = phase === "stopping" || phase === "processing" || meeting.jobs.some((job) => job.startedAt === meeting.startedAt)
  const actions = analysis.actionItems.map(({ owner, task }) => `${owner || "Unassigned"}: ${task}`)

  return (
    <aside
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-r border-border",
        finished ? "w-[46%]" : "w-[26%] min-w-[300px] max-w-[360px] max-[900px]:min-w-[230px]",
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("flex flex-col", finished ? "gap-6 px-9 py-8" : "gap-[18px] px-6 pt-5 pb-6")}>
          {!finished && meeting.phase !== "idle" ? (
            <>
              <YourNotes meeting={meeting} />
              <TemplatePicker startedAt={meeting.startedAt} />
              <Separator />
            </>
          ) : null}
          {writing && !analysis.summary.length ? (
            <div className="flex flex-col gap-2" aria-label="Writing notes">
              <p className="text-[13px] text-muted-foreground">Writing your notes…</p>
              <Skeleton className="h-3 w-[90%]" />
              <Skeleton className="h-3 w-[75%]" />
              <Skeleton className="h-3 w-[82%]" />
            </div>
          ) : (
            <>
              <NotesSection title="Summary" large={finished}>
                <NoteLines
                  items={analysis.summary}
                  large={finished}
                  empty="The summary appears after a minute or so of conversation."
                />
              </NotesSection>
              <Separator />
              <NotesSection title={analysis.decisions.length > 1 ? "Decisions" : "Decision"} large={finished}>
                <NoteLines items={analysis.decisions} large={finished} empty="No decisions yet." bullets />
              </NotesSection>
              <Separator />
              <NotesSection title={finished ? "Action items" : "Actions"} large={finished}>
                <NoteLines items={actions} large={finished} empty="No action items yet." bullets />
              </NotesSection>
            </>
          )}
          {!finished ? (
            <>
              <Separator />
              <Participants meeting={meeting} />
              {meeting.slides ? (
                <>
                  <Separator />
                  <section className="flex flex-col gap-1.5">
                    <h2 className="text-[14px] font-semibold text-foreground">Shared on screen</h2>
                    <p className="text-[13px] text-muted-foreground">
                      {meeting.slides.count} {meeting.slides.count === 1 ? "slide" : "slides"} saved
                      {meeting.slides.latest ? <span className="block truncate text-foreground/80">Latest: {meeting.slides.latest}</span> : null}
                    </p>
                  </section>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  )
}

/* Rail */

function Tick({ variant }: { variant: "past" | "live" | "pending" | "end" }) {
  if (variant === "live") {
    return (
      <span aria-hidden className="flex w-[34px] flex-col gap-[3px] bg-background py-px">
        <span className="h-[2px] w-full bg-live" />
        <span className="h-[2px] w-full bg-live" />
      </span>
    )
  }
  if (variant === "end") return <span aria-hidden className="block size-[7px] bg-foreground/70" />
  return (
    <span
      aria-hidden
      className={cn("block h-px w-[34px]", variant === "pending" ? "bg-[repeating-linear-gradient(to_right,var(--rail)_0_6px,transparent_6px_10px)]" : "bg-foreground/75")}
    />
  )
}

function RailRow({
  timestamp,
  tick,
  children,
  compact,
  first,
  grow,
}: {
  timestamp: string
  tick: "past" | "live" | "pending" | "end"
  children: React.ReactNode
  compact?: boolean
  first?: boolean
  grow?: boolean
}) {
  // Each row draws its own stretch of the rail: solid for spoken lines, dashed while listening.
  return (
    <div
      className={cn(
        "grid grid-cols-[52px_34px_1fr] items-start gap-x-4 max-[900px]:grid-cols-[42px_26px_1fr] max-[900px]:gap-x-3",
        compact ? "py-1.5" : "py-[17px]",
        tick === "pending" && "pt-[32px]",
        first && (compact ? "pt-6" : "pt-8"),
        grow && "min-h-full flex-1",
      )}
    >
      <span className={cn("tabular pt-[2px] text-right text-[14px]", timestamp === "--:--" ? "text-faint/60" : "text-faint")}>
        {timestamp}
      </span>
      <span className={cn("relative flex h-full justify-center self-stretch", tick === "end" ? "pt-[7px]" : "pt-[11px]")}>
        <span
          aria-hidden
          className={cn(
            "absolute left-1/2 w-px",
            compact ? "-top-1.5 -bottom-1.5" : "-top-[17px] -bottom-[17px]",
            first && (compact ? "top-[-24px]" : "top-[-32px]"),
            tick === "pending" && "-top-[32px]",
            tick === "pending" ? "bottom-0 bg-[repeating-linear-gradient(to_bottom,var(--rail)_0_6px,transparent_6px_10px)]" : "bg-rail",
            tick === "end" && "bottom-auto h-[18px]",
          )}
        />
        <span className="relative" data-tick>
          <Tick variant={tick} />
        </span>
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Transcript({ meeting, finished }: { meeting: MeetingState; finished: boolean }) {
  const { segments, phase, settings, zoom } = meeting
  const recording = phase === "recording"
  const scrollRef = useRef<HTMLDivElement>(null)
  const you = settings?.speakerName
  // The doubled tick marks the line of whoever Zoom says is speaking now, else the newest line.
  const speaking = zoom.activeSpeakers?.[0]
  const liveIndex = useMemo(() => {
    if (!recording || !segments.length) return -1
    if (speaking) {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (segments[index].speaker === speaking) return index
      }
    }
    return segments.length - 1
  }, [recording, segments, speaking])

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector("[data-slot=scroll-area-viewport]")
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [segments.length])

  // Signature motion: one doubled yellow tick glides along the rail to whoever is speaking now.
  const listRef = useRef<HTMLOListElement>(null)
  const [livePosition, setLivePosition] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || liveIndex < 0) {
      setLivePosition(null)
      return
    }
    const tick = list.children[liveIndex]?.querySelector("[data-tick]")
    if (!tick) return
    const listBox = list.getBoundingClientRect()
    const tickBox = tick.getBoundingClientRect()
    setLivePosition({ x: tickBox.left - listBox.left, y: tickBox.top - listBox.top })
  }, [liveIndex, segments.length])

  const colors = useMemo(() => speakerColors(segments.map((segment) => segment.speaker), you), [segments, you])

  return (
    <ScrollArea className="relative min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!flex [&_[data-slot=scroll-area-viewport]>div]:min-h-full [&_[data-slot=scroll-area-viewport]>div]:flex-col" ref={scrollRef}>
      <ol ref={listRef} className={cn("relative flex min-h-full flex-1 flex-col px-6 max-[900px]:px-3", recording && "pb-44")} aria-label="Transcript">
        {segments.map((segment: TranscriptSegment, index) => {
          const speaker = segment.speaker || "Unknown"
          const newest = recording && index === segments.length - 1
          return (
            <li key={index} className={cn(newest && "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out")}>
              <RailRow
                timestamp={segment.timestamp || ""}
                tick="past"
                compact={finished}
                first={index === 0}
              >
                {finished ? (
                  <p className="max-w-[560px] text-[14px] leading-[1.45]" data-selectable>
                    <span className="font-semibold text-foreground" style={{ color: colors.get(speaker) }}>
                      {speaker}
                    </span>
                    <span className="text-muted-foreground"> {segment.text}</span>
                  </p>
                ) : (
                  <div className="flex flex-col gap-1" data-selectable>
                    <span className="text-[16px] font-semibold text-foreground" style={{ color: colors.get(speaker) }}>
                      {speaker}
                      {segment.source === "microphone" && you && speaker === you ? " (You)" : ""}
                    </span>
                    <p className="max-w-[560px] text-[16px] leading-[1.5] text-foreground/88">{segment.text}</p>
                  </div>
                )}
              </RailRow>
            </li>
          )
        })}
        {recording ? (
          <li className="flex flex-1 flex-col">
            <RailRow timestamp="--:--" tick="pending" first={!segments.length} grow>
              <p className="text-[15px] text-faint italic">Listening for more speech…</p>
            </RailRow>
          </li>
        ) : null}
        {livePosition ? (
          <li aria-hidden className="pointer-events-none absolute top-0 left-0 transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]" style={{ transform: `translate(${livePosition.x}px, ${livePosition.y - 2}px)` }}>
            <Tick variant="live" />
          </li>
        ) : null}
        {finished && segments.length ? (
          <li>
            <RailRow timestamp="" tick="end" compact>
              <span className="sr-only">End of transcript</span>
            </RailRow>
          </li>
        ) : null}
      </ol>
    </ScrollArea>
  )
}

/* Empty state */

const PERMISSION_COPY: Record<keyof PermissionState, { title: string; description: string }> = {
  microphone: { title: "Microphone", description: "Records your voice." },
  screen: { title: "Screen & System Audio Recording", description: "Records everyone else in the call." },
  accessibility: { title: "Accessibility", description: "Names Zoom speakers. Optional." },
}

// Home's banner when the app is missing a permission it needs to record.
function PermissionBanner({ meeting }: { meeting: MeetingState }) {
  const missing = (Object.keys(PERMISSION_COPY) as (keyof PermissionState)[]).filter(
    (key) => meeting.permissions[key] !== "granted" && meeting.permissions[key] !== "unknown",
  )
  if (!missing.length) return null
  return (
    <section className="flex items-center gap-5 rounded-2xl border border-rec/30 bg-panel px-6 py-5">
      <IconTile icon={Mic01Icon} tint="var(--rec)" />
      <div className="min-w-0 flex-1">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{missing.map((key) => PERMISSION_COPY[key].title).join(" and ")}</h2>
        <p className="mt-1 text-[14px] text-muted-foreground">{missing.map((key) => PERMISSION_COPY[key].description).join(" ")}</p>
      </div>
      <Button variant="light" className="h-10 px-5 text-[14px]" onClick={() => void window.meetingRecorder.requestPermissions()}>
        Grant access
      </Button>
    </section>
  )
}

/* Profile row: who you are, the model and what the app can see, at the foot of the sidebar. */

function ProfileRow({ meeting }: { meeting: MeetingState }) {
  const name = meeting.settings?.speakerName?.trim() || "This Mac"
  const others = meeting.jobs.length
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] px-1.5 py-1.5">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[12px] font-semibold text-foreground/90">
        {name[0]?.toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] font-medium text-foreground/90">{name}</span>
        <span className="flex items-center gap-1.5 truncate text-[11.5px] text-faint">
          {others ? (
            <>
              <Spinner className="size-3 text-ember" />
              Writing notes for {others === 1 ? "1 call" : `${others} calls`}
            </>
          ) : (
            meeting.zoom.meetingOpen || meeting.zoom.call ? zoomLabel(meeting) : modelLabel(meeting)
          )}
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Open notes folder" className="shrink-0 text-sidebar-foreground/60" onClick={() => void window.meetingRecorder.openNotesFolder()}>
            <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.7} className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open notes folder</TooltipContent>
      </Tooltip>
    </div>
  )
}

/* Status bar */

function modelLabel(meeting: MeetingState) {
  const settings = meeting.settings
  if (!settings) return "Loading model"
  const model =
    settings.transcriptionModels.find((candidate) => candidate.id === settings.transcriptionModelId) ||
    settings.transcriptionModels.find((candidate) => candidate.realtime) ||
    settings.transcriptionModels[0]
  return model ? `${model.label.replace(/ \(.*\)$/, "")} on this Mac` : "No model installed"
}

function zoomLabel(meeting: MeetingState) {
  const { zoom } = meeting
  if (!zoom.meetingOpen && zoom.call) return `${zoom.call.app} call${zoom.call.via ? ` in ${zoom.call.via}` : ""}`
  if (zoom.accessibility !== true && zoom.accessibility !== "granted") return "Zoom names need Accessibility"
  if (!zoom.meetingOpen) return "No call detected"
  const count = zoom.participants?.length || 0
  return `Zoom: ${count} ${count === 1 ? "person" : "people"}`
}

function StatusBar({ meeting, finished }: { meeting: MeetingState; finished: boolean }) {
  const saved = meeting.saved
  // Earlier calls still being finished, shown wherever you are.
  const others = meeting.jobs.filter((job) => !(finished && job.startedAt === meeting.startedAt))
  return (
    <footer className="flex h-16 shrink-0 items-center gap-3 border-t border-border px-5 text-[14px] text-muted-foreground">
      {others.length ? (
        <>
          <span className="flex items-center gap-2 text-foreground/80">
            <Spinner className="size-3.5 text-ember" />
            {others.length === 1
              ? `Writing notes for ${others[0].title || `the ${new Date(others[0].startedAt).toTimeString().slice(0, 5)} call`}`
              : `Writing notes for ${others.length} calls`}
          </span>
          <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
        </>
      ) : null}
      {finished && saved ? (
        <span className="truncate" data-selectable>
          {saved.notePath ? `Saved to ${homePath(saved.notePath)}${saved.notion ? " and Notion" : ""}` : "Saved to Notion"}
        </span>
      ) : (
        <>
          <span className="flex items-center gap-2.5">
            <HugeiconsIcon icon={AudioWave01Icon} className="size-6" strokeWidth={1.4} />
            {modelLabel(meeting)}
          </span>
          <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
          <span>{zoomLabel(meeting)}</span>
          {meeting.settings?.autoRecordZoomMeetings ? (
            <>
              <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
              <span>{meeting.autoRecording.suppressed ? "Auto-record paused" : "Auto-record on"}</span>
            </>
          ) : null}
          {meeting.permissions.microphone !== "granted" && meeting.permissions.microphone !== "unknown" ? (
            <>
              <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
              <span className="flex items-center gap-1.5 text-rec">
                <HugeiconsIcon icon={Mic01Icon} className="size-4" strokeWidth={1.6} />
                Microphone access needed
              </span>
            </>
          ) : null}
        </>
      )}
      <div className="ml-auto flex h-full items-center gap-1">
        {finished && saved?.notePath ? (
          <Button size="sm" variant="secondary" onClick={() => void window.meetingRecorder.openNote(saved.notePath!)}>
            Open note
          </Button>
        ) : null}
        {finished && saved?.notionUrl ? (
          <Button size="sm" variant="secondary" onClick={() => void window.meetingRecorder.openNote(saved.notionUrl!)}>
            Open in Notion
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="Open notes folder" onClick={() => void window.meetingRecorder.openNotesFolder()}>
              <HugeiconsIcon icon={Folder01Icon} className="size-5 text-foreground/70" strokeWidth={1.6} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open notes folder</TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="mx-2 data-vertical:h-8 data-vertical:self-center" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="Settings" onClick={() => void window.meetingRecorder.openSettings()}>
              <HugeiconsIcon icon={Settings02Icon} className="size-6 text-foreground/80" strokeWidth={1.8} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  )
}

function hasNotes(analysis: Analysis) {
  return analysis.summary.length + analysis.decisions.length + analysis.actionItems.length > 0
}

/* Sidebar */

type View = { page: "home" } | { page: "live" } | { page: "meetings"; folder: FolderFilter } | { page: "digest" } | { page: "dictation" } | { page: "actions" } | { page: "clipboard" } | { page: "saved"; board: string } | { page: "recordings"; id: string | null; edit?: boolean; share?: boolean }

function FolderNameInput({
  initial,
  onDone,
}: {
  initial: string
  onDone: (name: string | null) => void
}) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <Input
      autoFocus
      aria-label="Folder name"
      value={value}
      placeholder="Folder name"
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(value.trim() || null)
        if (event.key === "Escape") finish(null)
      }}
      className="h-8 text-[13px]"
    />
  )
}

// "1d", "6d", "23 Sep": how long ago, short enough for a sidebar row.
function shortAgo(time: number | null) {
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

function AppSidebar({
  view,
  onView,
  meeting,
  hasCall,
  library,
  onError,
  onOpenMeeting,
}: {
  view: View
  onView: (view: View) => void
  meeting: MeetingState
  hasCall: boolean
  library: ReturnType<typeof useLibrary>["library"]
  onError: (message: string) => void
  onOpenMeeting: (id: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null)
  const openActions = useOpenActionCount()
  const recording = meeting.phase === "recording"
  const meetings = library?.meetings || []
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const entry of meetings) if (entry.folderId) result.set(entry.folderId, (result.get(entry.folderId) || 0) + 1)
    return result
  }, [meetings])
  const isMeetings = (folder: FolderFilter) => view.page === "meetings" && view.folder === folder
  const recent = useMemo(() => [...meetings].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 5), [meetings])
  const [boards, setBoards] = useState<SavedBoard[]>([])
  const [newBoard, setNewBoard] = useState(false)
  useEffect(() => {
    const load = () => void window.meetingRecorder.savedBoards().then(setBoards).catch(() => setBoards([]))
    load()
    return window.meetingRecorder.onSavedChanged(load)
  }, [])
  const newest = recent[0]?.id

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (failure) {
      onError(errorText(failure))
    }
  }

  return (
    <Sidebar collapsible="none" className="m-2.5 mr-0 h-[calc(100%-20px)] w-[244px] rounded-[14px] border border-sidebar-border shadow-[0_8px_24px_rgb(0_0_0/0.25)]">
      {/* The traffic lights sit in this row, inside the panel, like Eden. */}
      <SidebarHeader className="drag h-[50px] shrink-0 flex-row items-center justify-end gap-0.5 px-2.5 pt-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Search meetings" className="no-drag text-sidebar-foreground/70" onClick={() => onView({ page: "meetings", folder: "all" })}>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={1.7} className="size-[17px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search meetings</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Settings" className="no-drag text-sidebar-foreground/70" onClick={() => void window.meetingRecorder.openSettings()}>
              <HugeiconsIcon icon={Settings02Icon} strokeWidth={1.7} className="size-[17px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                {recording ? (
                  <SidebarMenuButton onClick={() => void window.meetingRecorder.stopAppRecording()}>
                    <span className="flex size-[17px] items-center justify-center">
                      <span className="size-2.5 rounded-full bg-rec" />
                    </span>
                    <span>Stop recording</span>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    disabled={meeting.phase !== "idle" || !permissionsGranted(meeting.permissions)}
                    onClick={() => void window.meetingRecorder.startAppRecording()}
                  >
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={1.7} />
                    <span>New recording</span>
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.page === "home"} onClick={() => onView({ page: "home" })}>
                  <HugeiconsIcon icon={Home01Icon} strokeWidth={1.6} />
                  <span>Home</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {hasCall ? (
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={view.page === "live"} onClick={() => onView({ page: "live" })}>
                    <HugeiconsIcon icon={AudioWave01Icon} strokeWidth={1.6} />
                    <span>{recording ? "Recording" : meeting.phase === "idle" ? "Last call" : "Live call"}</span>
                  </SidebarMenuButton>
                  {recording ? (
                    <SidebarMenuBadge>
                      <span className="size-2 rounded-full bg-rec" aria-label="Recording" />
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              ) : null}
              <SidebarMenuItem>
                <SidebarMenuButton isActive={isMeetings("all")} onClick={() => onView({ page: "meetings", folder: "all" })}>
                  <HugeiconsIcon icon={Files02Icon} strokeWidth={1.6} />
                  <span>Meetings</span>
                </SidebarMenuButton>
                {library ? <SidebarMenuBadge className="tabular text-faint">{meetings.length}</SidebarMenuBadge> : null}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.page === "recordings"} onClick={() => onView({ page: "recordings", id: null })}>
                  <HugeiconsIcon icon={Video01Icon} strokeWidth={1.6} />
                  <span>Recordings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.page === "digest"} onClick={() => onView({ page: "digest" })}>
                  <HugeiconsIcon icon={News01Icon} strokeWidth={1.6} />
                  <span>Weekly digest</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.page === "actions"} onClick={() => onView({ page: "actions" })}>
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.6} />
                  <span>Action items</span>
                </SidebarMenuButton>
                {openActions ? <SidebarMenuBadge className="tabular text-faint">{openActions}</SidebarMenuBadge> : null}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.page === "dictation"} onClick={() => onView({ page: "dictation" })}>
                  <HugeiconsIcon icon={KeyboardIcon} strokeWidth={1.6} />
                  <span>Dictation</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.page === "clipboard"} onClick={() => onView({ page: "clipboard" })}>
                  <HugeiconsIcon icon={ClipboardIcon} strokeWidth={1.6} />
                  <span>Clipboard</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.page === "saved" && !view.board} onClick={() => onView({ page: "saved", board: "" })}>
                  <HugeiconsIcon icon={Bookmark02Icon} strokeWidth={1.6} />
                  <span>Saved</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Boards</SidebarGroupLabel>
          <SidebarGroupAction aria-label="New board" title="New board" onClick={() => setNewBoard(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={1.6} />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {boards.map((board) => (
                <SidebarMenuItem key={board.id}>
                  <SidebarMenuButton className="pr-10" isActive={view.page === "saved" && view.board === board.id} onClick={() => onView({ page: "saved", board: board.id })}>
                    <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={1.6} />
                    <span>{board.name}</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="tabular text-[12px] font-normal text-faint">{board.count}</SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
              {!boards.length ? (
                <SidebarMenuItem>
                  <SidebarMenuButton className="text-muted-foreground" onClick={() => setNewBoard(true)}>
                    <HugeiconsIcon icon={Add01Icon} strokeWidth={1.6} />
                    <span>New board</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {recent.length ? (
          <SidebarGroup>
            <SidebarGroupLabel>Recent</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {recent.map((entry) => (
                  <SidebarMenuItem key={entry.id}>
                    <SidebarMenuButton className="h-8 pr-10 text-[13.5px] text-sidebar-foreground/80" onClick={() => onOpenMeeting(entry.id)}>
                      <span className="flex size-[17px] shrink-0 items-center justify-center">
                        <span className={cn("size-1.5 rounded-full", entry.id === newest ? "bg-ember" : "bg-sidebar-foreground/30")} />
                      </span>
                      <span>{entry.title || "Untitled call"}</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge className="tabular text-[12px] font-normal text-faint">{shortAgo(entry.startedAt)}</SidebarMenuBadge>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        <SidebarGroup>
          <SidebarGroupLabel>Folders</SidebarGroupLabel>
          <SidebarGroupAction aria-label="New folder" title="New folder" onClick={() => setCreating(true)}>
            <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.6} />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {library?.folders.map((folder) =>
                renaming === folder.id ? (
                  <SidebarMenuItem key={folder.id} className="px-1">
                    <FolderNameInput
                      initial={folder.name}
                      onDone={(name) => {
                        setRenaming(null)
                        if (name && name !== folder.name) void run(() => window.meetingRecorder.renameFolder(folder.id, name))
                      }}
                    />
                  </SidebarMenuItem>
                ) : (
                  <SidebarMenuItem key={folder.id}>
                    <SidebarMenuButton isActive={isMeetings(folder.id)} onClick={() => onView({ page: "meetings", folder: folder.id })}>
                      <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.6} />
                      <span>{folder.name}</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge className="tabular text-faint group-hover/menu-item:opacity-0 group-has-data-[state=open]/menu-item:opacity-0">
                      {counts.get(folder.id) || 0}
                    </SidebarMenuBadge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction showOnHover aria-label={`${folder.name} options`}>
                          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={1.8} />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" className="w-40">
                        <DropdownMenuItem onSelect={() => setRenaming(folder.id)}>Rename</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(folder)}>
                          Delete folder…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                ),
              )}
              {creating ? (
                <SidebarMenuItem className="px-1">
                  <FolderNameInput
                    initial=""
                    onDone={(name) => {
                      setCreating(false)
                      if (name)
                        void run(async () => {
                          const folder = await window.meetingRecorder.createFolder(name)
                          onView({ page: "meetings", folder: folder.id })
                        })
                    }}
                  />
                </SidebarMenuItem>
              ) : null}
              {library && !library.folders.length && !creating ? (
                <SidebarMenuItem>
                  <SidebarMenuButton className="text-muted-foreground" onClick={() => setCreating(true)}>
                    <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.6} />
                    <span>New folder</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              {library?.folders.length ? (
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={isMeetings("unfiled")} className="text-muted-foreground" onClick={() => onView({ page: "meetings", folder: "unfiled" })}>
                    <span className="pl-6">No folder</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2.5 pt-1">
        <ProfileRow meeting={meeting} />
      </SidebarFooter>
      <BoardNameDialog
        open={newBoard}
        title="New board"
        initial=""
        onClose={() => setNewBoard(false)}
        onSubmit={async (name) => {
          const board = await window.meetingRecorder.createBoard(name)
          setNewBoard(false)
          onView({ page: "saved", board: board.id })
        }}
      />

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the {deleting?.name} folder?</AlertDialogTitle>
            <AlertDialogDescription>Its meetings aren't deleted. They move back to No folder.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const folder = deleting
                if (!folder) return
                if (view.page === "meetings" && view.folder === folder.id) onView({ page: "meetings", folder: "all" })
                void run(() => window.meetingRecorder.deleteFolder(folder.id))
              }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  )
}

export function App() {
  const meeting = useMeeting()
  const active = meeting.phase !== "idle"
  const homeNow = useNow(meeting.phase === "recording")
  const finished = meeting.phase === "idle" && meeting.segments.length > 0
  const showMeeting = active || finished || hasNotes(meeting.analysis)
  const { library, error } = useLibrary()
  const [view, setView] = useState<View>({ page: "home" })
  const hasCall = useRef(showMeeting)
  hasCall.current = showMeeting
  const [sidebarError, setSidebarError] = useState<string | null>(null)

  // The Ask card asked to open a meeting.
  const [openRequest, setOpenRequest] = useState<{ id: string; at: number } | null>(null)
  useEffect(() => {
    // "now" from the menu bar: the live call if there is one, otherwise Home.
    window.meetingRecorder.onNavigate((page) =>
      setView(page === "meetings" ? { page: "meetings", folder: "all" } : page === "now" && hasCall.current ? { page: "live" } : { page: "home" }),
    )
    window.meetingRecorder.onOpenMeeting((id) => {
      setView({ page: "meetings", folder: "all" })
      setOpenRequest({ id, at: Date.now() })
    })
    window.meetingRecorder.onOpenPage((page) => {
      if (page === "clipboard") setView({ page: "clipboard" })
      if (page === "saved") setView({ page: "saved", board: "" })
      if (page === "recordings") setView({ page: "recordings", id: null })
    })
    window.meetingRecorder.onOpenRecording((id, edit, share) => setView({ page: "recordings", id, edit, share }))
  }, [])

  // A call starting always brings you back to it.
  useEffect(() => {
    if (meeting.phase === "starting" || meeting.phase === "recording") setView({ page: "live" })
  }, [meeting.phase])

  useEffect(() => {
    if (!sidebarError) return
    const timer = window.setTimeout(() => setSidebarError(null), 4000)
    return () => window.clearTimeout(timer)
  }, [sidebarError])

  const folderTitle =
    view.page !== "meetings" || view.folder === "all"
      ? "Meetings"
      : view.folder === "unfiled"
        ? "No folder"
        : library?.folders.find((folder) => folder.id === view.folder)?.name || "Meetings"

  return (
    <SidebarProvider className="h-full min-h-0 bg-background">
      <AppSidebar
        view={view}
        onView={setView}
        meeting={meeting}
        hasCall={showMeeting}
        library={library}
        onError={setSidebarError}
        onOpenMeeting={(id) => {
          setView({ page: "meetings", folder: "all" })
          setOpenRequest({ id, at: Date.now() })
        }}
      />
      <SidebarInset className="flex h-full min-h-0 min-w-0 flex-col bg-background">
        {view.page === "live" && showMeeting ? (
          <>
            <TitleBar meeting={meeting} />
            <main className="relative flex min-h-0 flex-1">
              <NotesColumn meeting={meeting} finished={finished} />
              <div className="relative flex min-w-0 flex-1 flex-col">
                <Transcript meeting={meeting} finished={finished} />
                {meeting.phase === "recording" ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-6">
                    <div className="w-full max-w-[640px]">
                      <LiveHelp
                        library={library}
                        shortcut={meeting.settings?.liveHelpEnabled !== false ? meeting.settings?.liveHelpHotkeyLabel : null}
                        onOpenMeeting={(id) => {
                          setView({ page: "meetings", folder: "all" })
                          setOpenRequest({ id, at: Date.now() })
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </main>
            <StatusBar meeting={meeting} finished={finished} />
          </>
        ) : view.page === "home" || view.page === "live" ? (
          <Dashboard
            name={meeting.settings?.speakerName}
            canStart={meeting.phase === "idle" && permissionsGranted(meeting.permissions)}
            recording={{
              active: Boolean(active),
              title: meeting.calendar?.title,
              elapsed: meeting.phase === "recording" && meeting.startedAt ? formatElapsed(homeNow - meeting.startedAt) : undefined,
            }}
            meetings={library?.meetings || []}
            banners={
              <>
                <PermissionBanner meeting={meeting} />
                <WhatsNew
                  settings={meeting.settings}
                  onGo={(page) => setView(page === "meetings" ? { page: "meetings", folder: "all" } : page === "saved" ? { page: "saved", board: "" } : { page })}
                />
              </>
            }
            onOpenMeeting={(id) => {
              setView({ page: "meetings", folder: "all" })
              setOpenRequest({ id, at: Date.now() })
            }}
            onOpenMeetings={() => setView({ page: "meetings", folder: "all" })}
            onOpenActions={() => setView({ page: "actions" })}
            onShowLive={() => setView({ page: "live" })}
          />
        ) : view.page === "actions" ? (
          <>
            <div className="drag shrink-0 px-10 pt-11 pb-6">
              <PageHeader title="Action items" subtitle="Everything you and others agreed to do, from every call." />
            </div>
            <ActionsPage
              onOpenMeeting={(id) => {
                setView({ page: "meetings", folder: "all" })
                setOpenRequest({ id, at: Date.now() })
              }}
            />
          </>
        ) : view.page === "dictation" ? (
          <>
            <div className="drag shrink-0 px-10 pt-11 pb-6">
              <PageHeader title="Dictation" subtitle="Everything you've dictated or rewritten by voice, kept on this Mac." />
            </div>
            <HistoryPage enabled={meeting.settings?.dictationHistory !== false} />
          </>
        ) : view.page === "saved" ? (
          <SavedPage
            key={view.board}
            board={view.board}
            shortcut={meeting.settings?.savedEnabled === false ? undefined : meeting.settings?.saveHotkeyLabel}
            aiReady={Boolean(meeting.settings?.aiReady)}
            aiOn={meeting.settings?.savedAi !== false}
            onBoardGone={() => setView({ page: "saved", board: "" })}
          />
        ) : view.page === "recordings" ? (
          <RecordingsPage
            openId={view.id}
            editing={Boolean(view.edit)}
            sharing={Boolean(view.share)}
            onOpen={(id, edit) => setView({ page: "recordings", id, edit })}
            shortcut={meeting.settings?.recordEnabled === false ? undefined : meeting.settings?.recordHotkeyLabel}
            aiReady={Boolean(meeting.settings?.aiReady)}
          />
        ) : view.page === "clipboard" ? (
          <ClipboardPage
            enabled={meeting.settings?.clipboardHistoryEnabled !== false}
            shortcut={meeting.settings?.clipboardHotkeyLabel}
            grabShortcut={meeting.settings?.grabTextEnabled === false ? undefined : meeting.settings?.grabHotkeyLabel}
          />
        ) : view.page === "digest" ? (
          <>
            <div className="drag shrink-0 px-10 pt-11 pb-6">
              <PageHeader title="Weekly digest" subtitle="Each week's calls, decisions and open action items, summed up on Friday." />
            </div>
            <DigestPage
              library={library}
              onOpenMeeting={(id) => {
                setView({ page: "meetings", folder: "all" })
                setOpenRequest({ id, at: Date.now() })
              }}
            />
          </>
        ) : (
          <>
            <MeetingsPage
              library={library}
              loadError={error}
              folder={view.folder}
              title={folderTitle}
              onShowAll={() => setView({ page: "meetings", folder: "all" })}
              selfName={meeting.settings?.speakerName || null}
              openRequest={openRequest}
              askModel={meeting.settings?.aiReady ? (meeting.settings.aiLocal ? "the on-device model" : meeting.settings.openRouterModel) : null}
            />
          </>
        )}
        {sidebarError ? (
          <p role="status" className="fixed bottom-4 left-4 z-50 rounded-md border border-border bg-popover px-3 py-2 text-[13px] text-rec shadow-md">
            {sidebarError}
          </p>
        ) : null}
      </SidebarInset>
    </SidebarProvider>
  )
}
