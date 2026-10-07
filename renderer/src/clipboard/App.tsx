import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { PinIcon, Search01Icon } from "@hugeicons/core-free-icons"

import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"
import type { ClipboardEntry } from "@/types/bridge"

import { CLIPBOARD_FILTERS, ClipboardContent, kindIcon, relativeTime } from "../main-window/clipboard"

function oneLine(entry: ClipboardEntry) {
  if (entry.kind === "image") return entry.width && entry.height ? `Image ${entry.width} × ${entry.height}` : "Image"
  return entry.text.replace(/\s+/g, " ").trim()
}

// The clipboard history over any app: type to search, arrows to move, Return to paste.
export function App() {
  const windows = window.clipboardPicker.platform === "win32"
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState("")
  const [entries, setEntries] = useState<ClipboardEntry[]>([])
  const [selected, setSelected] = useState(0)
  const [target, setTarget] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const load = useCallback(async (search: string, filter: string) => {
    const result = await window.clipboardPicker.list(search, filter).catch(() => ({ entries: [], total: 0 }))
    setEntries(result.entries)
  }, [])

  useEffect(() => {
    window.clipboardPicker.onOpen(({ app }) => {
      setTarget(app)
      setQuery("")
      setKind("")
      setSelected(0)
      void load("", "")
      window.setTimeout(() => input.current?.focus(), 0)
    })
  }, [load])
  useEffect(() => {
    const timer = window.setTimeout(() => void load(query, kind), 60)
    setSelected(0)
    return () => window.clearTimeout(timer)
  }, [query, kind, load])
  useEffect(() => window.clipboardPicker.onChanged(() => void load(query, kind)), [query, kind, load])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" })
  }, [selected])

  const current = entries[selected]
  const choose = (entry: ClipboardEntry | undefined, how: "paste" | "copy") => {
    if (entry) window.clipboardPicker.choose(entry.id, how)
  }
  const filterIndex = useMemo(() => CLIPBOARD_FILTERS.findIndex((filter) => filter.id === kind), [kind])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const modifier = windows ? event.ctrlKey : event.metaKey
    if (event.key === "Escape") {
      event.preventDefault()
      if (query) setQuery("")
      else window.clipboardPicker.close()
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelected((index) => Math.min(entries.length - 1, index + 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelected((index) => Math.max(0, index - 1))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(current, modifier ? "copy" : "paste")
    } else if (modifier && /^[1-9]$/.test(event.key)) {
      event.preventDefault()
      choose(entries[Number(event.key) - 1], "paste")
    } else if (modifier && event.key.toLowerCase() === "p" && current) {
      event.preventDefault()
      void window.clipboardPicker.pin(current.id, !current.pinned)
    } else if (modifier && event.key === "Backspace" && current) {
      event.preventDefault()
      void window.clipboardPicker.remove(current.id)
    } else if (event.key === "Tab") {
      event.preventDefault()
      const next = (filterIndex + (event.shiftKey ? CLIPBOARD_FILTERS.length - 1 : 1)) % CLIPBOARD_FILTERS.length
      setKind(CLIPBOARD_FILTERS[next].id)
    }
  }

  return (
    <div className="flex h-full bg-transparent p-5" onKeyDown={onKeyDown}>
      <div className="relative flex w-full rounded-xl">
        <div aria-hidden className="silver-glow" />
        <div className="silver-border flex min-h-0 w-full flex-col overflow-hidden rounded-[inherit] text-foreground shadow-[0_12px_32px_rgb(0_0_0/0.45)]">
          <header className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
            <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              value={query}
              autoFocus
              spellCheck={false}
              placeholder={target ? `Paste into ${target}…` : "Search what you've copied…"}
              aria-label="Search clipboard history"
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex shrink-0 gap-0.5" role="tablist" aria-label="Show">
              {CLIPBOARD_FILTERS.map((filter) => (
                <button
                  key={filter.id || "all"}
                  type="button"
                  role="tab"
                  aria-selected={kind === filter.id}
                  tabIndex={-1}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11.5px] transition-colors",
                    kind === filter.id ? "bg-muted text-foreground" : "text-faint hover:text-muted-foreground",
                  )}
                  onClick={() => {
                    setKind(filter.id)
                    input.current?.focus()
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </header>
          <div className="flex min-h-0 flex-1">
            <div ref={list} className="w-[300px] shrink-0 overflow-y-auto border-r border-border p-1.5" role="listbox" aria-label="Clipboard history">
              {entries.length ? (
                entries.map((entry, index) => {
                  const icon = kindIcon(entry.kind)
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={index === selected}
                      data-index={index}
                      tabIndex={-1}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]",
                        index === selected ? "bg-ember-soft text-foreground" : "text-foreground/85 hover:bg-muted/60",
                      )}
                      onMouseMove={() => setSelected(index)}
                      onClick={() => choose(entry, "paste")}
                    >
                      {icon ? <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className={cn("min-w-0 flex-1 truncate", entry.kind === "file" && "font-mono text-[12px]")}>{oneLine(entry)}</span>
                      {entry.pinned ? <HugeiconsIcon icon={PinIcon} strokeWidth={1.8} className="size-3 shrink-0 text-ember" /> : null}
                      {index < 9 ? <span className="tabular shrink-0 text-[11px] text-faint">{windows ? "Ctrl+" : "⌘"}{index + 1}</span> : null}
                    </button>
                  )
                })
              ) : (
                <p className="px-3 py-6 text-center text-[12.5px] text-faint">{query || kind ? "No matches" : "Nothing copied yet"}</p>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {current ? (
                <>
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
                    <ClipboardContent entry={current} lines={16} />
                  </div>
                  <p className="border-t border-border px-4 py-2 text-[11.5px] text-faint">
                    {current.source === "screen" ? "From screen" : current.app || "Copied"} · {relativeTime(current.at)}
                    {current.kind !== "image" ? ` · ${current.text.length.toLocaleString()} characters` : ""}
                  </p>
                </>
              ) : null}
            </div>
          </div>
          <footer className="flex items-center gap-3 border-t border-border px-4 py-1.5 text-[11px] text-faint">
            <span>
              <Kbd>↵</Kbd> Paste
            </span>
            <span>
              <Kbd>{windows ? "Ctrl+Enter" : "⌘↵"}</Kbd> Copy
            </span>
            <span>
              <Kbd>{windows ? "Ctrl+P" : "⌘P"}</Kbd> Pin
            </span>
            <span>
              <Kbd>{windows ? "Ctrl+Backspace" : "⌘⌫"}</Kbd> Delete
            </span>
            <button type="button" tabIndex={-1} className="ml-auto hover:text-muted-foreground" onClick={() => window.clipboardPicker.openPage()}>
              Open Clipboard page
            </button>
          </footer>
        </div>
      </div>
    </div>
  )
}
