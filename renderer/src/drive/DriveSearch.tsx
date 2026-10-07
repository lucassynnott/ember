import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { File01Icon, Search01Icon, Video01Icon } from "@hugeicons/core-free-icons"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { DriveHit } from "@/types/bridge"

import { bytesLabel } from "./providers"

const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i

/**
 * ⌃⌥O: search every file on Ember Drive by name. Return shows it in Finder, Option-Return copies a share link,
 * Command-Return shares a video with Ember.
 */
export function DriveSearch() {
  const windows = window.meetingRecorder.platform === "win32"
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<DriveHit[]>([])
  const [count, setCount] = useState(0)
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const asked = useRef(0)

  useEffect(() => {
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    return window.meetingRecorder.onDriveSearchOpen(() => {
      setQuery("")
      setToast("")
      input.current?.focus()
    })
  }, [])

  // The helper filters its index of the whole drive (rebuilt when it's over 90 seconds old).
  useEffect(() => {
    const ask = ++asked.current
    setLoading(true)
    const timer = window.setTimeout(() => {
      void window.meetingRecorder.driveRequest<{ hits: DriveHit[]; count: number }>("search", { query }).then(
        (result) => {
          if (ask !== asked.current) return
          setHits(result.hits)
          setCount(result.count)
          setSelected(0)
          setLoading(false)
        },
        () => ask === asked.current && setLoading(false),
      )
    }, query ? 80 : 0)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" })
  }, [selected])

  const close = () => void window.meetingRecorder.driveHideSearch()
  const flash = (text: string) => {
    setToast(text)
    window.setTimeout(close, 900)
  }

  const act = async (hit: DriveHit | undefined, event: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (!hit) return
    try {
      if (windows ? event.ctrlKey : event.metaKey) {
        if (!VIDEO.test(hit.name)) return setToast("Only videos can be shared with Ember.")
        await window.meetingRecorder.driveShareVideo(hit.key)
      } else if (event.altKey) {
        await window.meetingRecorder.driveCopyLink(hit.key)
        flash("Share link copied (works for 7 days)")
      } else {
        await window.meetingRecorder.driveRequest("reveal", { key: hit.key })
        close()
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error))
    }
  }

  const offline = async (command: "pin" | "unpin") => {
    const hit = hits[selected]
    if (!hit || offlineBusy) return
    setOfflineBusy(true)
    setToast(command === "pin" ? "Downloading for offline use…" : "Removing offline pin…")
    try {
      await window.meetingRecorder.driveRequest(command, { keys: [hit.key] })
      flash(command === "pin" ? "Available offline" : "Offline pin removed")
    } catch (error) {
      setToast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error))
    } finally { setOfflineBusy(false) }
  }

  return (
    <div
      className="flex h-screen flex-col overflow-hidden rounded-[18px] border border-white/10 bg-[#1c1c1f]/95 text-foreground shadow-[0_24px_70px_rgb(0_0_0/0.5)] backdrop-blur-xl"
      onKeyDown={(event) => {
        if (event.key === "Escape") close()
        else if (event.key === "ArrowDown") (event.preventDefault(), setSelected((index) => Math.min(hits.length - 1, index + 1)))
        else if (event.key === "ArrowUp") (event.preventDefault(), setSelected((index) => Math.max(0, index - 1)))
        else if (event.key === "Enter") (event.preventDefault(), void act(hits[selected], event))
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} className="size-5 text-muted-foreground" />
        <input
          ref={input}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Ember Drive"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[20px] outline-none placeholder:text-faint"
        />
        {loading ? <Spinner className="text-muted-foreground" /> : null}
      </div>
      <div className="h-px bg-white/10" />
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {hits.length ? (
          hits.map((hit, index) => (
            <button
              key={hit.key}
              type="button"
              data-index={index}
              onMouseMove={() => setSelected(index)}
              onClick={(event) => void act(hit, event)}
              className={cn("flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left", index === selected ? "bg-ember/[0.14]" : "")}
            >
              <HugeiconsIcon icon={VIDEO.test(hit.name) ? Video01Icon : File01Icon} strokeWidth={1.6} className="size-[18px] shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px]">{hit.name}</span>
                {hit.folder ? <span className="truncate text-[12px] text-faint">{hit.folder}</span> : null}
              </span>
              <span className="tabular shrink-0 text-[12px] text-faint">{bytesLabel(hit.size)}</span>
            </button>
          ))
        ) : (
          <div className="flex h-24 items-center justify-center text-[13.5px] text-muted-foreground">{loading ? "Indexing your drive…" : "No matches"}</div>
        )}
      </div>
      {windows && hits[selected] ? (
        <div className="flex items-center gap-3 border-t border-white/10 px-4 py-2 text-[12px]">
          <button type="button" disabled={offlineBusy} onClick={() => void offline("pin")} className="text-ember disabled:opacity-50">Keep offline</button>
          <button type="button" disabled={offlineBusy} onClick={() => void offline("unpin")} className="text-muted-foreground disabled:opacity-50">Remove offline pin</button>
        </div>
      ) : null}
      <div className="h-px bg-white/10" />
      <div className="flex items-center gap-4 px-4 py-2 text-[11.5px] text-muted-foreground">
        {toast ? (
          <span className="text-ember">{toast}</span>
        ) : (
          <>
            <span>↩ Show in {windows ? "File Explorer" : "Finder"}</span>
            <span>{windows ? "Alt+↩" : "⌥↩"} Copy share link</span>
            <span>{windows ? "Ctrl+↩" : "⌘↩"} Share video with Ember</span>
          </>
        )}
        <span className="ml-auto text-faint">{count} files</span>
      </div>
    </div>
  )
}
