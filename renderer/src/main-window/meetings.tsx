import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BubbleChatQuestionIcon,
  Cancel01Icon,
  Delete02Icon,
  Folder01Icon,
  MoreHorizontalIcon,
  Note01Icon,
  Tag01Icon,
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { AskScope, MeetingDetail, MeetingLibraryState, MeetingSummary } from "@/types/bridge"

import { SearchBar, useAsk, type SearchMode } from "./ask"

/* Shared state */

export type FolderFilter = "all" | "unfiled" | string

const EMPTY_LIBRARY: MeetingLibraryState = { meetings: [], folders: [], tags: [] }
const listeners = new Set<() => void>()
let subscribed = false

export function errorText(failure: unknown) {
  return String((failure as Error)?.message || failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
}

// One library for the sidebar and the page. It reloads when the main process says something changed.
export function useLibrary() {
  const [library, setLibrary] = useState<MeetingLibraryState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setLibrary(await window.meetingRecorder.listMeetings())
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
      setLibrary((current) => current || EMPTY_LIBRARY)
    }
  }, [])

  useEffect(() => {
    if (!subscribed) {
      subscribed = true
      window.meetingRecorder.onLibraryChanged(() => listeners.forEach((listener) => listener()))
    }
    const listener = () => void reload()
    listeners.add(listener)
    void reload()
    return () => {
      listeners.delete(listener)
    }
  }, [reload])

  return { library, error, reload }
}

/* Formatting */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function pad(value: number) {
  return String(value).padStart(2, "0")
}

