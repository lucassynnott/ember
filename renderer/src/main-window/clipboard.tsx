import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BarcodeIcon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  File01Icon,
  Image01Icon,
  Link01Icon,
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
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { ClipboardEntry, ClipboardKind } from "@/types/bridge"

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

/** Everything you've copied, plus text grabbed from the screen, to search, pin and copy again. */
export function ClipboardPage({ enabled, shortcut, grabShortcut }: { enabled: boolean; shortcut?: string; grabShortcut?: string }) {
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState("")
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

  const pinnedCount = useMemo(() => (entries || []).filter((entry) => entry.pinned).length, [entries])

  const copy = async (entry: ClipboardEntry) => {
    await window.meetingRecorder.clipboardCopy(entry.id)
    setCopied(entry.id)
    window.setTimeout(() => setCopied((current) => (current === entry.id ? null : current)), 1400)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-6">
        <h1 className="truncate text-[21px] font-normal tracking-[-0.02em]">Clipboard</h1>
        <div className="no-drag ml-auto flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => void window.meetingRecorder.grabText(false)}>
            <HugeiconsIcon icon={TextSelectionIcon} strokeWidth={1.8} data-icon="inline-start" />
            Grab text from screen
            {grabShortcut ? <span className="text-faint">{grabShortcut}</span> : null}
          </Button>
          {total ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirmClear(true)}>
              Clear
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <InputGroup className="h-9 max-w-[360px]">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} />
          </InputGroupAddon>
          <InputGroupInput value={query} placeholder="Search what you've copied" aria-label="Search clipboard history" onChange={(event) => setQuery(event.target.value)} />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <ToggleGroup type="single" size="sm" variant="outline" value={kind} onValueChange={(value) => setKind(value || "")} aria-label="Show">
          {CLIPBOARD_FILTERS.map((filter) => (
            <ToggleGroupItem key={filter.id || "all"} value={filter.id} className="px-2.5 text-[12px]">
              {filter.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {!enabled ? (
        <p className="border-b border-border bg-gold-soft px-6 py-2 text-[12px] text-foreground/80">
          Clipboard history is off, so new copies aren't kept. Turn it on in Settings → Clipboard.
        </p>
      ) : null}
      {entries && !entries.length ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle className="text-[15px]">{query || kind ? "No matches" : "Nothing copied yet"}</EmptyTitle>
            <EmptyDescription>
              {query || kind
                ? "Try other words or another filter."
                : `Everything you copy shows up here${shortcut ? `, and ${shortcut} opens it over any app to paste again` : ""}. Copies from password managers are never kept.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-[860px] flex-col gap-1.5 px-6 py-5">
            {(entries || []).map((entry) => {
              const icon = kindIcon(entry.kind)
              return (
                <article key={entry.id} className={cn("group flex gap-4 rounded-lg border bg-panel px-4 py-3", entry.pinned ? "border-gold/35" : "border-border")}>
                  <div className="flex w-[104px] shrink-0 flex-col gap-1 pt-0.5">
                    <span className="tabular text-[12px] text-muted-foreground">{relativeTime(entry.at)}</span>
                    <span className="flex items-center gap-1 truncate text-[11px] text-faint">
                      {icon ? <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-3 shrink-0" /> : null}
                      <span className="truncate">{entry.source === "screen" ? "From screen" : entry.app || "Copied"}</span>
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <ClipboardContent entry={entry} />
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
                    <Button variant="ghost" size="icon-sm" aria-label="Copy" onClick={() => void copy(entry)}>
                      <HugeiconsIcon icon={copied === entry.id ? Tick02Icon : Copy01Icon} strokeWidth={1.8} className={copied === entry.id ? "text-gold" : ""} />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Delete" className="text-muted-foreground" onClick={() => void window.meetingRecorder.clipboardRemove(entry.id)}>
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        </ScrollArea>
      )}
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
    </div>
  )
}
