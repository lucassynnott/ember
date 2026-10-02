import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { MeetingLibraryState } from "@/types/bridge"

import { AnswerText, streams, subscribe } from "./ask"
import { errorText } from "./meetings"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// Weeks run Monday to Sunday, named by their Monday, matching the main process.
function weekOf(time: number) {
  const date = new Date(time)
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const id = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`
  return { id, label: `Week of ${start.getDate()} ${MONTHS[start.getMonth()]}${start.getFullYear() === new Date().getFullYear() ? "" : ` ${start.getFullYear()}`}` }
}

export function DigestPage({ library, onOpenMeeting }: { library: MeetingLibraryState | null; onOpenMeeting: (id: string) => void }) {
  const [written, setWritten] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [writing, setWriting] = useState<string | null>(null)
  const [streamed, setStreamed] = useState("")
  const [error, setError] = useState("")
  const request = useRef<string | null>(null)

  const reload = useCallback(async () => {
    const list = await window.meetingRecorder.listDigests().catch(() => [])
    setWritten(new Set(list.map((entry) => entry.id)))
  }, [])

  useEffect(() => {
    void reload()
    window.meetingRecorder.onDigestsChanged(() => void reload())
  }, [reload])

  // Every week with calls, newest first.
  const weeks = useMemo(() => {
    const byWeek = new Map<string, { id: string; label: string; calls: number }>()
    for (const meeting of library?.meetings || []) {
      if (!meeting.startedAt || !meeting.hasNote) continue
      const week = weekOf(meeting.startedAt)
      const entry = byWeek.get(week.id) || { ...week, calls: 0 }
      entry.calls += 1
      byWeek.set(week.id, entry)
    }
    return [...byWeek.values()].sort((a, b) => b.id.localeCompare(a.id))
  }, [library])

  const current = selected && weeks.some((week) => week.id === selected) ? selected : weeks[0]?.id || null

  useEffect(() => {
    setMarkdown(null)
    setError("")
    if (!current || !written.has(current)) return
    let cancelled = false
    void window.meetingRecorder.getDigest(current).then((digest) => !cancelled && setMarkdown(digest?.markdown || null))
    return () => {
      cancelled = true
    }
  }, [current, written])

  const write = async (id: string) => {
    subscribe()
    const requestId = crypto.randomUUID()
    request.current = requestId
    setWriting(id)
    setStreamed("")
    setError("")
    streams.set(requestId, (delta) => request.current === requestId && setStreamed((text) => text + delta))
    try {
      const digest = await window.meetingRecorder.writeDigest(requestId, id)
      if (request.current === requestId) setMarkdown(digest.markdown)
      await reload()
    } catch (failure) {
      if (request.current === requestId) setError(errorText(failure))
    } finally {
      streams.delete(requestId)
      if (request.current === requestId) {
        request.current = null
        setWriting(null)
      }
    }
  }

  const week = weeks.find((entry) => entry.id === current)
  const body = writing === current ? streamed : markdown?.replace(/^# .*\n+/, "") || ""
  const state = { meetings: library?.meetings || [], folders: [], tags: [] }

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex w-[260px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border px-3 py-3">
        {weeks.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setSelected(entry.id)}
            className={cn("flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors", entry.id === current ? "bg-accent" : "hover:bg-accent/50")}
          >
            <span className="text-[14px] text-foreground">{entry.label}</span>
            <span className="text-[12px] text-faint">
              {entry.calls} {entry.calls === 1 ? "call" : "calls"} · {written.has(entry.id) ? "Digest written" : "No digest yet"}
            </span>
          </button>
        ))}
      </section>
      <section className="flex min-w-0 flex-1 flex-col">
        {week ? (
          <>
            <header className="flex items-center gap-3 border-b border-border px-10 pt-6 pb-5">
              <div className="min-w-0 flex-1">
                <h2 className="text-[21px] font-normal tracking-[-0.02em]">{week.label}</h2>
                <p className="text-[13px] text-muted-foreground">
                  {week.calls} {week.calls === 1 ? "call" : "calls"}. Written automatically on Fridays from 4 pm.
                </p>
              </div>
              <Button variant={written.has(week.id) ? "secondary" : "default"} size="sm" disabled={Boolean(writing)} onClick={() => void write(week.id)}>
                {writing === week.id ? "Writing…" : written.has(week.id) ? "Write again" : "Write digest"}
              </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="max-w-[760px] px-10 pt-6 pb-16">
                {error ? (
                  <p className="text-[13px] text-rec">{error}</p>
                ) : body ? (
                  <AnswerText text={body} library={state} onOpenMeeting={onOpenMeeting} />
                ) : writing === week.id ? (
                  <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Spinner className="size-3.5" /> Reading the week's calls…
                  </p>
                ) : (
                  <p className="text-[14px] text-muted-foreground">No digest for this week yet.</p>
                )}
              </div>
            </div>
          </>
        ) : (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle className="text-[15px]">No calls yet</EmptyTitle>
              <EmptyDescription>Weekly digests appear here once you have calls with notes.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  )
}
