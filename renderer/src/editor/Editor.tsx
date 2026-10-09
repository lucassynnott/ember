import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  ArrowTurnBackwardIcon,
  ArrowTurnForwardIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Cursor01Icon,
  Download04Icon,
  Film01Icon,
  Image01Icon,
  LayoutTwoColumnIcon,
  TextAlignLeftIcon,
  Link01Icon,
  LinkSquare02Icon,
  MusicNote01Icon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  Settings02Icon,
  SubtitleIcon,
  Tick02Icon,
  Video01Icon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { CloudflareSetup, daysLeftOf, ShareOptionsForm, shareOptionsFrom, useShareState, type ShareFormValue } from "@/main-window/share"
import type { EditorPreset, RecordingEditData, RecordingShare } from "@/types/bridge"

import { captionsFromTranscript, captionsVtt } from "./captions"
import {
  addZoom,
  clipAt,
  deleteClip,
  cutSourceRanges,
  editedDuration,
  restoreSourceRange,
  isUnedited,
  MIN_CLIP,
  newAnnotation,
  newId,
  newProject,
  plainProject,
  normalizeProject,
  placeClips,
  splitAt,
  styleOf,
  toEdited,
  type EditProject,
  type PointerSample,
} from "./model"
import { suggestZooms } from "./motion"
import { AnnotationPanel, LayoutPanel, AudioPanel, CaptionPanel, CaptionsPanel, Chips, ClipPanel, ClipsPanel, CursorPanel, ScenePanel, SettingsPanel, SoundPanel, WebcamPanel, ZoomPanel } from "./panels"
import { drawBackground, drawFrame, exportSpec, frameState, motionFor, visibleAnnotations, type Assets } from "./render"
import { croppedSource, layoutFor, outputSize, squirclePath, type Resolution } from "./scene"
import { Timeline, type Selection } from "./Timeline"
import { TranscriptPanel, type WordsState } from "./TranscriptPanel"
import { allWords, wordsSpan } from "./transcript"
import { useAnnotationImages, useBackground, useCursorSprites, useCustomFonts, useLevels, usePeaks } from "./useAssets"

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function clock(seconds: number, tenths = false) {
  const total = Math.max(0, seconds)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  return tenths ? `${minutes}:${rest.toFixed(1).padStart(4, "0")}` : `${minutes}:${String(Math.floor(rest)).padStart(2, "0")}`
}

/* History: undo and redo, with a drag counting as one step */

function useHistory(initial: EditProject) {
  const [project, setProject] = useState(initial)
  const past = useRef<EditProject[]>([])
  const future = useRef<EditProject[]>([])
  const dragStart = useRef<EditProject | null>(null)
  const [, bump] = useState(0)
  const change = useCallback((next: EditProject | ((current: EditProject) => EditProject), options: { live?: boolean } = {}) => {
    setProject((current) => {
      const value = typeof next === "function" ? next(current) : next
      if (value === current) return current
      if (options.live) {
        if (!dragStart.current) dragStart.current = current
      } else {
        past.current.push(dragStart.current || current)
        if (past.current.length > 100) past.current.shift()
        future.current = []
        dragStart.current = null
      }
      return value
    })
    bump((tick) => tick + 1)
  }, [])
  const endDrag = useCallback(() => {
    if (!dragStart.current) return
    past.current.push(dragStart.current)
    if (past.current.length > 100) past.current.shift()
    future.current = []
    dragStart.current = null
    bump((tick) => tick + 1)
  }, [])
  const undo = useCallback(() => {
    setProject((current) => {
      const previous = past.current.pop()
      if (!previous) return current
      future.current.push(current)
      return previous
    })
    bump((tick) => tick + 1)
  }, [])
  const redo = useCallback(() => {
    setProject((current) => {
      const next = future.current.pop()
      if (!next) return current
      past.current.push(current)
      return next
    })
    bump((tick) => tick + 1)
  }, [])
  return { project, change, endDrag, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 }
}

/* Shortcuts, which can be changed */

const SHORTCUT_ACTIONS = [
  { id: "addZoom", label: "Add zoom", key: "z" },
  { id: "split", label: "Split clip", key: "c" },
  { id: "addAnnotation", label: "Add annotation", key: "a" },
  { id: "addMarker", label: "Add marker", key: "f" },
  { id: "delete", label: "Delete selected", key: "mod+d" },
  { id: "play", label: "Play or pause", key: "space" },
] as const
type ShortcutId = (typeof SHORTCUT_ACTIONS)[number]["id"]
const FIXED = ["tab", "shift+tab", "backspace", "delete", "mod+z", "mod+shift+z", "mod+a", "arrowleft", "arrowright", "alt+arrowleft", "alt+arrowright", "[", "]"]
const DEFAULT_SHORTCUTS = Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action.id, action.key])) as Record<ShortcutId, string>

function loadShortcuts(): Record<ShortcutId, string> {
  try {
    return { ...DEFAULT_SHORTCUTS, ...JSON.parse(localStorage.getItem("ember.editor.shortcuts") || "{}") }
  } catch {
    return DEFAULT_SHORTCUTS
  }
}

function keyOf(event: KeyboardEvent | React.KeyboardEvent) {
  const key = event.key === " " ? "space" : event.key.toLowerCase()
  return [(event.metaKey || event.ctrlKey) && "mod", event.shiftKey && key !== "shift" && "shift", event.altKey && "alt", key].filter(Boolean).join("+")
}

const keyLabel = (key: string) =>
  key
    .split("+")
    .map((part) => ({ mod: "⌘", shift: "⇧", alt: "⌥", space: "Space", backspace: "⌫", delete: "⌦", tab: "Tab" })[part] || part.toUpperCase())
    .join("")

function ShortcutsDialog({ open, onOpenChange, shortcuts, onChange }: { open: boolean; onOpenChange: (open: boolean) => void; shortcuts: Record<ShortcutId, string>; onChange: (next: Record<ShortcutId, string>) => void }) {
  const [listening, setListening] = useState<ShortcutId | null>(null)
  const [conflict, setConflict] = useState<{ id: ShortcutId; key: string; with: ShortcutId } | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Click a shortcut, then press the keys you want.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {SHORTCUT_ACTIONS.map((action) => (
            <div key={action.id} className="flex items-center justify-between py-1 text-[13.5px]">
              {action.label}
              <button
                type="button"
                onClick={() => setListening(action.id)}
                onKeyDown={(event) => {
                  if (listening !== action.id) return
                  event.preventDefault()
                  if (event.key === "Escape") return setListening(null)
                  if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return
                  const key = keyOf(event)
                  if (FIXED.includes(key)) return
                  const used = (Object.keys(shortcuts) as ShortcutId[]).find((other) => other !== action.id && shortcuts[other] === key)
                  setListening(null)
                  if (used) return setConflict({ id: action.id, key, with: used })
                  onChange({ ...shortcuts, [action.id]: key })
                }}
                className={cn("min-w-20 rounded-md border px-2 py-1 font-mono text-[12.5px]", listening === action.id ? "border-ember text-ember" : "border-border")}
              >
                {listening === action.id ? "Press keys…" : keyLabel(shortcuts[action.id])}
              </button>
            </div>
          ))}
        </div>
        {conflict ? (
          <div className="flex items-center gap-2 rounded-lg border border-border p-2.5 text-[12.5px]">
            <span className="flex-1">
              {keyLabel(conflict.key)} is already used by {SHORTCUT_ACTIONS.find((action) => action.id === conflict.with)?.label}.
            </span>
            <Button
              size="sm"
              variant="pill"
              onClick={() => {
                onChange({ ...shortcuts, [conflict.id]: conflict.key, [conflict.with]: shortcuts[conflict.id] })
                setConflict(null)
              }}
            >
              Swap
            </Button>
          </div>
        ) : null}
        <p className="text-[11.5px] text-faint">Always: Tab cycles notes at the playhead, ⌫ deletes, ⌘Z undoes, ⌘A selects all zooms, ← → step a frame.</p>
        <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange(DEFAULT_SHORTCUTS)}>
          Reset to defaults
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/* Export */

type ExportSettings = {
  format: "mp4" | "gif"
  resolution: Resolution
  encoding: "fast" | "balanced" | "quality"
  fps: number
  gifFps: number
  gifSize: "medium" | "large" | "original"
  loop: boolean
  /** Save a file, or upload it as a share link. */
  destination: "file" | "share"
}

const DEFAULT_EXPORT: ExportSettings = { format: "mp4", resolution: "original", encoding: "balanced", fps: 30, gifFps: 15, gifSize: "medium", loop: true, destination: "file" }

