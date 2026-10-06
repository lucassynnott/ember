import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  Copy01Icon,
  Delete02Icon,
  Download04Icon,
  Edit02Icon,
  Folder01Icon,
  Link01Icon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
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
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { plainWebcam } from "@/editor/model"
import { webcamRect } from "@/editor/render"
import { squirclePath, type Layout } from "@/editor/scene"
import type { RecordingDetail, RecordingFolder, RecordingSummary } from "@/types/bridge"

import { EditorPage } from "@/editor/Editor"

import { ShareDialog } from "./share"

import { Card, IconTile, Page, PageHeader, SectionTitle } from "./page"

const media = (id: string, kind: "video" | "thumb" | "edited" | "finished" | "camera", version = "") => `ember-media://recording/${id}/${kind}${version ? `?v=${version}` : ""}`

/**
 * The webcam over the original recording, as the finished version shows it (the plain look:
 * a rounded square, bottom left): it's saved as its own file, so it plays here in step with the screen.
 */
function CameraBubble({ screen, src, layout, width, height }: { screen: React.RefObject<HTMLVideoElement | null>; src: string; layout: { x: number; y: number; size: number }; width: number; height: number }) {
  const camera = useRef<HTMLVideoElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number; radius: number } | null>(null)
  // Where the recording sits in the player (it's letterboxed when its shape differs).
  useEffect(() => {
    const element = screen.current
    if (!element || !width || !height) return
    const place = () => {
      const scale = Math.min(element.clientWidth / width, element.clientHeight / height)
      const rect = webcamRect(plainWebcam(layout), { width, height } as Layout, 1, 1)
      if (!rect) return setBox(null)
      setBox({
        left: (element.clientWidth - width * scale) / 2 + rect.x * scale,
        top: (element.clientHeight - height * scale) / 2 + rect.y * scale,
        w: rect.w * scale,
        h: rect.h * scale,
        radius: rect.radius * scale,
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [screen, width, height, layout])
  // In step with the screen: play, pause, seek and speed follow it.
  useEffect(() => {
    const element = screen.current
    const own = camera.current
    if (!element || !own) return
    const follow = () => {
      own.playbackRate = element.playbackRate
      if (Math.abs(own.currentTime - element.currentTime) > 0.15) own.currentTime = element.currentTime
      if (element.paused || element.ended) own.pause()
      else void own.play().catch(() => {})
    }
    const events = ["play", "pause", "seeking", "seeked", "ratechange", "timeupdate", "ended"]
    for (const name of events) element.addEventListener(name, follow)
    follow()
    return () => {
      for (const name of events) element.removeEventListener(name, follow)
    }
  }, [screen, src])
  return (
    <div
      className="pointer-events-none absolute drop-shadow-[0_6px_14px_rgb(0_0_0/0.35)]"
      style={box ? { left: box.left, top: box.top, width: box.w, height: box.h } : { display: "none" }}
    >
      <video
        ref={camera}
        src={src}
        muted
        playsInline
        preload="auto"
        className="size-full -scale-x-100 object-cover"
        // The same squircle corners the finished version draws.
        style={box ? { clipPath: `path("${squirclePath(0, 0, box.w, box.h, box.radius)}")` } : undefined}
      />
    </div>
  )
}

export function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

function when(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return sameDay ? `Today, ${time}` : `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`
}

function useRecordings(query: string) {
  const [items, setItems] = useState<RecordingSummary[] | null>(null)
  const load = useCallback(async () => setItems(await window.meetingRecorder.recordingsList(query).catch(() => [])), [query])
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 150 : 0)
    return () => window.clearTimeout(timer)
  }, [load, query])
  useEffect(() => window.meetingRecorder.onRecordingsChanged(() => void load()), [load])
  return items
}

