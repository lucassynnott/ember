import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, Copy01Icon, Delete02Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons"

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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { DictationEntry } from "@/types/bridge"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function dayLabel(time: number) {
  const date = new Date(time)
  const today = new Date()
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((start(today) - start(date)) / 86_400_000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() === today.getFullYear() ? "" : ` ${date.getFullYear()}`}`
}

function clock(time: number) {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/** Everything you've dictated, newest first, to search and copy again. */
export function HistoryPage({ enabled }: { enabled: boolean }) {
  const [query, setQuery] = useState("")
  const [entries, setEntries] = useState<DictationEntry[] | null>(null)
  const [total, setTotal] = useState(0)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = useCallback(async (search: string) => {
    const result = await window.meetingRecorder.dictationHistory(search).catch(() => ({ entries: [], total: 0 }))
    setEntries(result.entries)
    setTotal(result.total)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 120)
    return () => window.clearTimeout(timer)
  }, [query, load])
  useEffect(() => {
    window.meetingRecorder.onHistoryChanged(() => void load(query))
    // Subscribe once; the latest query is read when a change arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = useMemo(() => {
    const result: { label: string; entries: DictationEntry[] }[] = []
    for (const entry of entries || []) {
      const label = dayLabel(entry.at)
      const last = result[result.length - 1]
      if (last?.label === label) last.entries.push(entry)
      else result.push({ label, entries: [entry] })
    }
    return result
  }, [entries])

  const copy = async (entry: DictationEntry) => {
    await window.meetingRecorder.copyDictation(entry.id)
    setCopied(entry.id)
    window.setTimeout(() => setCopied((current) => (current === entry.id ? null : current)), 1400)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-10 pb-4">
        <InputGroup className="h-10 max-w-[460px] rounded-full bg-white/[0.025] px-1">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} />
          </InputGroupAddon>
          <InputGroupInput value={query} placeholder="Search what you've dictated" aria-label="Search dictation history" onChange={(event) => setQuery(event.target.value)} />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <span className="tabular text-[12px] text-faint">{total ? `${total} saved` : ""}</span>
        {total ? (
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setConfirmClear(true)}>
            Clear history
          </Button>
        ) : null}
      </div>
      {!enabled ? (
        <p className="border-b border-border bg-ember-soft px-6 py-2 text-[12px] text-foreground/80">
          History is off, so new dictations aren't saved. Turn it on in Settings → Dictation.
        </p>
      ) : null}
      {entries && !entries.length ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle className="text-[15px]">{query ? "No matches" : "Nothing dictated yet"}</EmptyTitle>
            <EmptyDescription>
              {query ? "Try other words." : "Everything you dictate or rewrite by voice shows up here, so you can copy it again."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-[860px] flex-col gap-5 px-6 py-5">
            {groups.map((group) => (
              <section key={group.label} className="flex flex-col gap-1.5">
                <h3 className="text-[12px] font-medium text-faint">{group.label}</h3>
                {group.entries.map((entry) => (
                  <article key={entry.id} className="group flex gap-4 rounded-lg border border-border bg-panel px-4 py-3">
                    <div className="flex w-[92px] shrink-0 flex-col gap-1 pt-0.5">
                      <span className="tabular text-[12px] text-muted-foreground">{clock(entry.at)}</span>
                      {entry.app ? <span className="truncate text-[11px] text-faint">{entry.app}</span> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      {entry.kind === "edit" ? (
                        <Badge variant="outline" className="mb-1.5 h-5 border-ember/40 text-[11px] font-normal text-ember">
                          Edited: {entry.instruction}
                        </Badge>
                      ) : null}
                      <p className="text-[14px] leading-[1.55] whitespace-pre-wrap text-foreground/90" data-selectable>
                        {entry.text}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-start gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                      <Button variant="ghost" size="icon-sm" aria-label="Copy" onClick={() => void copy(entry)}>
                        <HugeiconsIcon icon={copied === entry.id ? Tick02Icon : Copy01Icon} strokeWidth={1.8} className={copied === entry.id ? "text-ember" : ""} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        className="text-muted-foreground"
                        onClick={async () => {
                          await window.meetingRecorder.removeDictation(entry.id)
                          void load(query)
                        }}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
                      </Button>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear your dictation history?</AlertDialogTitle>
            <AlertDialogDescription>All {total} saved dictations are deleted from this Mac. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                await window.meetingRecorder.clearDictationHistory()
                void load(query)
              }}
            >
              Clear history
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