function clock(time: number) {
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dayStart(time: number) {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayLabel(time: number) {
  const today = dayStart(Date.now())
  const day = dayStart(time)
  const date = new Date(time)
  if (day === today) return "Today"
  if (day === today - 86_400_000) return "Yesterday"
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}${sameYear ? "" : ` ${date.getFullYear()}`}`
}

function fullDate(time: number) {
  const date = new Date(time)
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${clock(time)}`
}

function durationLabel(seconds: number | null) {
  if (seconds == null) return null
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`
}

export function shortDate(meeting: Pick<MeetingSummary, "startedAt" | "duration">) {
  if (!meeting.startedAt) return durationLabel(meeting.duration) || ""
  const date = new Date(meeting.startedAt)
  return [`${date.getDate()} ${MONTHS[date.getMonth()]}`, durationLabel(meeting.duration)].filter(Boolean).join(" · ")
}

function readCollapsed() {
  try {
    return localStorage.getItem("meetings.searchCollapsed") === "1"
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean) {
  try {
    localStorage.setItem("meetings.searchCollapsed", value ? "1" : "0")
  } catch {
    // Remembering this is only a convenience.
  }
}

export function meetingName(meeting: Pick<MeetingSummary, "title" | "startedAt">) {
  if (meeting.title) return meeting.title
  return meeting.startedAt ? `Call at ${clock(meeting.startedAt)}` : "Untitled call"
}

/* List */

function MeetingRow({
  meeting,
  selected,
  folderName,
  onSelect,
}: {
  meeting: MeetingSummary
  selected: boolean
  folderName: string | null
  onSelect: () => void
}) {
  const details = [
    meeting.startedAt && meeting.title ? clock(meeting.startedAt) : null,
    durationLabel(meeting.duration),
    folderName,
  ].filter(Boolean)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="flex items-baseline gap-3">
        <span className={cn("min-w-0 flex-1 truncate text-[14px]", meeting.title ? "text-foreground" : "text-foreground/70")}>
          {meetingName(meeting)}
        </span>
        <span className="tabular shrink-0 text-[12px] text-faint">{details.join(" · ")}</span>
      </span>
      {meeting.preview ? (
        <span className="line-clamp-2 text-[13px] leading-[1.4] text-muted-foreground">{meeting.preview}</span>
      ) : (
        <span className="text-[13px] text-faint">
          {meeting.notionUrl ? "Notes are in Notion. Audio is on this Mac." : "Audio only. No notes were saved."}
        </span>
      )}
      {meeting.tags.length ? (
        <span className="flex flex-wrap gap-1 pt-0.5">
          {meeting.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="h-[18px] px-1.5 text-[11px] font-normal text-muted-foreground">
              {tag}
            </Badge>
          ))}
        </span>
      ) : null}
    </button>
  )
}

function MeetingList({
  meetings,
  folders,
  selectedId,
  onSelect,
  loading,
  emptyTitle,
  emptyDescription,
}: {
  meetings: MeetingSummary[]
  folders: Map<string, string>
  selectedId: string | null
  onSelect: (id: string) => void
  loading: boolean
  emptyTitle: string
  emptyDescription: string
}) {
  const groups = useMemo(() => {
    const result: { label: string; meetings: MeetingSummary[] }[] = []
    for (const meeting of meetings) {
      const label = meeting.startedAt ? dayLabel(meeting.startedAt) : "Undated"
      const last = result[result.length - 1]
      if (last?.label === label) last.meetings.push(meeting)
      else result.push({ label, meetings: [meeting] })
    }
    return result
  }, [meetings])

  if (loading) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4" aria-label="Loading meetings">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex flex-col gap-2 py-1">
            <Skeleton className="h-3.5 w-[60%]" />
            <Skeleton className="h-3 w-[90%]" />
          </div>
        ))}
      </div>
    )
  }

  if (!meetings.length) {
    return (
      <Empty className="border-0 px-6 py-16">
        <EmptyHeader>
          <EmptyTitle className="text-[15px]">{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-4 px-3 pt-1 pb-28">
        {groups.map((group) => (
          <section key={group.label} className="flex flex-col gap-0.5">
            <h3 className="px-3 pt-2 pb-1 text-[12px] font-medium text-faint">{group.label}</h3>
            {group.meetings.map((meeting) => (
              <MeetingRow
                key={meeting.id}
                meeting={meeting}
                selected={meeting.id === selectedId}
                folderName={meeting.folderId ? folders.get(meeting.folderId) || null : null}
                onSelect={() => onSelect(meeting.id)}
              />
            ))}
          </section>
        ))}
      </div>
    </ScrollArea>
  )
}

/* Detail */

function TitleEditor({ meeting, onRename }: { meeting: MeetingDetail; onRename: (title: string) => void }) {
  const [value, setValue] = useState(meeting.title || "")
  useEffect(() => setValue(meeting.title || ""), [meeting.id, meeting.title])
  const commit = () => {
    if (value.trim() !== (meeting.title || "")) onRename(value)
  }
  return (
    <Input
      aria-label="Meeting title"
      value={value}
      placeholder={meetingName({ title: null, startedAt: meeting.startedAt })}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur()
        if (event.key === "Escape") {
          setValue(meeting.title || "")
          requestAnimationFrame(() => (event.target as HTMLInputElement).blur())
        }
      }}
      className="h-auto border-transparent bg-transparent px-2 py-1 -ml-2 text-[21px] md:text-[21px] font-normal tracking-[-0.02em] shadow-none placeholder:text-foreground/60 hover:border-border focus-visible:border-ring dark:bg-transparent"
    />
  )
}

function TagEditor({
  tags,
  allTags,
  onChange,
}: {
  tags: string[]
  allTags: string[]
  onChange: (tags: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const suggestions = allTags.filter((tag) => !tags.some((current) => current.toLowerCase() === tag.toLowerCase()))
  const trimmed = query.trim()
  const isNew = trimmed && !allTags.some((tag) => tag.toLowerCase() === trimmed.toLowerCase())

  const add = (tag: string) => {
    onChange([...tags, tag])
    setQuery("")
    setOpen(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="h-6 gap-1 pr-1 pl-2 text-[12px] font-normal">
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-background/40 hover:text-foreground"
            onClick={() => onChange(tags.filter((current) => current !== tag))}
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-3" strokeWidth={2} />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 gap-1.5 px-2 text-[12px] text-muted-foreground">
            <HugeiconsIcon icon={Tag01Icon} className="size-3.5" strokeWidth={1.8} />
            Add tag
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-0" align="start">
          <Command>
            <CommandInput placeholder="Find or create a tag" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>Type a name to create a tag.</CommandEmpty>
              {isNew ? (
                <CommandGroup>
                  <CommandItem value={`create ${trimmed}`} onSelect={() => add(trimmed)}>
                    Create “{trimmed}”
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {suggestions.length ? (
                <CommandGroup heading="Tags">
                  {suggestions.map((tag) => (
                    <CommandItem key={tag} value={tag} onSelect={() => add(tag)}>
                      {tag}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Lines({ items, empty, bullets }: { items: string[]; empty: string; bullets?: boolean }) {
  if (!items.length) return <p className="text-[14px] text-faint">{empty}</p>
  return (
    <ul
      className={cn("flex flex-col gap-1.5 text-[15px] leading-[1.5] text-foreground/90", bullets && "list-disc pl-5 marker:text-faint")}
      data-selectable
    >
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  )
}

function MeetingTranscript({ lines }: { lines: MeetingDetail["transcript"] }) {
  if (!lines.length) return <p className="text-[14px] text-faint">No speech was transcribed.</p>
  return (
    <ol className="flex flex-col" data-selectable>
      {lines.map((line, index) => {
        const sameSpeaker = index > 0 && lines[index - 1].speaker === line.speaker
        return (
          <li
            key={index}
            className={cn(
              "grid grid-cols-[120px_1fr] gap-x-5 border-l border-rail/60 pl-5 max-[1000px]:grid-cols-[88px_1fr]",
              sameSpeaker ? "pt-1.5" : "pt-4",
            )}
          >
            <span className="truncate pt-px text-[13px] text-muted-foreground">{sameSpeaker ? "" : line.speaker || ""}</span>
            <p className="max-w-[640px] text-[15px] leading-[1.55] text-foreground/88">{line.text}</p>
          </li>
        )
      })}
    </ol>
  )
}

function MeetingActions({
  meeting,
  folders,
  onMove,
  onDelete,
}: {
  meeting: MeetingDetail
  folders: MeetingLibraryState["folders"]
  onMove: (folderId: string | null) => void
  onDelete: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More actions">
          <HugeiconsIcon icon={MoreHorizontalIcon} className="size-5" strokeWidth={1.8} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {meeting.hasNote ? (
          <DropdownMenuItem onSelect={() => void window.meetingRecorder.openMeetingNote(meeting.id)}>Open note</DropdownMenuItem>
        ) : null}
        {meeting.notionUrl ? (
          <DropdownMenuItem onSelect={() => void window.meetingRecorder.openNote(meeting.notionUrl!)}>Open in Notion</DropdownMenuItem>
        ) : null}
        {meeting.hasNote ? (
          <DropdownMenuItem onSelect={() => void window.meetingRecorder.revealMeeting(meeting.id, "note")}>Show note in Finder</DropdownMenuItem>
        ) : null}
        {meeting.hasAudio ? (
          <DropdownMenuItem onSelect={() => void window.meetingRecorder.revealMeeting(meeting.id, "audio")}>Show audio in Finder</DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to folder</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            <DropdownMenuRadioGroup value={meeting.folderId || ""} onValueChange={(value) => onMove(value || null)}>
              <DropdownMenuRadioItem value="">No folder</DropdownMenuRadioItem>
              {folders.map((folder) => (
                <DropdownMenuRadioItem key={folder.id} value={folder.id}>
                  {folder.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {!folders.length ? <DropdownMenuLabel className="text-[12px] font-normal text-faint">Create folders in the sidebar.</DropdownMenuLabel> : null}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MeetingView({
  id,
  library,
  onDeleted,
  onError,
}: {
  id: string
  library: MeetingLibraryState
  onDeleted: () => void
  onError: (message: string) => void
}) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const summary = library.meetings.find((candidate) => candidate.id === id)

  // Reload when the list entry changes (rename, tags, folder, Notion link).
  const version = summary ? JSON.stringify(summary) : ""
  useEffect(() => {
    let cancelled = false
    window.meetingRecorder
      .getMeeting(id)
      .then((detail) => {
        if (cancelled) return
        setMeeting(detail)
        setMissing(null)
      })
      .catch((failure) => !cancelled && setMissing(errorText(failure)))
    return () => {
      cancelled = true
    }
  }, [id, version])

  const update = async (changes: Parameters<typeof window.meetingRecorder.updateMeeting>[1]) => {
    if (!meeting) return
    setMeeting({ ...meeting, ...changes, title: changes.title !== undefined ? changes.title.trim() || null : meeting.title } as MeetingDetail)
    try {
      await window.meetingRecorder.updateMeeting(meeting.id, changes)
    } catch (failure) {
      onError(errorText(failure))
    }
  }

  if (missing) {
    return (
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyTitle className="text-[15px]">Can't open this meeting</EmptyTitle>
          <EmptyDescription>{missing}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!meeting || meeting.id !== id) {
    return (
      <div className="flex flex-col gap-3 px-10 py-8">
        <Skeleton className="h-6 w-[45%]" />
        <Skeleton className="h-3 w-[30%]" />
        <Skeleton className="mt-6 h-3 w-[80%]" />
        <Skeleton className="h-3 w-[70%]" />
      </div>
    )
  }

  const folderName = library.folders.find((folder) => folder.id === meeting.folderId)?.name
  const facts = [
    meeting.startedAt ? fullDate(meeting.startedAt) : null,
    durationLabel(meeting.duration),
    meeting.transcription,
  ].filter(Boolean)
  const actions = meeting.actionItems.map(({ owner, task }) => `${owner || "Unassigned"}: ${task}`)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-2 border-b border-border px-10 pt-6 pb-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <TitleEditor meeting={meeting} onRename={(title) => void update({ title })} />
          </div>
          {meeting.notionUrl ? (
            <Button variant="secondary" size="sm" onClick={() => void window.meetingRecorder.openNote(meeting.notionUrl!)}>
              Open in Notion
            </Button>
          ) : null}
          <MeetingActions
            meeting={meeting}
            folders={library.folders}
            onMove={(folderId) => void update({ folderId })}
            onDelete={() => setConfirmDelete(true)}
          />
        </div>
        <p className="tabular text-[13px] text-muted-foreground">
          {facts.join(" · ")}
          {folderName ? (
            <span className="ml-2 inline-flex items-center gap-1 align-middle text-muted-foreground">
              <HugeiconsIcon icon={Folder01Icon} className="size-3.5" strokeWidth={1.8} />
              {folderName}
            </span>
          ) : null}
        </p>
        <TagEditor tags={meeting.tags} allTags={library.tags} onChange={(tags) => void update({ tags })} />
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {meeting.hasNote ? (
          <div className="flex max-w-[860px] flex-col gap-6 px-10 pt-7 pb-32">
            <DetailSection title="Summary">
              <Lines items={meeting.summary} empty="No summary was written." />
            </DetailSection>
            <Separator />
            <DetailSection title="Decisions">
              <Lines items={meeting.decisions} empty="No decisions captured." bullets />
            </DetailSection>
            <Separator />
            <DetailSection title="Action items">
              <Lines items={actions} empty="No action items captured." bullets />
            </DetailSection>
            <Separator />
            <DetailSection title="Transcript">
              <MeetingTranscript lines={meeting.transcript} />
            </DetailSection>
          </div>
        ) : (
          <Empty className="border-0 py-20">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Note01Icon} strokeWidth={1.6} />
              </EmptyMedia>
              <EmptyTitle className="text-[15px]">No notes on this Mac</EmptyTitle>
              <EmptyDescription>
                {meeting.notionUrl
                  ? "This call was saved to Notion before Meeting Notes kept local copies. The audio is still on this Mac."
                  : "Only the audio was kept for this call. Processing may have failed, or the notes went somewhere else."}
              </EmptyDescription>
            </EmptyHeader>
            <div className="flex gap-2">
              {meeting.notionUrl ? (
                <Button size="sm" onClick={() => void window.meetingRecorder.openNote(meeting.notionUrl!)}>
                  Open in Notion
                </Button>
              ) : null}
              {meeting.hasAudio ? (
                <Button size="sm" variant="secondary" onClick={() => void window.meetingRecorder.revealMeeting(meeting.id, "audio")}>
                  Show audio in Finder
                </Button>
              ) : null}
            </div>
          </Empty>
        )}
      </ScrollArea>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{meetingName(meeting)}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The note and audio move to the Trash, so you can still restore them from Finder.
              {meeting.notionUrl ? " The Notion page isn't touched." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                try {
                  await window.meetingRecorder.removeMeeting(meeting.id)
                  onDeleted()
                } catch (failure) {
                  onError(errorText(failure))
                }
              }}
            >
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* Page */

function folderScope(folder: FolderFilter): AskScope {
  return folder === "all" ? { kind: "all" } : folder === "unfiled" ? { kind: "unfiled" } : { kind: "folder", id: folder }
}

export function MeetingsPage({
  library,
  loadError,
  folder,
  title,
  askModel,
  onShowAll,
}: {
  library: MeetingLibraryState | null
  loadError: string | null
  folder: FolderFilter
  title: string
  askModel: string | null
  onShowAll: () => void
}) {
  const [askScope, setAskScope] = useState<AskScope>(() => folderScope(folder))
  const chat = useAsk(askScope)
  const askMessages = chat.messages
  const [searchMode, setSearchMode] = useState<SearchMode>("search")
  const [collapsed, setCollapsedState] = useState(readCollapsed)
  const [answerFilter, setAnswerFilter] = useState<string[] | null>(null)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const setCollapsed = (value: boolean) => {
    setCollapsedState(value)
    writeCollapsed(value)
  }

  // Full-text search runs in the main process, debounced.
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setMatches(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      window.meetingRecorder
        .searchMeetings(trimmed)
        .then((ids) => !cancelled && setMatches(ids ? new Set(ids) : null))
        .catch((failure) => !cancelled && setNotice(errorText(failure)))
    }, 160)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, library])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (event.metaKey && (key === "f" || key === "k")) {
        event.preventDefault()
        setSearchMode(key === "f" ? "search" : "ask")
        setCollapsed(false)
        requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const folders = useMemo(() => new Map((library?.folders || []).map((entry) => [entry.id, entry.name])), [library])
  const activeTags = tagFilter.filter((tag) => library?.tags.includes(tag))

  const visible = useMemo(() => {
    return (library?.meetings || []).filter((meeting) => {
      if (folder === "unfiled" && meeting.folderId && folders.has(meeting.folderId)) return false
      if (folder !== "all" && folder !== "unfiled" && meeting.folderId !== folder) return false
      if (activeTags.length && !activeTags.every((tag) => meeting.tags.includes(tag))) return false
      if (searchMode === "search" && matches && !matches.has(meeting.id)) return false
      if (answerFilter && !answerFilter.includes(meeting.id)) return false
      return true
    })
  }, [library, folder, folders, activeTags, matches, answerFilter, searchMode])

  // Keep a selection: the chosen meeting if it's still listed, otherwise the newest.
  const selected = visible.some((meeting) => meeting.id === selectedId) ? selectedId : visible[0]?.id || null

  // A fresh chat follows the folder you're looking at.
  useEffect(() => {
    if (!askMessages.length) setAskScope(folderScope(folder))
  }, [folder, askMessages.length])

  const folderTitle =
    folder === "all" ? "All meetings" : folder === "unfiled" ? "No folder" : folders.get(folder) || "Folder"
  const filtering = Boolean((searchMode === "search" && query.trim()) || activeTags.length || answerFilter)

  return (
    <>
    <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-6">
      <h1 className="truncate text-[21px] font-normal tracking-[-0.02em]">{title}</h1>
    </header>
    <div className="relative flex min-h-0 flex-1">
      <section className="flex w-[340px] shrink-0 flex-col border-r border-border max-[1000px]:w-[290px]">
        <div className="flex flex-col gap-2 px-4 pt-2 pb-1">
          {answerFilter ? (
            <div className="flex items-center gap-2 rounded-md bg-accent/60 py-1 pr-1 pl-2.5 text-[12px] text-foreground">
              <HugeiconsIcon icon={BubbleChatQuestionIcon} strokeWidth={1.8} className="size-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">Calls from your question</span>
              <Button variant="ghost" size="icon-xs" aria-label="Show all calls" onClick={() => setAnswerFilter(null)}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="tabular flex-1 truncate text-[12px] text-faint">
              {library ? `${visible.length} ${visible.length === 1 ? "meeting" : "meetings"}` : ""}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className={cn("h-7 gap-1.5 px-2 text-[12px]", activeTags.length ? "text-foreground" : "text-muted-foreground")}>
                  <HugeiconsIcon icon={Tag01Icon} className="size-3.5" strokeWidth={1.8} />
                  {activeTags.length ? activeTags.join(", ") : "Tags"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {library?.tags.length ? (
                  <>
                    {library.tags.map((tag) => (
                      <DropdownMenuCheckboxItem
                        key={tag}
                        checked={activeTags.includes(tag)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) =>
                          setTagFilter((current) => (checked ? [...current, tag] : current.filter((value) => value !== tag)))
                        }
                      >
                        {tag}
                      </DropdownMenuCheckboxItem>
                    ))}
                    {activeTags.length ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setTagFilter([])}>Clear tags</DropdownMenuItem>
                      </>
                    ) : null}
                  </>
                ) : (
                  <DropdownMenuLabel className="text-[12px] font-normal text-muted-foreground">
                    No tags yet. Add them from a meeting.
                  </DropdownMenuLabel>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {loadError ? <p className="px-5 pb-2 text-[12px] text-rec">{loadError}</p> : null}
        <MeetingList
          meetings={visible}
          folders={folders}
          selectedId={selected}
          onSelect={setSelectedId}
          loading={!library}
          emptyTitle={filtering ? "No matches" : folder === "all" ? "No meetings yet" : `Nothing in ${folderTitle}`}
          emptyDescription={
            filtering
              ? "Try other words, or clear the tag filter."
              : folder === "all"
                ? "Record a call and it shows up here with its notes and transcript."
                : "Move a meeting here from its … menu."
          }
        />
      </section>
      <section className="relative flex min-w-0 flex-1 flex-col">
        {selected && library ? (
          <MeetingView
            key={selected}
            id={selected}
            library={library}
            onDeleted={() => setSelectedId(null)}
            onError={setNotice}
          />
        ) : library ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle className="text-[15px]">{folderTitle}</EmptyTitle>
              <EmptyDescription>Pick a meeting to read its notes and transcript.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {notice ? (
          <p role="status" className="absolute top-4 right-6 z-30 rounded-md border border-border bg-popover px-3 py-2 text-[13px] text-rec shadow-md">
            {notice}
          </p>
        ) : null}
      </section>
      {library ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-6">
          <div className={cn("flex justify-center", collapsed ? "" : "w-full max-w-[680px]")}>
            <SearchBar
              library={library}
              mode={searchMode}
              onModeChange={setSearchMode}
              query={query}
              onQueryChange={setQuery}
              collapsed={collapsed}
              onCollapsedChange={setCollapsed}
              chat={chat}
              scope={askScope}
              onScopeChange={setAskScope}
              selectedMeetingId={selected}
              model={askModel}
              inputRef={searchRef}
              onShowInList={(ids) => {
                setAnswerFilter(ids)
                setTagFilter([])
                if (folder !== "all") onShowAll()
              }}
              onOpenMeeting={(id) => {
                const target = library.meetings.find((meeting) => meeting.id === id)
                if (folder !== "all" && target?.folderId !== folder) onShowAll()
                if (answerFilter && !answerFilter.includes(id)) setAnswerFilter(null)
                setTagFilter([])
                setSelectedId(id)
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
    </>
  )
}