export function RecordingsPage({
  openId,
  editing,
  sharing = false,
  onOpen,
  shortcut,
  aiReady,
}: {
  openId: string | null
  editing: boolean
  /** Opens with its Share dialog showing (a video shared from Ember Drive). */
  sharing?: boolean
  onOpen: (id: string | null, edit?: boolean) => void
  shortcut?: string
  aiReady: boolean
}) {
  if (openId && editing) return <EditorPage key={`edit-${openId}`} id={openId} onClose={() => onOpen(openId)} />
  if (openId) return <RecordingView key={openId} id={openId} onBack={() => onOpen(null)} onEdit={() => onOpen(openId, true)} aiReady={aiReady} shareFirst={sharing} />
  return <RecordingList onOpen={onOpen} shortcut={shortcut} />
}

function NewRecordingButton({ shortcut, className }: { shortcut?: string; className?: string }) {
  return (
    <Button className={cn("h-10 rounded-full px-4 text-[14px]", className)} onClick={() => void window.meetingRecorder.newScreenRecording()}>
      <span className="size-2.5 rounded-full bg-[#1c0a03]" />
      New recording
      {shortcut ? <Kbd className="ml-1 bg-black/15 text-[#1c0a03]">{shortcut}</Kbd> : null}
    </Button>
  )
}

type KindFilter = "all" | "edited" | "shared" | "raw"
type TimeFilter = "all" | "7" | "30"
type Sort = "edited" | "created" | "name"