function ExportDialog({
  open,
  onOpenChange,
  project,
  width,
  height,
  onExport,
  progress,
  onCancel,
  recordingId,
  share,
  title: recordingTitle,
  onRenamed,
}: {
  recordingId: string
  title: string
  onRenamed: (title: string) => void
  share: RecordingShare | null
  open: boolean
  onOpenChange: (open: boolean) => void
  project: EditProject
  width: number
  height: number
  onExport: (settings: ExportSettings) => void
  progress: { state: string; value: number; error?: string; path?: string; phase?: string } | null
  onCancel: () => void
}) {
  const [settings, setSettings] = useState<ExportSettings>(() => {
    try {
      return { ...DEFAULT_EXPORT, ...JSON.parse(localStorage.getItem("ember.editor.export") || "{}") }
    } catch {
      return DEFAULT_EXPORT
    }
  })
  const set = (changes: Partial<ExportSettings>) => {
    const next = { ...settings, ...changes }
    setSettings(next)
    localStorage.setItem("ember.editor.export", JSON.stringify(next))
  }
  const size = (resolution: Resolution) => outputSize(project.scene, width, height, resolution, project.layout)
  const original = size("original")
  const gifHeight = settings.gifSize === "original" ? original.height : settings.gifSize === "large" ? 1080 : 720
  const running = progress?.state === "running"
  const sharing = settings.destination === "share"

  /* Sharing: once the export is done, the edited video uploads to the link. */
  const { state: shareState, refresh: refreshShare } = useShareState()
  const [shareForm, setShareForm] = useState<ShareFormValue>({ expiresDays: 0, password: "", removePassword: false, download: false, transcript: true })
  const [upload, setUpload] = useState<{ state: string; value: number; url?: string; error?: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [title, setTitle] = useState(recordingTitle)
  const shareNext = useRef(false)
  useEffect(() => {
    if (!open) return
    void refreshShare()
    setUpload(null)
    setTitle(recordingTitle)
    setShareForm({ expiresDays: daysLeftOf(share?.expiresAt || null), password: "", removePassword: false, download: share?.download ?? false, transcript: share?.transcript ?? true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refreshShare, share?.expiresAt, share?.download, share?.transcript])
  useEffect(() => window.meetingRecorder.onRecordingShare((next) => next.id === recordingId && setUpload(next)), [recordingId])
  useEffect(() => {
    if (progress?.state !== "done" || !shareNext.current) return
    shareNext.current = false
    setUpload({ state: "uploading", value: 0 })
    void window.meetingRecorder.shareRecording(recordingId, { ...shareOptionsFrom(shareForm), version: "edited" }).then(
      (reply) => "error" in reply && reply.error && setUpload({ state: "failed", value: 0, error: reply.error }),
      (error) => setUpload({ state: "failed", value: 0, error: error instanceof Error ? error.message : String(error) }),
    )
  }, [progress?.state, recordingId, shareForm])
  const start = async () => {
    // The title typed here names the recording, and the share page.
    const next = title.trim()
    if (sharing && next && next !== recordingTitle) {
      await window.meetingRecorder.renameRecording(recordingId, next)
      onRenamed(next)
    }
    shareNext.current = sharing
    setUpload(null)
    onExport(sharing ? { ...settings, format: "mp4" } : settings)
  }
  const copyLink = async (url: string) => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const shareReady = Boolean(shareState?.ready)
  const linkUrl = upload?.url || share?.url || ""

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100vh-48px)] overflow-y-auto sm:max-w-[460px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>Made on this Mac. The original recording is kept.</DialogDescription>
        </DialogHeader>
        {running ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px]">
              {progress.phase || "Rendering"}…{sharing ? <span className="text-muted-foreground"> Then it uploads to your link.</span> : null}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[image:var(--ember-gradient)] transition-[width]" style={{ width: `${Math.round(progress.value * 100)}%` }} />
            </div>
            <div className="flex items-center justify-between text-[12.5px] text-muted-foreground">
              <span className="tabular">{Math.round(progress.value * 100)}%</span>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            </div>
            <p className="text-[11.5px] text-faint">You can keep using Ember while this runs.</p>
          </div>
        ) : progress?.state === "done" && upload ? (
          <div className="flex flex-col gap-3">
            {upload.state === "failed" ? (
              <div className="flex items-center gap-2 rounded-lg border border-rec/30 bg-rec/[0.06] p-2.5 text-[12.5px]">
                <span className="min-w-0 flex-1 text-rec">{upload.error || "The upload failed."}</span>
                <Button size="sm" variant="ghost" onClick={() => void start()}>
                  Try again
                </Button>
              </div>
            ) : (
              <>
                <div className={cn("flex items-center gap-2 rounded-xl border py-1.5 pr-1.5 pl-3", upload.state === "done" ? "border-ember/30 bg-ember/[0.06]" : "border-border bg-white/[0.02]")}>
                  {upload.state === "done" ? <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.8} className="size-4 shrink-0 text-ember" /> : null}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{linkUrl || "…"}</span>
                  {linkUrl ? (
                    <Button variant="pill" size="sm" className="h-8" onClick={() => void copyLink(linkUrl)}>
                      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={1.8} /> {copied ? "Copied" : "Copy"}
                    </Button>
                  ) : null}
                  {upload.state === "done" ? (
                    <Button variant="ghost" size="icon-sm" title="Open" aria-label="Open the link" onClick={() => void window.meetingRecorder.openRecordingShare(recordingId)}>
                      <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} />
                    </Button>
                  ) : null}
                </div>
                {upload.state === "done" ? (
                  <p className="text-[12.5px] text-muted-foreground">Shared. The link is on your clipboard.</p>
                ) : (
                  <>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-[image:var(--ember-gradient)] transition-[width]" style={{ width: `${Math.round(upload.value * 100)}%` }} />
                    </div>
                    <p className="flex justify-between gap-3 text-[12.5px] text-muted-foreground">
                      <span>Uploading. The link is copied and already works; the video shows when it's done.</span>
                      <span className="tabular">{Math.round(upload.value * 100)}%</span>
                    </p>
                  </>
                )}
              </>
            )}
            <div className="flex gap-2">
              {upload.state === "uploading" ? (
                <Button variant="ghost" onClick={() => void window.meetingRecorder.cancelRecordingShare(recordingId)}>
                  Cancel upload
                </Button>
              ) : null}
              <Button className="ml-auto rounded-full" onClick={() => onOpenChange(false)}>
                {upload.state === "uploading" ? "Hide" : "Close"}
              </Button>
            </div>
          </div>
        ) : progress?.state === "done" ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px]">Saved{progress.path ? ` to ${progress.path.replace(/^\/Users\/[^/]+/, "~")}` : ""}.</p>
            <div className="flex gap-2">
              {progress.path ? (
                <Button variant="pill" onClick={() => void window.meetingRecorder.showExportedFile(progress.path!)}>
                  Show in Finder
                </Button>
              ) : null}
              <Button variant="pill" onClick={() => void start()}>
                Save again
              </Button>
              <Button className="ml-auto rounded-full" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {progress?.state === "failed" ? (
              <div className="flex items-center gap-2 rounded-lg border border-rec/30 bg-rec/[0.06] p-2.5 text-[12.5px]">
                <span className="min-w-0 flex-1 text-rec">{progress.error}</span>
                <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(progress.error || "")}>
                  Copy error
                </Button>
              </div>
            ) : null}
            <Chips
              options={["file", "share"] as const}
              value={settings.destination}
              format={(destination) => (destination === "file" ? "Save a file" : "Share as a link")}
              onChange={(destination) => set({ destination })}
            />
            {sharing ? null : <Chips options={["mp4", "gif"] as const} value={settings.format} format={(format) => format.toUpperCase()} onChange={(format) => set({ format })} />}
            {sharing || settings.format === "mp4" ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px]">Quality</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(["low", "medium", "high", "original"] as const).map((resolution) => {
                      const dims = size(resolution)
                      return (
                        <button
                          key={resolution}
                          type="button"
                          onClick={() => set({ resolution })}
                          className={cn("flex flex-col items-start rounded-[10px] border px-3 py-2 text-left", settings.resolution === resolution ? "border-ember bg-ember/[0.08]" : "border-border hover:border-white/25")}
                        >
                          <span className="text-[13px] capitalize">{resolution}</span>
                          <span className="tabular text-[11.5px] text-faint">
                            {dims.width}×{dims.height}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px]">Encoding</span>
                  <Chips options={["fast", "balanced", "quality"] as const} value={settings.encoding} format={(id) => id[0].toUpperCase() + id.slice(1)} onChange={(encoding) => set({ encoding })} />
                  <p className="text-[11.5px] text-faint">Quality makes smaller files in HEVC; Fast and Balanced use H.264, which plays everywhere.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px]">Frame rate</span>
                  <Chips options={[24, 30, 60]} value={settings.fps} format={(fps) => `${fps} fps`} onChange={(fps) => set({ fps })} />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px]">Smoothness</span>
                  <Chips options={[15, 20, 25, 30]} value={settings.gifFps} format={(fps) => `${fps} fps`} onChange={(gifFps) => set({ gifFps })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px]">Size</span>
                  <Chips options={["medium", "large", "original"] as const} value={settings.gifSize} format={(id) => (id === "medium" ? "720p" : id === "large" ? "1080p" : "Original")} onChange={(gifSize) => set({ gifSize })} />
                  <span className="tabular text-[11.5px] text-faint">
                    {Math.round((gifHeight * original.width) / original.height)}×{gifHeight}
                  </span>
                </div>
                <label className="flex items-center justify-between text-[13px]">
                  Loop
                  <Switch checked={settings.loop} onCheckedChange={(loop) => set({ loop })} />
                </label>
              </>
            )}
            {sharing ? (
              shareState === null ? (
                <div className="flex justify-center py-2">
                  <Spinner />
                </div>
              ) : !shareReady ? (
                <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
                  <span className="text-[12.5px] text-muted-foreground">Links play from your own Cloudflare account. Set it up once.</span>
                  <CloudflareSetup state={shareState} onReady={() => void refreshShare()} compact />
                </div>
              ) : (
                <div className="flex flex-col gap-3 border-t border-border pt-4">
                  <ShareOptionsForm value={shareForm} onChange={setShareForm} hasPassword={Boolean(share?.hasPassword)} title={title} onTitleChange={setTitle} />
                  {share ? <p className="text-[12px] text-faint">Updates your existing link with this version: {share.url.replace(/^https:\/\//, "")}</p> : null}
                </div>
              )
            ) : null}
            <Button className="h-10 rounded-full" disabled={sharing && !shareReady} onClick={() => void start()}>
              <HugeiconsIcon icon={sharing ? Link01Icon : Download04Icon} strokeWidth={1.8} /> {sharing ? (share ? "Export and update link" : "Export and share") : `Export ${settings.format.toUpperCase()}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The recording's name, renamed in place. */
function TitleField({ id, initial, onRenamed }: { id: string; initial: string; onRenamed?: (title: string) => void }) {
  const [title, setTitle] = useState(initial)
  const [editing, setEditing] = useState(false)
  const save = async () => {
    setEditing(false)
    const next = title.trim()
    if (next && next !== initial) {
      await window.meetingRecorder.renameRecording(id, next)
      onRenamed?.(next)
    } else setTitle(initial)
  }
  return editing ? (
    <input
      autoFocus
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") void save()
        if (event.key === "Escape") {
          setTitle(initial)
          setEditing(false)
        }
      }}
      className="no-drag h-8 min-w-[280px] rounded-md bg-white/[0.06] px-2 text-[16px] font-semibold outline-none"
    />
  ) : (
    <button type="button" title="Rename" onClick={() => setEditing(true)} className="no-drag min-w-0 truncate text-left text-[16px] font-semibold tracking-[-0.015em] hover:text-white">
      {title}
    </button>
  )
}

/* The page */

const CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const

const queuedSeeks = new WeakMap<HTMLMediaElement, number>()

/** Seeks a video, but while it's still finding the last spot, only remembers the newest one: scrubbing stays smooth. */
function seekMedia(element: HTMLMediaElement, time: number, now = false) {
  if (now || !element.seeking) {
    queuedSeeks.delete(element)
    element.currentTime = time
    return
  }
  if (!queuedSeeks.has(element)) {
    element.addEventListener(
      "seeked",
      () => {
        const next = queuedSeeks.get(element)
        queuedSeeks.delete(element)
        if (next !== undefined) seekMedia(element, next)
      },
      { once: true },
    )
  }
  queuedSeeks.set(element, time)
}

export function EditorPage({ id, onClose, onExported, auto = false }: { id: string; onClose: () => void; onExported?: () => void; auto?: boolean }) {
  const [data, setData] = useState<RecordingEditData | null | undefined>(undefined)
  useEffect(() => {
    void window.meetingRecorder.loadRecordingEdit(id).then(setData, () => setData(null))
  }, [id])
  const initial = useMemo(() => {
    if (!data) return null
    // The finished version made after recording is always the plain one, whatever the editor holds.
    if (auto) return plainProject(data.duration, data.cameraLayout)
    const loaded = normalizeProject(data.project, data.duration)
    if (loaded) return loaded
    const project = newProject(data.duration, data.pointer, { camera: data.cameraLayout, defaults: data.defaults as Partial<EditProject> | null })
    // New recordings start with zooms on their clicks, unless that's turned off or it's a tall recording.
    if (data.autoZooms && data.pointer?.length && data.width / Math.max(1, data.height) >= 1.2) project.zooms = suggestZooms(project, data.pointer, data.duration)
    return project
  }, [data, auto])
  if (data === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (data === null || !initial) {
    if (auto) onClose()
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        This recording can't be edited.
        <Button variant="pill" onClick={onClose}>
          Back
        </Button>
      </div>
    )
  }
  return <Editor data={data} initial={initial} onClose={onClose} onExported={onExported} auto={auto} />
}

type Panel = "transcript" | "layout" | "scene" | "cursor" | "webcam" | "captions" | "sound" | "clips" | "settings"

const PANELS: { id: Panel; label: string; icon: typeof Image01Icon }[] = [
  { id: "transcript", label: "Text", icon: TextAlignLeftIcon },
  { id: "layout", label: "Layout", icon: LayoutTwoColumnIcon },
  { id: "scene", label: "Scene", icon: Image01Icon },
  { id: "cursor", label: "Cursor", icon: Cursor01Icon },
  { id: "webcam", label: "Webcam", icon: Video01Icon },
  { id: "captions", label: "Captions", icon: SubtitleIcon },
  { id: "sound", label: "Sound", icon: MusicNote01Icon },
  { id: "clips", label: "Clips", icon: Film01Icon },
  { id: "settings", label: "Settings", icon: Settings02Icon },
]

type ExportState = { state: string; value: number; error?: string; path?: string; phase?: string }

function Editor({ data, initial, onClose, onExported, auto = false }: { data: RecordingEditData; initial: EditProject; onClose: () => void; onExported?: () => void; auto?: boolean }) {
  const { project, change, endDrag, undo, redo, canUndo, canRedo } = useHistory(initial)
  const [selection, setSelection] = useState<Selection>(null)
  // The webcam bubble is picked on the preview: its resize dots stay showing.
  const [webcamActive, setWebcamActive] = useState(false)
  useEffect(() => {
    if (selection) setWebcamActive(false)
  }, [selection])
  const [panel, setPanel] = useState<Panel>("scene")
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [previewVolume, setPreviewVolume] = useState(() => Number(localStorage.getItem("ember.editor.volume") ?? 1))
  const [autoZooms, setAutoZooms] = useState(data.autoZooms)
  const [exporting, setExporting] = useState<ExportState | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  // The recording's name: renamed in the header, or while sharing from Export.
  const [title, setTitle] = useState(data.title)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [shortcuts, setShortcuts] = useState(loadShortcuts)
  const [presets, setPresets] = useState<EditorPreset[]>([])
  const [presetName, setPresetName] = useState<string | null>(null)
  const [wallpapers, setWallpapers] = useState<{ id: string; label: string; url: string; thumb: string }[]>([])
  const [transcript, setTranscript] = useState(data.transcript)
  const [redraw, setRedraw] = useState(0)

  const video = useRef<HTMLVideoElement>(null)
  const cameraVideo = useRef<HTMLVideoElement>(null)
  const systemAudio = useRef<HTMLAudioElement>(null)
  // Other recordings' videos, for clips added from them.
  const sourceVideos = useRef(new Map<string, HTMLVideoElement>())
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const projectRef = useRef(project)
  projectRef.current = project
  const timeRef = useRef(time)
  timeRef.current = time

  const samples = useMemo(() => (data.pointer || []) as PointerSample[], [data.pointer])
  const hasPointer = samples.length > 0
  const src = `ember-media://recording/${data.id}/video`
  const duration = data.duration

  /* The transcript's words, timed, for editing by text; and the sound's levels, for the waveform and silent cuts. */
  const levels = useLevels(src)
  const [wordsState, setWordsState] = useState<WordsState>({ status: "idle", words: [], timing: null, progress: 0, model: { available: false, installing: false } })
  const loadWords = useCallback(
    (force = false) => {
      setWordsState((current) => ({ ...current, status: "loading", progress: 0, error: undefined }))
      window.meetingRecorder.recordingWords(data.id, { force }).then(
        (result) => {
          setWordsState({ status: "ready", words: allWords(result.lines), timing: result.timing, progress: 1, model: result.model })
          if (result.lines.length) setTranscript(result.lines)
        },
        (error) => setWordsState((current) => ({ ...current, status: "error", error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error) })),
      )
    },
    [data.id],
  )
  useEffect(
    () => window.meetingRecorder.onRecordingWordsProgress((progress) => progress.id === data.id && setWordsState((current) => ({ ...current, progress: progress.value }))),
    [data.id],
  )
  // Downloading Parakeet: once it's on this Mac, the words are timed again, exactly.
  const installWordModel = useCallback(() => {
    void window.meetingRecorder.installWordModel()
    setWordsState((current) => ({ ...current, model: { ...current.model, installing: true } }))
    const timer = window.setInterval(() => {
      void window.meetingRecorder.recordingWordModel().then((model) => {
        if (!model.available) return
        window.clearInterval(timer)
        loadWords(true)
      })
    }, 4000)
  }, [loadWords])
  const wordsRef = useRef(wordsState.words)
  wordsRef.current = wordsState.words
  const levelsRef = useRef(levels)
  levelsRef.current = levels
  const videoWidth = data.width || 1920
  const videoHeight = data.height || 1080
  const total = editedDuration(project)
  const sprites = useCursorSprites()
  const background = useBackground(project)
  const images = useAnnotationImages(project, useCallback(() => setRedraw((tick) => tick + 1), []))
  const peaks = usePeaks(src)
  const customFonts = useCustomFonts(useCallback(() => setRedraw((tick) => tick + 1), []))
  const [audioPeaks, setAudioPeaks] = useState(new Map<string, number[]>())
  const [cameraAspect, setCameraAspect] = useState(16 / 9)
  // The camera: footage you added, or the one recorded with the screen.
  const cameraSrc = project.webcam.file || (data.hasCamera ? `ember-media://recording/${data.id}/camera` : null)
  const hasCamera = Boolean(cameraSrc)

  useEffect(() => {
    void window.meetingRecorder.editorWallpapers().then(setWallpapers)
    void window.meetingRecorder.editorPresets().then(setPresets)
  }, [])
  // The transcript, for captions, once it's ready.
  useEffect(() => {
    const load = () => void window.meetingRecorder.recordingGet(data.id).then((item) => item && setTranscript(item.transcript))
    load()
    return window.meetingRecorder.onRecordingsChanged(load)
  }, [data.id])
  // Waveforms of added audio.
  useEffect(() => {
    for (const block of project.audio) {
      if (audioPeaks.has(block.file)) continue
      void window.meetingRecorder.editorPeaks(block.file).then((result) => setAudioPeaks((current) => new Map(current).set(block.file, result)))
    }
  }, [project.audio, audioPeaks])

  // Saved a moment after each change; the look also becomes the starting look for new recordings.
  useEffect(() => {
    // The hidden finishing window only reads; your own editor keeps the edit.
    if (auto) return
    const timer = window.setTimeout(() => {
      void window.meetingRecorder.saveRecordingEdit(data.id, project)
      void window.meetingRecorder.editorSaveDefaults(styleOf(project))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [data.id, project, auto])

  const motion = useMemo(() => motionFor(project, samples), [project, samples])

  /* Preview */

  const size = useMemo(() => outputSize(project.scene, videoWidth, videoHeight, "original", project.layout), [project.scene, project.layout, videoWidth, videoHeight])
  const layout = useMemo(() => layoutFor(project.scene, size.width, size.height, videoWidth, videoHeight, project.layout), [project.scene, project.layout, size, videoWidth, videoHeight])
  const [fit, setFit] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const measure = () => {
      const scale = Math.max(0, Math.min((element.clientWidth - 40) / size.width, (element.clientHeight - 40) / size.height))
      setFit({ width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [size])

  // The background drawn once (it's still), so each frame only copies it.
  const backgroundCanvas = useMemo(() => {
    if (!layout.framed || project.scene.background.kind === "video" || !fit.width) return null
    const element = document.createElement("canvas")
    const ratio = window.devicePixelRatio || 1
    element.width = Math.round(fit.width * ratio)
    element.height = Math.round(fit.height * ratio)
    const context = element.getContext("2d")!
    context.scale(element.width / size.width, element.height / size.height)
    drawBackground(context, project, background, size.width, size.height)
    return element
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.framed, project.scene.background, project.scene.blur, background.backgroundImage, fit, size])

  const assets = useCallback(
    (): Assets => ({
      video: video.current!,
      sources: sourceVideos.current,
      camera: hasCamera ? cameraVideo.current : null,
      backgroundImage: background.backgroundImage,
      backgroundVideo: background.backgroundVideo,
      images,
    }),
    [hasCamera, background, images],
  )

  const draw = useCallback(
    (edited: number) => {
      const element = canvas.current
      if (!element || !video.current || !fit.width) return
      const ratio = window.devicePixelRatio || 1
      const pixelWidth = Math.round(fit.width * ratio)
      if (element.width !== pixelWidth) {
        element.width = pixelWidth
        element.height = Math.round(fit.height * ratio)
      }
      drawFrame(element.getContext("2d")!, projectRef.current, motion, edited, assets(), {
        scale: element.width / size.width,
        layout,
        videoWidth,
        videoHeight,
        cameraAspect,
        background: backgroundCanvas,
        sprites,
      })
    },
    [fit, motion, assets, size, layout, videoWidth, videoHeight, cameraAspect, backgroundCanvas, sprites],
  )

  /* Playback across clips: each plays from its start at its speed, then the next. */

  const playingClip = useRef(0)
  const playingRef = useRef(playing)
  playingRef.current = playing

  /** The video a clip plays from: this recording's, or another recording's (made when first needed). */
  const elementFor = useCallback((clip: EditProject["clips"][number]) => {
    if (!clip.source) return video.current
    let element = sourceVideos.current.get(clip.source.id)
    if (!element) {
      element = document.createElement("video")
      element.src = `ember-media://recording/${clip.source.id}/video`
      element.preload = "auto"
      element.playsInline = true
      element.addEventListener("seeked", () => !playingRef.current && setRedraw((tick) => tick + 1))
      element.addEventListener("loadeddata", () => setRedraw((tick) => tick + 1))
      sourceVideos.current.set(clip.source.id, element)
    }
    return element
  }, [])

  /** Puts a clip's video (and, for this recording's clips, the camera and system sound) at a moment. */
  const cueClip = useCallback(
    (placed: ReturnType<typeof clipAt>, source: number, play: boolean) => {
      const element = elementFor(placed.clip)
      for (const other of [video.current, ...sourceVideos.current.values()]) if (other && other !== element && !other.paused) other.pause()
      if (!element) return null
      seekMedia(element, source, play)
      element.playbackRate = placed.clip.speed
      element.muted = placed.clip.muted
      element.volume = clamp(previewVolume * projectRef.current.sound.volume * (projectRef.current.sound.normalize ? 1.35 : 1), 0, 1)
      for (const companion of [cameraVideo.current, systemAudio.current]) {
        if (!companion) continue
        if (placed.clip.source) {
          companion.pause()
          continue
        }
        seekMedia(companion, source, play)
        companion.playbackRate = placed.clip.speed
        if (companion === systemAudio.current) companion.muted = placed.clip.muted
        if (play) void companion.play().catch(() => {})
      }
      return element
    },
    [elementFor, previewVolume],
  )

  const seekTo = useCallback(
    (edited: number) => {
      const target = clamp(edited, 0, total)
      const placed = clipAt(projectRef.current, target)
      playingClip.current = placed.index
      setTime(target)
      cueClip(placed, placed.clip.start + (target - placed.from) * placed.clip.speed, false)
    },
    [total, cueClip],
  )

  const audioElements = useRef(new Map<string, HTMLAudioElement>())
  const syncAudio = useCallback(
    (edited: number, play: boolean) => {
      for (const block of projectRef.current.audio) {
        let element = audioElements.current.get(block.id)
        if (!element) {
          element = new Audio(block.file)
          audioElements.current.set(block.id, element)
        }
        element.volume = clamp(block.volume * previewVolume * (block.normalize ? 1.35 : 1), 0, 1)
        const offset = edited - block.start
        const inside = offset >= 0 && offset < block.duration
        const at = offset + (block.offset || 0)
        if (play && inside) {
          if (Math.abs(element.currentTime - at) > 0.25) element.currentTime = at
          if (element.paused) void element.play().catch(() => {})
        } else if (!element.paused) element.pause()
      }
    },
    [previewVolume],
  )

  useEffect(() => {
    if (!playing) return
    const first = placeClips(projectRef.current.clips)[playingClip.current]
    let element = first ? elementFor(first.clip) : video.current
    if (!element) return
    let handle = 0
    const stopAll = () => {
      for (const other of [video.current, cameraVideo.current, systemAudio.current, ...sourceVideos.current.values()]) other?.pause()
      setPlaying(false)
      syncAudio(total, false)
    }
    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      const placed = placeClips(projectRef.current.clips)
      const item = placed[playingClip.current] || placed[0]
      const media = metadata.mediaTime
      if (media >= item.clip.end - 0.02) {
        // On to the next clip, which may play from another video.
        const next = placed[item.index + 1]
        if (!next) return stopAll()
        playingClip.current = next.index
        const nextElement = cueClip(next, next.clip.start, true)
        if (!nextElement) return stopAll()
        element = nextElement
        void element.play().catch(() => {})
        handle = element.requestVideoFrameCallback(onFrame)
        return
      }
      const edited = item.from + Math.max(0, media - item.clip.start) / item.clip.speed
      if (!item.clip.source) {
        const camera = cameraVideo.current
        if (camera && Math.abs(camera.currentTime - media) > 0.15) camera.currentTime = media
        const system = systemAudio.current
        if (system && Math.abs(system.currentTime - media) > 0.12) system.currentTime = media
      }
      setTime(edited)
      draw(edited)
      syncAudio(edited, true)
      handle = element!.requestVideoFrameCallback(onFrame)
    }
    handle = element.requestVideoFrameCallback(onFrame)
    return () => element?.cancelVideoFrameCallback(handle)
  }, [playing, draw, total, syncAudio, cueClip, elementFor])

  useEffect(() => {
    if (!playing) draw(time)
  }, [playing, draw, time, project, redraw])

  useEffect(() => {
    localStorage.setItem("ember.editor.volume", String(previewVolume))
    if (video.current) video.current.volume = clamp(previewVolume * project.sound.volume * (project.sound.normalize ? 1.35 : 1), 0, 1)
    if (systemAudio.current) systemAudio.current.volume = clamp(previewVolume * project.sound.systemVolume, 0, 1)
  }, [previewVolume, project.sound])

  const togglePlay = useCallback(() => {
    if (playing) {
      for (const other of [video.current, cameraVideo.current, systemAudio.current, ...sourceVideos.current.values()]) other?.pause()
      syncAudio(timeRef.current, false)
      setPlaying(false)
      return
    }
    const start = timeRef.current >= total - 0.05 ? 0 : timeRef.current
    const placed = clipAt(projectRef.current, start)
    playingClip.current = placed.index
    const element = cueClip(placed, placed.clip.start + (start - placed.from) * placed.clip.speed, true)
    if (!element) return
    void element.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    )
  }, [playing, total, syncAudio, cueClip])

  const pauseAndSeek = useCallback(
    (edited: number) => {
      if (playing) togglePlay()
      seekTo(edited)
    },
    [playing, togglePlay, seekTo],
  )

  /* Editing */

  const addZoomHere = useCallback(() => {
    const result = addZoom(projectRef.current, timeRef.current)
    change(result.project)
    setSelection({ kind: "zoom", id: result.id })
  }, [change])
  const splitHere = useCallback(() => {
    change((current) => splitAt(current, timeRef.current))
    setSelection(null)
  }, [change])
  const addAnnotation = useCallback(
    (track = 0) => {
      const annotation = newAnnotation("text", Math.min(timeRef.current, Math.max(0, total - 1)), track)
      change((current) => ({ ...current, annotations: [...current.annotations, annotation] }))
      setSelection({ kind: "annotation", id: annotation.id })
    },
    [change, total],
  )
  const addAudio = useCallback(
    async (track = 0) => {
      const asset = await window.meetingRecorder.editorPick("audio")
      if (!asset) return
      const length = await new Promise<number>((resolve) => {
        const element = new Audio(asset.url)
        element.onloadedmetadata = () => resolve(element.duration || 10)
        element.onerror = () => resolve(10)
      })
      const block = {
        id: newId("s"),
        track,
        start: timeRef.current,
        duration: Math.min(length, Math.max(0.5, total - timeRef.current)),
        file: asset.url,
        name: asset.name.replace(/\.\w+$/, ""),
        volume: 1,
        normalize: false,
        offset: 0,
      }
      change((current) => ({ ...current, audio: [...current.audio, block] }))
      setSelection({ kind: "audio", id: block.id })
    },
    [change, total],
  )
  const addMarker = useCallback(() => change((current) => ({ ...current, markers: [...current.markers, { id: newId("m"), time: timeRef.current }] })), [change])
  const suggest = useCallback(
    () => change((current) => ({ ...current, zooms: [...current.zooms, ...suggestZooms(current, samples, duration)].sort((left, right) => left.start - right.start) })),
    [change, samples, duration],
  )
  const deleteSelection = useCallback(() => {
    const current = selection
    if (!current) return
    if (current.kind === "zoom") change((value) => ({ ...value, zooms: value.zooms.filter((zoom) => zoom.id !== current.id) }))
    else if (current.kind === "zooms") change((value) => ({ ...value, zooms: [] }))
    else if (current.kind === "annotation") change((value) => ({ ...value, annotations: value.annotations.filter((item) => item.id !== current.id) }))
    else if (current.kind === "audio") change((value) => ({ ...value, audio: value.audio.filter((item) => item.id !== current.id) }))
    else if (current.kind === "caption") change((value) => ({ ...value, captions: (value.captions || []).filter((item) => item.id !== current.id) }))
    else if (current.kind === "marker") change((value) => ({ ...value, markers: value.markers.filter((item) => item.id !== current.id) }))
    else if (current.kind === "clip") change((value) => deleteClip(value, current.index))
    else if (current.kind === "words") {
      // Cuts the words, or puts them back if they're all cut already.
      const words = wordsRef.current
      const first = Math.min(current.first, current.last)
      const last = Math.max(current.first, current.last)
      if (!words[first] || !words[last]) return
      const span = wordsSpan(words, first, last, levelsRef.current)
      const anyKept = words.slice(first, last + 1).some((word) => toEdited(projectRef.current, (word.start + word.end) / 2) !== null)
      change((value) => (anyKept ? cutSourceRanges(value, [span]) : restoreSourceRange(value, span)))
      return
    }
    setSelection(null)
  }, [change, selection])
  const generateCaptions = useCallback(() => {
    change((current) => ({ ...current, captions: captionsFromTranscript(transcript), captionStyle: { ...current.captionStyle, show: true } }))
  }, [change, transcript])
  const addCaption = useCallback(
    (edited: number) => {
      const placed = clipAt(projectRef.current, edited)
      const start = placed.clip.start + (edited - placed.from) * placed.clip.speed
      const caption = { id: newId("t"), start, end: Math.min(placed.clip.end, start + 2), text: "New caption", words: [] }
      change((current) => ({ ...current, captions: [...(current.captions || []), caption].sort((left, right) => left.start - right.start) }))
      setSelection({ kind: "caption", id: caption.id })
    },
    [change],
  )
  const skip = useCallback(
    (direction: 1 | -1) => {
      const marks = projectRef.current.markers.map((marker) => marker.time).sort((left, right) => left - right)
      const now = timeRef.current
      const target = direction > 0 ? marks.find((mark) => mark > now + 0.05) : [...marks].reverse().find((mark) => mark < now - 0.05)
      pauseAndSeek(target ?? now + direction * 5)
    },
    [pauseAndSeek],
  )

  // Keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [role=menu], [role=listbox], [role=dialog]")) return
      const key = keyOf(event)
      const run = (fn: () => void) => {
        event.preventDefault()
        fn()
      }
      if (key === "mod+z") return run(undo)
      if (key === "mod+shift+z" || key === "mod+y") return run(redo)
      if (key === "mod+a") return run(() => setSelection({ kind: "zooms" }))
      if (key === "backspace" || key === "delete") return run(deleteSelection)
      if (key === "alt+arrowleft" || key === "alt+arrowright") {
        // Word by word, through the words still in the video.
        return run(() => {
          const project = projectRef.current
          const starts = wordsRef.current.map((word) => toEdited(project, word.start)).filter((at): at is number => at !== null)
          const now = timeRef.current
          const target = key === "alt+arrowright" ? starts.find((at) => at > now + 0.02) : [...starts].reverse().find((at) => at < now - 0.02)
          if (target !== undefined) pauseAndSeek(target)
        })
      }
      if (key === "[" || key === "]") {
        // Cut to cut: the joins between clips.
        return run(() => {
          const joins = placeClips(projectRef.current.clips).map((item) => item.from).concat(editedDuration(projectRef.current))
          const now = timeRef.current
          const target = key === "]" ? joins.find((at) => at > now + 0.02) : [...joins].reverse().find((at) => at < now - 0.02)
          if (target !== undefined) pauseAndSeek(target)
        })
      }
      if (["arrowleft", "arrowright", "shift+arrowleft", "shift+arrowright"].includes(key)) {
        return run(() => pauseAndSeek(timeRef.current + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 1 / 30)))
      }
      if (key === "tab" || key === "shift+tab") {
        return run(() => {
          const here = visibleAnnotations(projectRef.current, timeRef.current)
          if (!here.length) return
          const index = selection?.kind === "annotation" ? here.findIndex((item) => item.id === selection.id) : -1
          const next = here[(index + (event.shiftKey ? -1 : 1) + here.length) % here.length]
          setSelection({ kind: "annotation", id: next.id })
        })
      }
      const action = (Object.keys(shortcuts) as ShortcutId[]).find((id) => shortcuts[id] === key)
      if (!action) return
      run(() => {
        if (action === "addZoom") addZoomHere()
        else if (action === "split") splitHere()
        else if (action === "addAnnotation") addAnnotation()
        else if (action === "addMarker") addMarker()
        else if (action === "delete") deleteSelection()
        else if (action === "play") togglePlay()
      })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo, deleteSelection, shortcuts, addZoomHere, splitHere, addAnnotation, addMarker, togglePlay, selection, pauseAndSeek])

  /* Dragging on the preview: notes, and a zoom's focus point */

  const previewScale = fit.width / Math.max(1, size.width)
  const dragOnPreview = (event: React.PointerEvent, apply: (dx: number, dy: number) => (current: EditProject) => EditProject) => {
    event.stopPropagation()
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const move = (pointer: PointerEvent) => change(apply((pointer.clientX - startX) / previewScale, (pointer.clientY - startY) / previewScale), { live: true })
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      endDrag()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  // The webcam bubble's box right now, so it can be dragged around the preview (not in split layouts).
  const webcamBox =
    hasCamera && project.webcam.show && !layout.camera && project.layout?.preset !== "screen"
      ? frameState(project, motion, time, layout, videoWidth, videoHeight, cameraAspect, true).webcam
      : null
  const selectedZoom = selection?.kind === "zoom" ? project.zooms.find((zoom) => zoom.id === selection.id) : null
  const crop = layout.fill || croppedSource(project.scene, videoWidth, videoHeight)
  const focusPoint =
    selectedZoom && (selectedZoom.mode === "manual" || !hasPointer)
      ? {
          x: (layout.content.x + ((selectedZoom.x * videoWidth - crop.x) / crop.w) * layout.content.w) * previewScale,
          y: (layout.content.y + ((selectedZoom.y * videoHeight - crop.y) / crop.h) * layout.content.h) * previewScale,
        }
      : null

  /* Export */

  useEffect(
    () =>
      window.meetingRecorder.onRecordingExport((progress) => {
        if (progress.id !== data.id) return
        if (progress.state === "running") setExporting({ state: "running", value: progress.value, phase: progress.value < 0.02 ? "Preparing" : progress.value > 0.97 ? "Finishing" : "Rendering" })
        else if (progress.state === "done") {
          setExporting({ state: "done", value: 1, path: progress.path })
          onExported?.()
        } else if (progress.state === "failed") setExporting({ state: "failed", value: 0, error: progress.error })
        else setExporting(null)
      }),
    [data.id, onExported],
  )
  const runExport = async (settings: ExportSettings) => {
    if (playing) togglePlay()
    setExporting({ state: "running", value: 0, phase: "Preparing" })
    try {
      if (!auto) await window.meetingRecorder.saveRecordingEdit(data.id, project)
      const spec = await exportSpec(project, samples, assets(), sprites, videoWidth, videoHeight, cameraAspect, {
        resolution: settings.resolution,
        fps: settings.fps,
        format: settings.format,
        gifFps: settings.gifFps,
        gifSize: settings.gifSize,
        loop: settings.loop,
        encoding: settings.encoding,
      })
      const captions = project.captionStyle.sidecar && project.captions?.length && settings.format === "mp4" ? captionsVtt(project.captions, (source) => toEdited(project, source)) : null
      const started = await window.meetingRecorder.exportRecordingEdit(data.id, spec, {
        backgroundVideo: project.scene.background.kind === "video" ? project.scene.background.value : null,
        captions,
        cameraFile: project.webcam.file,
        share: settings.destination === "share",
        auto,
      })
      if (!started) setExporting(null)
      if (!started && auto) onClose()
    } catch (error) {
      setExporting({ state: "failed", value: 0, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error) })
    }
  }

  // Finishing a new recording: once the video, camera and cursor pictures have loaded, plan the export once.
  const runExportRef = useRef(runExport)
  runExportRef.current = runExport
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!auto || autoStarted.current) return
    const began = Date.now()
    const timer = window.setInterval(() => {
      const screen = video.current
      const camera = cameraVideo.current
      const ready = screen && screen.readyState >= 2 && screen.videoWidth > 0 && (!hasCamera || (camera && camera.readyState >= 2))
      if (Date.now() - began > 45000) {
        window.clearInterval(timer)
        onClose()
        return
      }
      // A moment more for the cursor pictures and background.
      if (!ready || Date.now() - began < 2500 || autoStarted.current) return
      window.clearInterval(timer)
      autoStarted.current = true
      void runExportRef.current({ ...DEFAULT_EXPORT, format: "mp4", resolution: "original", encoding: "balanced", fps: 30, destination: "file" })
    }, 250)
    return () => window.clearInterval(timer)
  }, [auto, hasCamera, onClose])
  useEffect(() => {
    if (auto && exporting?.state === "failed") onClose()
  }, [auto, exporting?.state, onClose])

  const placedNow = clipAt(project, time)
  const sourceNow = placedNow.clip.start + (time - placedNow.from) * placedNow.clip.speed
  const canSplit = sourceNow - placedNow.clip.start >= MIN_CLIP && placedNow.clip.end - sourceNow >= MIN_CLIP

  const contextPanel =
    selection?.kind === "zoom" ? (
      <ZoomPanel project={project} change={change} id={selection.id} hasPointer={hasPointer} onDelete={deleteSelection} />
    ) : selection?.kind === "clip" ? (
      <ClipPanel
        project={project}
        change={change}
        index={selection.index}
        onSeparateAudio={() =>
          change((current) => {
            const placed = placeClips(current.clips)[selection.index]
            if (!placed || placed.clip.speed !== 1) return current
            const block = {
              id: newId("s"),
              track: Math.max(0, ...current.audio.map((item) => item.track + 1)),
              start: placed.from,
              duration: placed.to - placed.from,
              file: src,
              name: `Clip ${selection.index + 1} sound`,
              volume: 1,
              normalize: false,
              offset: placed.clip.start,
            }
            return { ...current, clips: current.clips.map((clip, index) => (index === selection.index ? { ...clip, muted: true } : clip)), audio: [...current.audio, block] }
          })
        }
      />
    ) : selection?.kind === "audio" ? (
      <AudioPanel project={project} change={change} id={selection.id} />
    ) : selection?.kind === "caption" ? (
      <CaptionPanel project={project} change={change} id={selection.id} playhead={sourceNow} />
    ) : selection?.kind === "annotation" ? (
      <AnnotationPanel project={project} change={change} id={selection.id} fonts={customFonts.fonts} onAddFont={customFonts.add} />
    ) : null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <video ref={video} src={src} preload="auto" className="hidden" onLoadedData={() => draw(timeRef.current)} onSeeked={() => !playing && draw(timeRef.current)} />
      {data.hasSystem ? <audio ref={systemAudio} src={`ember-media://recording/${data.id}/system`} preload="auto" className="hidden" /> : null}
      {cameraSrc ? (
        <video
          ref={cameraVideo}
          src={cameraSrc}
          preload="auto"
          muted
          className="hidden"
          onLoadedMetadata={(event) => setCameraAspect(event.currentTarget.videoWidth / Math.max(1, event.currentTarget.videoHeight))}
          onSeeked={() => !playing && draw(timeRef.current)}
        />
      ) : null}

      {/* Header */}
      <header className="drag flex shrink-0 items-center gap-3 border-b border-border px-6 pt-4 pb-3">
        <button type="button" onClick={onClose} className="no-drag flex items-center gap-1.5 text-[13.5px] text-muted-foreground hover:text-foreground">
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.8} className="size-4" /> Done
        </button>
        <div className="mx-2 h-5 w-px bg-border" />
        <TitleField key={title} id={data.id} initial={title} onRenamed={setTitle} />
        <div className="no-drag ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" title="Undo (⌘Z)" aria-label="Undo" disabled={!canUndo} onClick={undo}>
            <HugeiconsIcon icon={ArrowTurnBackwardIcon} strokeWidth={1.8} />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Redo (⇧⌘Z)" aria-label="Redo" disabled={!canRedo} onClick={redo}>
            <HugeiconsIcon icon={ArrowTurnForwardIcon} strokeWidth={1.8} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                Presets
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => setPresetName("")}>Save current look as…</DropdownMenuItem>
              {presets.length ? <DropdownMenuSeparator /> : null}
              {presets.length ? <DropdownMenuLabel>Apply</DropdownMenuLabel> : null}
              {presets.map((preset) => (
                <DropdownMenuItem
                  key={preset.id}
                  onSelect={() =>
                    change((current) => {
                      const applied = normalizeProject({ ...current, ...preset.style, version: 2 }, duration)
                      return applied ? { ...applied, clips: current.clips, zooms: current.zooms, annotations: current.annotations, audio: current.audio, captions: current.captions, markers: current.markers } : current
                    })
                  }
                >
                  <span className="flex-1 truncate">{preset.name}</span>
                  <button
                    type="button"
                    className="text-[11px] text-faint hover:text-rec"
                    onClick={(event) => {
                      event.stopPropagation()
                      void window.meetingRecorder.editorDeletePreset(preset.id).then(setPresets)
                    }}
                  >
                    Delete
                  </button>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="tabular mx-2 text-[13px] text-muted-foreground">{clock(total)} long</span>
          <Button className="h-9 rounded-full px-4" disabled={isUnedited(project, duration) && !hasCamera} onClick={() => setExportOpen(true)}>
            <HugeiconsIcon icon={Download04Icon} strokeWidth={1.8} /> Export
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Panel picker */}
        <nav className="flex w-[64px] shrink-0 flex-col items-center gap-1 border-r border-border py-3">
          {PANELS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setPanel(item.id)
                setSelection(null)
              }}
              className={cn(
                "flex w-[54px] flex-col items-center gap-1 rounded-[10px] py-2 text-[10.5px]",
                panel === item.id && !contextPanel ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <HugeiconsIcon icon={item.icon} strokeWidth={1.6} className="size-[19px]" />
              {item.label}
            </button>
          ))}
        </nav>

        {/* Preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={stage} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
            <div className="relative" style={{ width: fit.width, height: fit.height }}>
              <canvas
                ref={canvas}
                onDoubleClick={togglePlay}
                onPointerDown={() => {
                  setSelection(null)
                  setWebcamActive(false)
                }}
                style={{ width: fit.width, height: fit.height }}
                className="rounded-[6px] shadow-[0_20px_60px_rgb(0_0_0/0.45)]"
              />
              {webcamBox ? (
                <div
                  title="Drag to move the webcam"
                  onPointerDown={(event) => {
                    const box = webcamBox
                    setPanel("webcam")
                    setWebcamActive(true)
                    dragOnPreview(event, (dx, dy) => (current) => ({
                      ...current,
                      webcam: {
                        ...current.webcam,
                        position: "custom",
                        x: clamp(box.x + box.w / 2 + dx, box.w / 2, size.width - box.w / 2) / size.width,
                        y: clamp(box.y + box.h / 2 + dy, box.h / 2, size.height - box.h / 2) / size.height,
                      },
                    }))
                  }}
                  className="group/cam absolute cursor-move"
                  style={{
                    left: webcamBox.x * previewScale,
                    top: webcamBox.y * previewScale,
                    width: webcamBox.w * previewScale,
                    height: webcamBox.h * previewScale,
                  }}
                >
                  {/* The outline follows the bubble's own squircle corners. */}
                  <svg
                    className={cn("pointer-events-none absolute inset-0 size-full overflow-visible text-ember transition-opacity", webcamActive ? "opacity-100" : "opacity-0 group-hover/cam:opacity-70")}
                    aria-hidden
                  >
                    <path
                      d={squirclePath(0.75, 0.75, webcamBox.w * previewScale - 1.5, webcamBox.h * previewScale - 1.5, webcamBox.radius * previewScale)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    />
                  </svg>
                  {CORNERS.map(([sx, sy]) => {
                    // Where the rounded corner's curve sits, so the roundness handle rides along it.
                    const inset = Math.max(10, webcamBox.radius * previewScale * (1 - Math.pow(Math.SQRT1_2, 0.4)))
                    const side = (value: number, far: boolean) => (far ? { right: value } : { left: value })
                    const across = (value: number, far: boolean) => (far ? { bottom: value } : { top: value })
                    return (
                      <Fragment key={`${sx}${sy}`}>
                        {/* Outside the corner: drag to resize, the opposite corner stays put. */}
                        <span
                          title="Drag to resize"
                          onPointerDown={(event) => {
                            const box = webcamBox
                            const start = project.webcam
                            setWebcamActive(true)
                            dragOnPreview(event, (dx, dy) => (current) => {
                              const unit = Math.min(size.width, size.height)
                              const wanted = 1 + (sx * dx + sy * dy) / (box.w + box.h)
                              const fixed = start.width && start.height
                              const scaleBy = fixed
                                ? clamp(wanted, 0.05 / Math.min(start.width!, start.height!), Math.min(size.width / unit / start.width!, size.height / unit / start.height!))
                                : clamp(start.size * wanted, 0.1, 1) / start.size
                              const w = box.w * scaleBy
                              const h = box.h * scaleBy
                              const anchorX = sx > 0 ? box.x : box.x + box.w
                              const anchorY = sy > 0 ? box.y : box.y + box.h
                              return {
                                ...current,
                                webcam: {
                                  ...current.webcam,
                                  ...(fixed ? { width: start.width! * scaleBy, height: start.height! * scaleBy, size: clamp(start.size * scaleBy, 0.1, 1) } : { size: start.size * scaleBy }),
                                  position: "custom",
                                  x: clamp(anchorX + (sx * w) / 2, w / 2, size.width - w / 2) / size.width,
                                  y: clamp(anchorY + (sy * h) / 2, h / 2, size.height - h / 2) / size.height,
                                },
                              }
                            })
                          }}
                          className={cn(
                            "absolute size-3 rounded-full border-2 border-white bg-ember shadow-md transition-opacity",
                            sx === sy ? "cursor-nwse-resize" : "cursor-nesw-resize",
                            webcamActive ? "opacity-100" : "opacity-0 group-hover/cam:opacity-100",
                          )}
                          style={{ ...side(-14, sx > 0), ...across(-14, sy > 0) }}
                        />
                        {/* Inside the corner: drag in for rounder, out for squarer. */}
                        <span
                          title="Drag to round the corners"
                          onPointerDown={(event) => {
                            const box = webcamBox
                            const start = project.webcam.roundness
                            setWebcamActive(true)
                            dragOnPreview(event, (dx, dy) => (current) => ({
                              ...current,
                              webcam: {
                                ...current.webcam,
                                // Keep the bubble's shape: a circle squared off stays a square, not the camera's own shape.
                                ...(project.webcam.width && project.webcam.height ? {} : { width: project.webcam.size * 0.5, height: project.webcam.size * 0.5 }),
                                roundness: Math.round(clamp(start + ((-sx * dx - sy * dy) / 2 / (Math.min(box.w, box.h) / 2)) * 100, 0, 100)),
                              },
                            }))
                          }}
                          className="absolute flex size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center [&:hover>span]:opacity-100 [&:active>span]:opacity-100"
                          style={{ left: sx > 0 ? `calc(100% - ${inset}px)` : inset, top: sy > 0 ? `calc(100% - ${inset}px)` : inset }}
                        >
                          <span className="size-3.5 rounded-full border-2 border-ember bg-ember/25 opacity-0 shadow-md transition-opacity" />
                        </span>
                      </Fragment>
                    )
                  })}
                </div>
              ) : null}
              {/* Notes showing now: click to select, drag to move, corner to resize */}
              {visibleAnnotations(project, time).map((annotation) => {
                const selected = selection?.kind === "annotation" && selection.id === annotation.id
                return (
                  <div
                    key={annotation.id}
                    onPointerDown={(event) => {
                      setSelection({ kind: "annotation", id: annotation.id })
                      dragOnPreview(event, (dx, dy) => (current) => ({
                        ...current,
                        annotations: current.annotations.map((item) => (item.id === annotation.id ? { ...item, x: annotation.x + dx / size.width, y: annotation.y + dy / size.height } : item)),
                      }))
                    }}
                    className={cn("absolute cursor-move rounded-[3px]", selected ? "outline-2 outline-ember outline-dashed" : "hover:outline hover:outline-1 hover:outline-white/40")}
                    style={{ left: annotation.x * fit.width, top: annotation.y * fit.height, width: annotation.w * fit.width, height: annotation.h * fit.height }}
                  >
                    {selected ? (
                      <span
                        onPointerDown={(event) =>
                          dragOnPreview(event, (dx, dy) => (current) => ({
                            ...current,
                            annotations: current.annotations.map((item) =>
                              item.id === annotation.id ? { ...item, w: Math.max(0.02, annotation.w + dx / size.width), h: Math.max(0.02, annotation.h + dy / size.height) } : item,
                            ),
                          }))
                        }
                        className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-full border-2 border-white bg-ember"
                      />
                    ) : null}
                  </div>
                )
              })}
              {focusPoint && selectedZoom ? (
                <span
                  title="Drag to choose where this zoom looks"
                  onPointerDown={(event) => {
                    const startX = selectedZoom.x
                    const startY = selectedZoom.y
                    dragOnPreview(event, (dx, dy) => (current) => ({
                      ...current,
                      zooms: current.zooms.map((zoom) =>
                        zoom.id === selectedZoom.id
                          ? {
                              ...zoom,
                              mode: "manual",
                              x: clamp(startX + ((dx / layout.content.w) * crop.w) / videoWidth, 0, 1),
                              y: clamp(startY + ((dy / layout.content.h) * crop.h) / videoHeight, 0, 1),
                              suggested: false,
                            }
                          : zoom,
                      ),
                    }))
                  }}
                  className="absolute size-7 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-white bg-ember/40 shadow-lg"
                  style={{ left: focusPoint.x, top: focusPoint.y }}
                />
              ) : null}
            </div>
          </div>
          {/* Transport */}
          <div className="flex shrink-0 items-center gap-2 px-6 pb-2">
            <Button variant="ghost" size="icon-sm" title="Back to the last marker, or 5 s" aria-label="Back" onClick={() => skip(-1)}>
              <HugeiconsIcon icon={PreviousIcon} strokeWidth={1.8} />
            </Button>
            <Button variant="secondary" size="icon" className="rounded-full" aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)" onClick={togglePlay}>
              <HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} strokeWidth={1.8} />
            </Button>
            <Button variant="ghost" size="icon-sm" title="On to the next marker, or 5 s" aria-label="Forward" onClick={() => skip(1)}>
              <HugeiconsIcon icon={NextIcon} strokeWidth={1.8} />
            </Button>
            <span className="tabular ml-1 text-[13px] text-muted-foreground">
              {clock(time, true)} <span className="text-faint">/ {clock(total, true)}</span>
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="ml-auto" title="Preview volume" aria-label="Preview volume">
                  <HugeiconsIcon icon={VolumeHighIcon} strokeWidth={1.8} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 p-3">
                <div className="flex items-center gap-2">
                  <input type="range" min={0} max={1} step={0.01} value={previewVolume} onChange={(event) => setPreviewVolume(Number(event.target.value))} className="flex-1 accent-[var(--ember)]" />
                  <button type="button" className="text-[11.5px] text-faint" onClick={() => setPreviewVolume(previewVolume ? 0 : 1)}>
                    {previewVolume ? "Mute" : "Unmute"}
                  </button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Panel */}
        <aside className="flex w-[318px] shrink-0 flex-col overflow-y-auto border-l border-border">
          {contextPanel || (
            <>
              {panel === "transcript" ? (
                <TranscriptPanel
                  project={project}
                  change={change}
                  state={wordsState}
                  levels={levels}
                  time={time}
                  selection={selection}
                  onSelect={setSelection}
                  onSeek={pauseAndSeek}
                  onLoad={() => loadWords()}
                  onRetime={() => loadWords(true)}
                  onInstallModel={installWordModel}
                  onCutSelection={deleteSelection}
                  duration={duration}
                />
              ) : null}
              {panel === "layout" ? <LayoutPanel project={project} change={change} hasCamera={hasCamera} /> : null}
              {panel === "scene" ? <ScenePanel project={project} change={change} wallpapers={wallpapers} hasCamera={data.hasCamera} /> : null}
              {panel === "cursor" ? <CursorPanel project={project} change={change} hasPointer={hasPointer} cursorHidden={data.cursorHidden} /> : null}
              {panel === "webcam" ? <WebcamPanel project={project} change={change} hasCamera={hasCamera} recorded={data.hasCamera} /> : null}
              {panel === "captions" ? <CaptionsPanel project={project} change={change} transcriptReady={transcript.length > 0} onGenerate={generateCaptions} /> : null}
              {panel === "sound" ? <SoundPanel project={project} change={change} hasSystem={data.hasSystem} /> : null}
              {panel === "clips" ? <ClipsPanel project={project} change={change} currentId={data.id} /> : null}
              {panel === "settings" ? (
                <SettingsPanel
                  project={project}
                  change={change}
                  previewVolume={previewVolume}
                  onPreviewVolume={setPreviewVolume}
                  autoZooms={autoZooms}
                  onAutoZooms={(value) => {
                    setAutoZooms(value)
                    void window.meetingRecorder.editorSetAutoZooms(value)
                  }}
                  onShortcuts={() => setShortcutsOpen(true)}
                />
              ) : null}
            </>
          )}
        </aside>
      </div>

      <Timeline
        project={project}
        src={src}
        duration={duration}
        total={total}
        time={time}
        peaks={peaks}
        levels={levels}
        words={wordsState.words}
        audioPeaks={audioPeaks}
        selection={selection}
        onSelect={setSelection}
        onSeek={pauseAndSeek}
        change={change}
        endDrag={endDrag}
        onAddZoom={addZoomHere}
        onSuggest={suggest}
        onSplit={splitHere}
        onAddAnnotation={addAnnotation}
        onAddAudio={(track) => void addAudio(track)}
        onAddCaption={addCaption}
        canSplit={canSplit}
        hasPointer={hasPointer}
      />

      <ExportDialog
        open={exportOpen}
        onOpenChange={(open) => {
          setExportOpen(open)
          if (!open && exporting?.state !== "running") setExporting(null)
        }}
        project={project}
        width={videoWidth}
        height={videoHeight}
        onExport={(settings) => void runExport(settings)}
        progress={exporting}
        onCancel={() => void window.meetingRecorder.cancelRecordingExport(data.id)}
        recordingId={data.id}
        share={data.share || null}
        title={title}
        onRenamed={setTitle}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        shortcuts={shortcuts}
        onChange={(next) => {
          setShortcuts(next)
          localStorage.setItem("ember.editor.shortcuts", JSON.stringify(next))
        }}
      />
      <Dialog open={presetName !== null} onOpenChange={(open) => !open && setPresetName(null)}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Save this look</DialogTitle>
            <DialogDescription>Background, frame, cursor, webcam, captions and motion, to use on other recordings.</DialogDescription>
          </DialogHeader>
          <Input autoFocus placeholder="Preset name" value={presetName || ""} onChange={(event) => setPresetName(event.target.value)} />
          <Button
            className="rounded-full"
            disabled={!presetName?.trim()}
            onClick={async () => {
              setPresets(await window.meetingRecorder.editorSavePreset(presetName || "", styleOf(project)))
              setPresetName(null)
            }}
          >
            Save preset
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
