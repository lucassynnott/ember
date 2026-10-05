import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BarcodeIcon,
  Bookmark02Icon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  File01Icon,
  FilterIcon,
  GridViewIcon,
  Idea01Icon,
  Image01Icon,
  Link01Icon,
  Menu01Icon,
  PinIcon,
  PinOffIcon,
  QrCodeIcon,
  Search01Icon,
  TextSelectionIcon,
  Tick02Icon,
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"
import type { ClipboardEntry, ClipboardKind } from "@/types/bridge"

import { Page, PageHeader } from "./page"

export const CLIPBOARD_FILTERS = [
  { id: "", label: "All" },
  { id: "text", label: "Text" },
  { id: "link", label: "Links" },
  { id: "image", label: "Images" },
  { id: "file", label: "Files" },
  { id: "pinned", label: "Pinned" },
] as const

const KIND_ICONS: Partial<Record<ClipboardKind, typeof Link01Icon>> = {
  link: Link01Icon,
  image: Image01Icon,
  file: File01Icon,
  qr: QrCodeIcon,
  barcode: BarcodeIcon,
}

export function kindIcon(kind: ClipboardKind) {
  return KIND_ICONS[kind] || null
}

export function relativeTime(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "Yesterday" : `${days} days ago`
}

/** One item's contents: the image, a link, a file path or the text. */
export function ClipboardContent({ entry, lines = 4, className }: { entry: ClipboardEntry; lines?: number; className?: string }) {
  if (entry.kind === "image") {
    return entry.thumbnail ? (
      <img src={entry.thumbnail} alt={entry.text || "Copied image"} className={cn("max-h-[180px] max-w-full rounded-md border border-border object-contain", className)} />
    ) : (
      <p className="text-[13px] text-faint">Image no longer available</p>
    )
  }
  return (
    <p
      className={cn(
        "text-[13.5px] leading-[1.5] break-words whitespace-pre-wrap",
        entry.kind === "link" ? "text-gold" : entry.kind === "file" ? "font-mono text-[12.5px] text-foreground/85" : "text-foreground/90",
        className,
      )}
      style={{ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      data-selectable
    >
      {entry.text}
    </p>
  )
}

const KIND_LABELS: Record<ClipboardKind, string> = { text: "Text", link: "Link", image: "Image", file: "File", qr: "QR code", barcode: "Barcode" }

function hostOf(url: string) {
  try {
    return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function sourceLabel(entry: ClipboardEntry) {
  return entry.source === "screen" ? "From screen" : entry.app || "Copied"
}

/** A card in the grid, Eden's Library style: who it came from, the content, then actions. */
function ClipboardCard({ entry, copied, onCopy }: { entry: ClipboardEntry; copied: boolean; onCopy: () => void }) {
  const icon = kindIcon(entry.kind)
  const [saved, setSaved] = useState(false)
  const fileName = entry.kind === "file" ? entry.text.split("/").filter(Boolean).pop() || entry.text : ""
  return (
    <div className="mb-5">
      <article
        className={cn(
          "group flex flex-col gap-3.5 rounded-2xl border bg-panel p-4 transition-colors hover:border-white/[0.16]",
          entry.pinned ? "border-gold/35" : "border-border",
        )}
      >
        <header className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-tile text-[13px] font-semibold text-foreground/85"
          >
            {entry.source === "screen" ? <HugeiconsIcon icon={TextSelectionIcon} strokeWidth={1.8} className="size-4" /> : (entry.app || "?")[0].toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14.5px] font-semibold text-foreground">{sourceLabel(entry)}</span>
            <span className="text-[12.5px] text-faint">{relativeTime(entry.at)}</span>
          </span>
          <Button
            variant="pill"
            size="icon-sm"
            aria-label={entry.pinned ? "Unpin" : "Pin"}
            className={cn("size-9 shrink-0", entry.pinned ? "border-gold/40 text-gold" : "text-muted-foreground opacity-0 group-hover:opacity-100")}
            onClick={() => void window.meetingRecorder.clipboardPin(entry.id, !entry.pinned)}
          >
            <HugeiconsIcon icon={PinIcon} strokeWidth={1.8} className="size-4" />
          </Button>
        </header>

        {entry.kind === "image" ? (
          entry.thumbnail ? (
            <img src={entry.thumbnail} alt={entry.text || "Copied image"} className="w-full rounded-xl border border-border object-cover" />
          ) : (
            <p className="text-[14px] text-faint">Image no longer available</p>
          )
        ) : entry.kind === "link" ? (
          <div className="flex flex-col gap-1 rounded-xl border border-border bg-white/[0.02] px-3.5 py-3">
            <span className="text-[14px] font-semibold text-foreground">{hostOf(entry.text)}</span>
            <span className="text-[13px] break-all text-gold" data-selectable>
              {entry.text}
            </span>
          </div>
        ) : entry.kind === "file" ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-white/[0.02] px-3.5 py-3">
            <HugeiconsIcon icon={File01Icon} strokeWidth={1.7} className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-semibold text-foreground">{fileName}</span>
              <span className="block truncate font-mono text-[11.5px] text-faint" data-selectable>
                {entry.text}
              </span>
            </span>
          </div>
        ) : (
          <p
            className="text-[15px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/90"
            style={{ display: "-webkit-box", WebkitLineClamp: 12, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            data-selectable
          >
            {entry.text}
          </p>
        )}

        <footer className="flex items-center gap-1 text-[13px] text-muted-foreground">
          <Button variant="ghost" size="sm" className="-ml-2 h-7 gap-1.5 px-2 text-muted-foreground" onClick={onCopy}>
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={1.8} className={cn("size-4", copied && "text-gold")} />
            {copied ? "Copied" : "Copy"}
          </Button>
          {entry.kind === "link" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-muted-foreground"
              onClick={async () => {
                await window.meetingRecorder.saveLink(entry.text).catch(() => null)
                setSaved(true)
              }}
            >
              <HugeiconsIcon icon={saved ? Tick02Icon : Bookmark02Icon} strokeWidth={1.8} className={cn("size-4", saved && "text-gold")} />
              {saved ? "Saved" : "Save"}
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" aria-label="Delete" className="size-7 text-muted-foreground" onClick={() => void window.meetingRecorder.clipboardRemove(entry.id)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} className="size-4" />
          </Button>
          {icon ? <HugeiconsIcon icon={icon} strokeWidth={1.8} className="ml-auto size-[18px] text-foreground/70" /> : null}
        </footer>
      </article>
      <p className="mt-2 truncate px-1 text-[12.5px] text-faint">
        {[sourceLabel(entry), relativeTime(entry.at), entry.kind === "image" && entry.width ? `${entry.width} × ${entry.height}` : KIND_LABELS[entry.kind]].join("  •  ")}
      </p>
    </div>
  )
}

/** A compact row, for the list view. */
function ClipboardRow({ entry, copied, onCopy }: { entry: ClipboardEntry; copied: boolean; onCopy: () => void }) {
  const icon = kindIcon(entry.kind)
  return (
    <article className={cn("group flex items-start gap-4 rounded-2xl border bg-panel px-4 py-3", entry.pinned ? "border-gold/35" : "border-border")}>
      <div className="flex w-[110px] shrink-0 flex-col gap-1 pt-0.5">
        <span className="tabular text-[12.5px] text-muted-foreground">{relativeTime(entry.at)}</span>
        <span className="flex items-center gap-1 truncate text-[12px] text-faint">
          {icon ? <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-3 shrink-0" /> : null}
          <span className="truncate">{sourceLabel(entry)}</span>
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <ClipboardContent entry={entry} lines={3} />
      </div>
      <div className="flex shrink-0 items-start gap-1 opacity-60 transition-opacity group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={entry.pinned ? "Unpin" : "Pin"}
          className={entry.pinned ? "text-gold" : "text-muted-foreground"}
          onClick={() => void window.meetingRecorder.clipboardPin(entry.id, !entry.pinned)}
        >
          <HugeiconsIcon icon={entry.pinned ? PinOffIcon : PinIcon} strokeWidth={1.8} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Copy" onClick={onCopy}>
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={1.8} className={copied ? "text-gold" : ""} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Delete" className="text-muted-foreground" onClick={() => void window.meetingRecorder.clipboardRemove(entry.id)}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
        </Button>
      </div>
    </article>
  )
}

// Columns filled left to right, newest first, so the grid reads in order (CSS columns fill top to bottom).
export function Masonry<T>({ items, render, minWidth = 280 }: { items: T[]; render: (item: T) => React.ReactNode; minWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(3)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setCount(Math.max(1, Math.floor((element.clientWidth + 16) / (minWidth + 16))))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [minWidth])
  const columns = Array.from({ length: count }, (_, column) => items.filter((_, index) => index % count === column))
  return (
    <div ref={ref} className="flex items-start gap-4">
      {columns.map((column, index) => (
        <div key={index} className="flex min-w-0 flex-1 flex-col">
          {column.map(render)}
        </div>
      ))}
    </div>
  )
}

const BANNER_KEY = "clipboard-banner-dismissed"
const VIEW_KEY = "clipboard-view"

function stored(key: string) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Only a convenience.
  }
}

/** Everything you've copied, plus text grabbed from the screen, laid out like Eden's Library. */
export function ClipboardPage({ enabled, shortcut, grabShortcut }: { enabled: boolean; shortcut?: string; grabShortcut?: string }) {
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState("")
  const [fromScreen, setFromScreen] = useState(false)
  const [view, setView] = useState<"grid" | "list">(() => (stored(VIEW_KEY) === "list" ? "list" : "grid"))
  const [banner, setBanner] = useState(() => stored(BANNER_KEY) !== "1")
  const [entries, setEntries] = useState<ClipboardEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = useCallback(async (search: string, filter: string) => {
    const result = await window.meetingRecorder.clipboardList(search, filter).catch(() => ({ entries: [], total: 0 }))
    setEntries(result.entries)
    setTotal(result.total)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query, kind), 120)
    return () => window.clearTimeout(timer)
  }, [query, kind, load])
  useEffect(() => window.meetingRecorder.onClipboardChanged(() => void load(query, kind)), [query, kind, load])

  const shown = useMemo(() => (entries || []).filter((entry) => !fromScreen || entry.source === "screen"), [entries, fromScreen])
  const pinnedCount = useMemo(() => (entries || []).filter((entry) => entry.pinned).length, [entries])
  const kindLabel = CLIPBOARD_FILTERS.find((filter) => filter.id === kind && filter.id !== "pinned")?.label

  const copy = async (entry: ClipboardEntry) => {
    await window.meetingRecorder.clipboardCopy(entry.id)
    setCopied(entry.id)
    window.setTimeout(() => setCopied((current) => (current === entry.id ? null : current)), 1400)
  }
  const switchView = (next: "grid" | "list") => {
    setView(next)
    store(VIEW_KEY, next)
  }

  return (
    <Page>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Clipboard"
          subtitle="Everything you've copied, searchable in one place."
          actions={
            <>
              {total ? (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirmClear(true)}>
                  Clear
                </Button>
              ) : null}
              <Button variant="pill" className="h-10 px-4 text-[14px]" onClick={() => void window.meetingRecorder.grabText(false)}>
                <HugeiconsIcon icon={TextSelectionIcon} strokeWidth={1.8} data-icon="inline-start" />
                Grab text
                {grabShortcut ? <span className="text-faint">{grabShortcut}</span> : null}
              </Button>
            </>
          }
        />

        <label className="flex h-[54px] items-center gap-3 rounded-full border border-border bg-white/[0.025] px-5 transition-colors focus-within:border-white/20">
          <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} className="size-[18px] shrink-0 text-muted-foreground" />
          <input
            value={query}
            placeholder="Search text, links, images and files you've copied"
            aria-label="Search clipboard history"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <Button variant="ghost" size="icon-sm" aria-label="Clear search" className="rounded-full text-muted-foreground" onClick={() => setQuery("")}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          ) : shortcut ? (
            <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-faint">
              <Kbd>{shortcut}</Kbd> in any app
            </span>
          ) : null}
        </label>

        <div className="-mt-1 flex items-center gap-1 text-[14px]">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className={cn("gap-1.5 px-2.5 text-[14px]", kindLabel ? "text-foreground" : "text-muted-foreground")}>
                <HugeiconsIcon icon={FilterIcon} strokeWidth={1.8} className="size-4" />
                {kindLabel && kind ? kindLabel : "Filter"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              <DropdownMenuRadioGroup value={kind === "pinned" ? "" : kind} onValueChange={setKind}>
                {CLIPBOARD_FILTERS.filter((filter) => filter.id !== "pinned").map((filter) => (
                  <DropdownMenuRadioItem key={filter.id || "all"} value={filter.id}>
                    {filter.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={kind === "pinned"}
            className={cn("gap-1.5 px-2.5 text-[14px]", kind === "pinned" ? "text-gold" : "text-muted-foreground")}
            onClick={() => setKind(kind === "pinned" ? "" : "pinned")}
          >
            <HugeiconsIcon icon={PinIcon} strokeWidth={1.8} className="size-4" />
            Pinned
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={fromScreen}
            className={cn("gap-1.5 px-2.5 text-[14px]", fromScreen ? "text-gold" : "text-muted-foreground")}
            onClick={() => setFromScreen(!fromScreen)}
          >
            <HugeiconsIcon icon={TextSelectionIcon} strokeWidth={1.8} className="size-4" />
            From screen
          </Button>
          <div className="ml-auto flex items-center gap-0.5 rounded-[10px] bg-white/[0.05] p-0.5" role="radiogroup" aria-label="View">
            {(
              [
                ["grid", GridViewIcon, "Grid"],
                ["list", Menu01Icon, "List"],
              ] as const
            ).map(([id, icon, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={view === id}
                aria-label={label}
                className={cn("flex size-8 items-center justify-center rounded-[8px] transition-colors", view === id ? "bg-white/[0.1] text-foreground" : "text-faint hover:text-muted-foreground")}
                onClick={() => switchView(id)}
              >
                <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-4" />
              </button>
            ))}
          </div>
        </div>

        {banner || !enabled ? (
          <section className="relative flex gap-3 rounded-2xl border border-gold/20 bg-gold/[0.04] px-5 py-4">
            <HugeiconsIcon icon={Idea01Icon} strokeWidth={1.8} className="mt-0.5 size-[18px] shrink-0 text-gold" />
            <div className="flex flex-col gap-1 pr-6 text-[14px] leading-[1.6]">
              <h2 className="font-semibold text-foreground">{enabled ? "Everything you copy lives here" : "Clipboard history is off"}</h2>
              <p className="text-muted-foreground">
                {enabled
                  ? `Text, links, images and files you copy are kept on this Mac${shortcut ? `, and ${shortcut} opens them over any app to paste again` : ""}. Pin what you reuse.`
                  : "New copies aren't kept. Turn it on in Settings → Clipboard."}{" "}
                {grabShortcut ? `Press ${grabShortcut} and drag over anything on screen to copy the text in it.` : ""} Copies from password managers are never kept.
              </p>
            </div>
            {enabled ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss"
                className="absolute top-3 right-3 text-faint"
                onClick={() => {
                  setBanner(false)
                  store(BANNER_KEY, "1")
                }}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            ) : null}
          </section>
        ) : null}

        {entries && !shown.length ? (
          <Empty className="border-0 py-16">
            <EmptyHeader>
              <EmptyTitle className="text-[16px]">{query || kind || fromScreen ? "No matches" : "Nothing copied yet"}</EmptyTitle>
              <EmptyDescription>{query || kind || fromScreen ? "Try other words or another filter." : "Copy something in any app and it shows up here."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : view === "grid" ? (
          <Masonry
            items={shown}
            render={(entry) => <ClipboardCard key={entry.id} entry={entry} copied={copied === entry.id} onCopy={() => void copy(entry)} />}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((entry) => (
              <ClipboardRow key={entry.id} entry={entry} copied={copied === entry.id} onCopy={() => void copy(entry)} />
            ))}
          </div>
        )}
      </div>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear your clipboard history?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything you've copied is deleted from this Mac{pinnedCount ? ", except pinned items" : ""}. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void window.meetingRecorder.clipboardClear(false)}>
              Clear history
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}