const FOLDER_COLORS = ["#ff7a2f", "#ef4444", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a3a3a3"]

function RecordingList({ onOpen, shortcut }: { onOpen: (id: string) => void; shortcut?: string }) {
  const [query, setQuery] = useState("")
  const items = useRecordings(query)
  const [folders, setFolders] = useState<RecordingFolder[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [kind, setKind] = useState<KindFilter>("all")
  const [since, setSince] = useState<TimeFilter>("all")
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem("ember.recordings.sort") as Sort) || "created")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [folderDialog, setFolderDialog] = useState<{ id: string | null; name: string; color: string } | null>(null)
  const [importing, setImporting] = useState(false)

  const loadFolders = useCallback(() => void window.meetingRecorder.recordingFolders().then(setFolders), [])
  useEffect(() => {
    loadFolders()
    return window.meetingRecorder.onRecordingsChanged(loadFolders)
  }, [loadFolders])

  const shown = useMemo(() => {
    const cutoff = since === "all" ? 0 : Date.now() - Number(since) * 86400000
    const list = (items || []).filter(
      (item) =>
        (!folder || item.folder === folder) &&
        (kind === "all" || (kind === "edited" ? item.edited : kind === "shared" ? item.share : !item.edited && !item.share)) &&
        Date.parse(item.createdAt) >= cutoff,
    )
    return [...list].sort((left, right) =>
      sort === "name" ? left.title.localeCompare(right.title) : sort === "edited" ? right.editedAt.localeCompare(left.editedAt) : right.createdAt.localeCompare(left.createdAt),
    )
  }, [items, folder, kind, since, sort])
  const empty = items !== null && !items.length && !query

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const importVideo = async () => {
    setImporting(true)
    try {
      const id = await window.meetingRecorder.importRecording()
      if (id) onOpen(id)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Recordings"
        subtitle="Your screen, camera and voice, transcribed on this Mac and written up with a title, summary and chapters."
        actions={
          <>
            <Button variant="pill" className="h-10 px-4 text-[14px]" disabled={importing} onClick={() => void importVideo()}>
              {importing ? <Spinner /> : null} Open video…
            </Button>
            <NewRecordingButton shortcut={shortcut} />
          </>
        }
      />
      {empty ? (
        <Card className="flex flex-col items-center gap-4 px-8 py-16 text-center">
          <IconTile icon={Video01Icon} className="size-14 rounded-2xl" tint="var(--ember)" />
          <div className="flex max-w-[460px] flex-col gap-1.5">
            <h2 className="text-[19px] font-semibold tracking-[-0.02em]">Record your screen</h2>
            <p className="text-[14.5px] text-muted-foreground">
              Show something instead of writing it down. Pick the whole screen, a window or an area, with your camera in a bubble and your microphone. It stays on
              your Mac. Or open any video to edit it.
            </p>
          </div>
          <NewRecordingButton shortcut={shortcut} />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-10 w-[300px] items-center gap-2 rounded-full border border-border bg-white/[0.03] px-4 text-muted-foreground focus-within:border-white/25">
              <HugeiconsIcon icon={Search01Icon} strokeWidth={1.7} className="size-4" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search titles and transcripts"
                className="h-full flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-faint"
              />
            </label>
            <FilterMenu label={{ all: "Everything", edited: "Edited", shared: "Shared", raw: "Not edited" }[kind]} options={[["all", "Everything"], ["edited", "Edited"], ["shared", "Shared"], ["raw", "Not edited"]]} onChange={(value) => setKind(value as KindFilter)} />
            <FilterMenu label={{ all: "Any time", "7": "Last 7 days", "30": "Last 30 days" }[since]} options={[["all", "Any time"], ["7", "Last 7 days"], ["30", "Last 30 days"]]} onChange={(value) => setSince(value as TimeFilter)} />
            <FilterMenu
              label={{ edited: "Last edited", created: "Last created", name: "Name" }[sort]}
              options={[["edited", "Last edited"], ["created", "Last created"], ["name", "Name"]]}
              onChange={(value) => {
                setSort(value as Sort)
                localStorage.setItem("ember.recordings.sort", value)
              }}
            />
          </div>
          <div className="-mt-2 flex flex-wrap items-center gap-1.5">
            <FolderChip active={!folder} label="All" onClick={() => setFolder(null)} />
            {folders.map((item) => (
              <FolderChip
                key={item.id}
                active={folder === item.id}
                label={item.name}
                color={item.color}
                onClick={() => setFolder(item.id)}
                onEdit={() => setFolderDialog({ id: item.id, name: item.name, color: item.color })}
              />
            ))}
            <button type="button" className="h-8 rounded-full border border-dashed border-white/20 px-3 text-[12.5px] text-muted-foreground hover:text-foreground" onClick={() => setFolderDialog({ id: null, name: "", color: FOLDER_COLORS[0] })}>
              New folder
            </button>
          </div>
          {selected.size ? (
            <div className="flex items-center gap-2 rounded-full border border-border bg-panel px-4 py-1.5 text-[13px]">
              {selected.size} selected
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="ml-2">
                    Move to folder
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => void window.meetingRecorder.setRecordingFolder([...selected], null).then(() => setSelected(new Set()))}>No folder</DropdownMenuItem>
                  {folders.map((item) => (
                    <DropdownMenuItem key={item.id} onSelect={() => void window.meetingRecorder.setRecordingFolder([...selected], item.id).then(() => setSelected(new Set()))}>
                      <span className="size-2 rounded-full" style={{ background: item.color }} /> {item.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="sm" className="hover:text-rec" onClick={() => setConfirmDelete(true)}>
                Move to Trash
              </Button>
              <button type="button" className="ml-auto text-[12px] text-faint hover:text-foreground" onClick={() => setSelected(new Set(shown.map((item) => item.id)))}>
                Select all
              </button>
              <button type="button" className="text-[12px] text-faint hover:text-foreground" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          ) : null}
          {items === null ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : shown.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
              {shown.map((item) => (
                <RecordingCard key={item.id} item={item} folder={folders.find((entry) => entry.id === item.folder)} selected={selected.has(item.id)} selecting={selected.size > 0} onSelect={() => toggle(item.id)} onOpen={() => onOpen(item.id)} />
              ))}
            </div>
          ) : (
            <p className="py-12 text-center text-[14px] text-muted-foreground">{query ? `No recordings match “${query}”.` : "No recordings here."}</p>
          )}
        </>
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} {selected.size === 1 ? "recording" : "recordings"}?</AlertDialogTitle>
            <AlertDialogDescription>They move to the Trash, and any share links stop working.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                for (const id of selected) await window.meetingRecorder.removeRecording(id)
                setSelected(new Set())
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={folderDialog !== null} onOpenChange={(open) => !open && setFolderDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{folderDialog?.id ? "Edit folder" : "New folder"}</AlertDialogTitle>
          </AlertDialogHeader>
          <input
            autoFocus
            value={folderDialog?.name || ""}
            onChange={(event) => setFolderDialog((current) => current && { ...current, name: event.target.value })}
            placeholder="Folder name"
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-[14px] outline-none focus:border-white/30"
          />
          <div className="flex gap-2">
            {FOLDER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setFolderDialog((current) => current && { ...current, color })}
                className={cn("size-7 rounded-full border-2", folderDialog?.color === color ? "border-white" : "border-transparent")}
                style={{ background: color }}
              />
            ))}
            <label className="relative size-7 cursor-pointer overflow-hidden rounded-full border-2 border-white/20 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]" title="Custom colour">
              <input type="color" value={folderDialog?.color || "#ff7a2f"} onChange={(event) => setFolderDialog((current) => current && { ...current, color: event.target.value })} className="absolute inset-0 opacity-0" />
            </label>
          </div>
          <AlertDialogFooter>
            {folderDialog?.id ? (
              <Button
                variant="ghost"
                className="mr-auto hover:text-rec"
                onClick={async () => {
                  await window.meetingRecorder.deleteRecordingFolder(folderDialog.id!)
                  if (folder === folderDialog.id) setFolder(null)
                  setFolderDialog(null)
                }}
              >
                Delete folder
              </Button>
            ) : null}
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!folderDialog?.name.trim()}
              onClick={async () => {
                if (!folderDialog) return
                if (folderDialog.id) await window.meetingRecorder.updateRecordingFolder(folderDialog.id, { name: folderDialog.name, color: folderDialog.color })
                else await window.meetingRecorder.createRecordingFolder(folderDialog.name, folderDialog.color)
                loadFolders()
              }}
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}

function FilterMenu({ label, options, onChange }: { label: string; options: [string, string][]; onChange: (value: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="pill" className="h-10 px-4 text-[13.5px]">
          {label} <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={1.8} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {options.map(([value, text]) => (
          <DropdownMenuItem key={value} onSelect={() => onChange(value)}>
            {text}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FolderChip({ active, label, color, onClick, onEdit }: { active: boolean; label: string; color?: string; onClick: () => void; onEdit?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onEdit}
      title={onEdit ? "Double-click to rename" : undefined}
      className={cn("flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px]", active ? "border-white/25 bg-white/[0.08] text-foreground" : "border-white/[0.08] text-muted-foreground hover:text-foreground")}
    >
      {color ? <span className="size-2 rounded-full" style={{ background: color }} /> : null}
      {label}
    </button>
  )
}

function StatusLabel({ item }: { item: RecordingSummary }) {
  if (item.status === "pending" || item.status === "processing") {
    return (
      <span className="flex items-center gap-1.5 text-ember">
        <Spinner className="size-3" /> {item.status === "pending" ? "Waiting to transcribe" : "Writing up"}
      </span>
    )
  }
  if (item.status === "failed") return <span className="text-rec">Couldn't transcribe</span>
  return null
}

function RecordingCard({
  item,
  folder,
  selected,
  selecting,
  onSelect,
  onOpen,
}: {
  item: RecordingSummary
  folder?: RecordingFolder
  selected: boolean
  selecting: boolean
  onSelect: () => void
  onOpen: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div className="group relative flex flex-col gap-3 text-left" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" onClick={selecting ? onSelect : onOpen} className={cn("relative aspect-video w-full overflow-hidden rounded-[14px] border bg-black/40", selected ? "border-ember ring-2 ring-ember/40" : "border-border")}>
        {item.hasThumb ? <img src={media(item.id, "thumb")} alt="" className="size-full object-cover" /> : null}
        {/* A muted preview plays while you hover. */}
        {hover && !selecting ? (
          <video src={item.finished ? media(item.id, "finished", item.finished.exportedAt) : media(item.id, "video")} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" />
        ) : null}
        {!item.hasThumb && !hover ? (
          <div className="flex size-full items-center justify-center text-faint">
            <HugeiconsIcon icon={Video01Icon} strokeWidth={1.5} className="size-8" />
          </div>
        ) : null}
        <span className="tabular absolute right-2 bottom-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[12px] font-medium text-white">{clock(item.finished?.duration ?? item.duration)}</span>
      </button>
      <button
        type="button"
        aria-label={selected ? "Unselect" : "Select"}
        onClick={onSelect}
        className={cn(
          "absolute top-2 left-2 flex size-6 items-center justify-center rounded-full border-2 transition-opacity",
          selected ? "border-ember bg-ember text-black opacity-100" : "border-white/80 bg-black/40 opacity-0 group-hover:opacity-100",
          selecting && "opacity-100",
        )}
      >
        {selected ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="size-3.5" /> : null}
      </button>
      <button type="button" onClick={onOpen} className="flex flex-col gap-1 px-0.5 text-left">
        <h3 className="truncate text-[15px] font-medium text-foreground group-hover:text-white">{item.title}</h3>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-faint">
          <span>{when(item.createdAt)}</span>
          <StatusLabel item={item} />
          {item.edited && !item.edited.auto ? <span className="text-foreground/70">Edited</span> : null}
          {item.share ? (
            <span className="flex items-center gap-1 text-ember/90">
              <HugeiconsIcon icon={Link01Icon} strokeWidth={1.8} className="size-3" /> Shared
            </span>
          ) : null}
          {folder ? (
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ background: folder.color }} />
              {folder.name}
            </span>
          ) : null}
        </p>
        {item.summary ? <p className="line-clamp-2 text-[13.5px] text-muted-foreground">{item.summary}</p> : null}
      </button>
    </div>
  )
}

function RecordingView({ id, onBack, onEdit, aiReady, shareFirst = false }: { id: string; onBack: () => void; onEdit: () => void; aiReady: boolean; shareFirst?: boolean }) {
  // The page plays the recording as it's shared from here (plain); the editor's version is a click away.
  const [showEdited, setShowEdited] = useState(false)
  const [sharing, setSharing] = useState(shareFirst)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [item, setItem] = useState<RecordingDetail | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  const [time, setTime] = useState(0)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const transcriptBox = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => setItem(await window.meetingRecorder.recordingGet(id).catch(() => null)), [id])
  useEffect(() => {
    void load()
    return window.meetingRecorder.onRecordingsChanged(() => void load())
  }, [load])

  // Transcript and chapter times are in the original, so they play it.
  const pendingSeek = useRef<number | null>(null)
  const seek = (seconds: number) => {
    if (item?.edited && showEdited) {
      pendingSeek.current = seconds
      setShowEdited(false)
      return
    }
    if (!video.current) return
    video.current.currentTime = seconds
    void video.current.play()
  }

  const current = useMemo(() => {
    const transcript = item?.transcript || []
    let index = -1
    for (let position = 0; position < transcript.length; position += 1) if (transcript[position].start <= time + 0.2) index = position
    return index
  }, [item?.transcript, time])

  // The line being spoken stays in view while it plays.
  useEffect(() => {
    if (current < 0 || video.current?.paused) return
    transcriptBox.current?.querySelector(`[data-line="${current}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [current])

  if (item === undefined) {
    return (
      <Page>
        <div className="flex justify-center py-24">
          <Spinner />
        </div>
      </Page>
    )
  }
  if (item === null) {
    return (
      <Page>
        <button type="button" onClick={onBack} className="no-drag flex items-center gap-1.5 text-[13.5px] text-muted-foreground hover:text-foreground">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.8} className="size-4" /> Recordings
        </button>
        <p className="text-muted-foreground">This recording has been deleted.</p>
      </Page>
    )
  }

  const saveTitle = async () => {
    setEditing(false)
    const next = title.trim()
    if (next && next !== item.title) {
      await window.meetingRecorder.renameRecording(id, next)
      void load()
    }
  }
  const copy = async () => {
    await window.meetingRecorder.copyRecordingFile(id)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const working = item.status === "pending" || item.status === "processing"
  const activeChapter = item.chapters.reduce((found, chapter, index) => (chapter.start <= time + 0.2 ? index : found), -1)

  return (
    <Page width="max-w-[1240px]" className="gap-6">
      <button type="button" onClick={onBack} className="no-drag flex w-fit items-center gap-1.5 text-[13.5px] text-muted-foreground hover:text-foreground">
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.8} className="size-4" /> Recordings
      </button>
      <PageHeader
        mark={false}
        title={
          editing ? (
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveTitle()
                if (event.key === "Escape") setEditing(false)
              }}
              className="no-drag w-full min-w-[320px] rounded-lg bg-white/[0.05] px-2 py-1 outline-none"
            />
          ) : (
            <button
              type="button"
              title="Rename"
              className="no-drag truncate text-left hover:text-white"
              onClick={() => {
                setTitle(item.title)
                setEditing(true)
              }}
            >
              {item.title}
            </button>
          )
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{when(item.createdAt)}</span>
            <span className="text-faint">·</span>
            <span className="tabular">{clock(item.duration)}</span>
            {item.source ? (
              <>
                <span className="text-faint">·</span>
                <span>{item.source}</span>
              </>
            ) : null}
            {item.width ? (
              <>
                <span className="text-faint">·</span>
                <span className="tabular">
                  {item.width}×{item.height}
                </span>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button className="h-9 rounded-full px-4 text-[13.5px]" onClick={() => setSharing(true)}>
              <HugeiconsIcon icon={Link01Icon} strokeWidth={1.8} /> {item.share ? "Shared" : "Share"}
            </Button>
            <Button variant="pill" className="h-9 px-3.5 text-[13.5px]" onClick={onEdit}>
              <HugeiconsIcon icon={Edit02Icon} strokeWidth={1.8} /> {item.edited ? "Edit again" : "Edit video"}
            </Button>
            <Button variant="pill" className="h-9 px-3.5 text-[13.5px]" onClick={() => void copy()}>
              <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={1.8} />
              {copied ? "Copied" : "Copy video"}
            </Button>
            <Button variant="pill" className="h-9 px-3.5 text-[13.5px]" onClick={() => void window.meetingRecorder.exportRecording(id)}>
              <HugeiconsIcon icon={Download04Icon} strokeWidth={1.8} /> Export
            </Button>
            <Button variant="ghost" size="icon" title="Show in Finder" aria-label="Show in Finder" onClick={() => void window.meetingRecorder.revealRecording(id)}>
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.7} />
            </Button>
            <Button variant="ghost" size="icon" title="Delete" aria-label="Delete recording" className="hover:text-rec" onClick={() => setConfirmDelete(true)}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.7} />
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          {item.edited ? (
            <div className="-mb-2 flex items-center gap-2 text-[13px]">
              <div className="flex rounded-full border border-border p-0.5">
                {[
                  { edited: false, label: "Recording" },
                  { edited: true, label: "Edited" },
                ].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => setShowEdited(option.edited)}
                    className={cn("h-7 rounded-full px-3", showEdited === option.edited ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <span className="min-w-0 truncate text-faint">
                {showEdited
                  ? `${clock(item.edited.duration)} · ${item.edited.width}×${item.edited.height} · share it from the editor's Export`
                  : "What Share, Copy video and Export send from here"}
              </span>
              <button type="button" className="ml-auto shrink-0 text-[12.5px] text-faint hover:text-foreground" onClick={() => setConfirmRevert(true)}>
                Discard edit
              </button>
            </div>
          ) : null}
          {item.finishing && !(item.edited && showEdited) ? (
            <div className="-mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5 text-ember" />
              Adding your webcam and cursor. Sharing and copying wait for it.
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-2xl border border-border bg-black">
            <video
              key={item.edited && showEdited ? `edited-${item.edited.exportedAt}` : item.finished ? `finished-${item.finished.exportedAt}` : "original"}
              ref={video}
              src={item.edited && showEdited ? media(id, "edited", item.edited.exportedAt) : item.finished ? media(id, "finished", item.finished.exportedAt) : media(id, "video")}
              poster={item.hasThumb ? media(id, "thumb") : undefined}
              controls
              preload="metadata"
              className="aspect-video w-full bg-black"
              onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => {
                if (pendingSeek.current === null) return
                event.currentTarget.currentTime = pendingSeek.current
                pendingSeek.current = null
                void event.currentTarget.play()
              }}
            />
            {/* Until the plain version is made, the webcam plays over the recording in the same spot. */}
            {item.camera && !item.finished && !(item.edited && showEdited) ? <CameraBubble screen={video} src={media(id, "camera")} layout={item.camera} width={item.width} height={item.height} /> : null}
          </div>

          {working ? (
            <Card className="flex items-center gap-3 px-5 py-4 text-[14px] text-muted-foreground">
              <Spinner className="text-ember" />
              {item.status === "pending" ? "Waiting to transcribe. Recordings are written up after any call you're in." : "Transcribing on this Mac and writing it up…"}
            </Card>
          ) : item.status === "failed" ? (
            <Card className="flex items-center gap-3 px-5 py-4 text-[14px]">
              <span className="flex-1 text-muted-foreground">
                <span className="text-rec">Couldn't transcribe this recording.</span> {item.error}
              </span>
              <Button variant="pill" className="h-9 px-3.5" onClick={() => void window.meetingRecorder.retryRecording(id)}>
                <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.8} /> Try again
              </Button>
            </Card>
          ) : null}

          {item.summary || item.chapters.length ? (
            <Card className="flex flex-col gap-4 p-5">
              {item.summary ? <p className="text-[15px] leading-relaxed text-foreground/90">{item.summary}</p> : null}
              {item.chapters.length ? (
                <div className="flex flex-col gap-1">
                  <SectionTitle>Chapters</SectionTitle>
                  <ol className="mt-1 flex flex-col">
                    {item.chapters.map((chapter, index) => (
                      <li key={chapter.start}>
                        <button
                          type="button"
                          onClick={() => seek(chapter.start)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] hover:bg-white/[0.05]",
                            index === activeChapter && "bg-ember/[0.08]",
                          )}
                        >
                          <span className={cn("tabular w-12 shrink-0 text-[13px]", index === activeChapter ? "text-ember" : "text-faint")}>{clock(chapter.start)}</span>
                          <span>{chapter.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </Card>
          ) : item.status === "ready" && item.transcript.length && !aiReady ? (
            <Card className="px-5 py-4 text-[14px] text-muted-foreground">Set up AI in Settings → AI notes to get a title, summary and chapters for each recording.</Card>
          ) : null}
        </div>

        <Card className="flex max-h-[calc(100vh-150px)] min-h-[240px] flex-col xl:sticky xl:top-6">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-[14px] font-medium">Transcript</h2>
            {item.status === "ready" && item.transcript.length && aiReady ? (
              <button type="button" className="text-[12.5px] text-faint hover:text-foreground" onClick={() => void window.meetingRecorder.retryRecording(id)}>
                Write up again
              </button>
            ) : null}
          </div>
          <div ref={transcriptBox} className="min-h-0 flex-1 overflow-y-auto p-2">
            {item.transcript.length ? (
              item.transcript.map((line, index) => (
                <button
                  key={`${line.start}-${index}`}
                  type="button"
                  data-line={index}
                  onClick={() => seek(line.start)}
                  className={cn("flex w-full gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/[0.04]", index === current && "bg-white/[0.06]")}
                >
                  <span className={cn("tabular w-10 shrink-0 pt-px text-[12px]", index === current ? "text-ember" : "text-faint")}>{clock(line.start)}</span>
                  <span className={cn("text-[14px] leading-relaxed", index === current ? "text-foreground" : "text-foreground/75")}>{line.text}</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-8 text-center text-[13.5px] text-muted-foreground">
                {working ? "The transcript appears here when it's ready." : item.status === "failed" ? "No transcript yet." : "Nothing was said in this recording."}
              </p>
            )}
          </div>
        </Card>
      </div>

      <ShareDialog recording={item} open={sharing} onOpenChange={setSharing} />

      <AlertDialog open={confirmRevert} onOpenChange={setConfirmRevert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard the edit?</AlertDialogTitle>
            <AlertDialogDescription>The edited video and your edits are deleted. The recording, as it plays here, isn't touched.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                await window.meetingRecorder.discardRecordingEdit(id)
                setShowEdited(false)
                void load()
              }}
            >
              Discard edit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
            <AlertDialogDescription>The video and its transcript move to the Trash.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                await window.meetingRecorder.removeRecording(id)
                onBack()
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
