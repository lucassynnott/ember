import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { ActionItemEntry } from "@/types/bridge"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const day = (time: number) => {
  const date = new Date(time)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`}`
}

/** A round tick box for an action item. */
export function ActionCheck({ done, label, onToggle, className }: { done: boolean; label: string; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Mark “${label}” as not done` : `Mark “${label}” as done`}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors",
        done ? "gold-fill border-transparent text-background" : "border-gold/60 hover:border-gold hover:bg-gold-soft",
        className,
      )}
    >
      {done ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} className="size-3" /> : null}
    </button>
  )
}

const key = (item: Pick<ActionItemEntry, "meetingId" | "index">) => `${item.meetingId}#${item.index}`

/** Every action item from your calls, to tick off. */
export function ActionsPage({ onOpenMeeting }: { onOpenMeeting: (id: string) => void }) {
  const [items, setItems] = useState<ActionItemEntry[] | null>(null)
  const [who, setWho] = useState<"mine" | "all">("mine")
  const [status, setStatus] = useState<"open" | "done">("open")
  const [query, setQuery] = useState("")
  // Ticked in this view: kept in place, struck through, until you change the filter.
  const [recent, setRecent] = useState<Set<string>>(new Set())
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setItems(await window.meetingRecorder.actionItems().catch(() => []))
  }, [])
  useEffect(() => {
    void load()
    window.meetingRecorder.onLibraryChanged(() => void load())
  }, [load])
  useEffect(() => setRecent(new Set()), [who, status])

  const toggle = async (item: ActionItemEntry) => {
    const done = !item.done
    setError("")
    setItems((current) => current?.map((candidate) => (key(candidate) === key(item) ? { ...candidate, done } : candidate)) || null)
    setRecent((current) => new Set(current).add(key(item)))
    try {
      await window.meetingRecorder.setActionDone(item.meetingId, item.index, done)
    } catch (failure) {
      setError(String((failure as Error)?.message || failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
      void load()
    }
  }

  const counts = useMemo(() => {
    const scope = (items || []).filter((item) => who === "all" || item.mine)
    return { open: scope.filter((item) => !item.done).length, done: scope.filter((item) => item.done).length }
  }, [items, who])

  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = (items || []).filter(
      (item) =>
        (who === "all" || item.mine) &&
        ((status === "done") === item.done || recent.has(key(item))) &&
        words.every((word) => `${item.task} ${item.owner} ${item.meetingTitle || ""}`.toLowerCase().includes(word)),
    )
    const result: { meetingId: string; title: string; startedAt: number; items: ActionItemEntry[] }[] = []
    for (const item of shown) {
      const last = result[result.length - 1]
      if (last?.meetingId === item.meetingId) last.items.push(item)
      else result.push({ meetingId: item.meetingId, title: item.meetingTitle || "Untitled call", startedAt: item.startedAt, items: [item] })
    }
    return result
  }, [items, who, status, query, recent])

  const toggleClass = "px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <ToggleGroup type="single" variant="outline" size="sm" value={who} onValueChange={(value) => value && setWho(value as "mine" | "all")}>
          <ToggleGroupItem value="mine" className={toggleClass}>
            Mine
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className={toggleClass}>
            Everyone's
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" variant="outline" size="sm" value={status} onValueChange={(value) => value && setStatus(value as "open" | "done")}>
          <ToggleGroupItem value="open" className={toggleClass}>
            Open <span className="tabular ml-1 text-faint">{counts.open}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="done" className={toggleClass}>
            Done <span className="tabular ml-1 text-faint">{counts.done}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <InputGroup className="ml-auto h-8 w-[260px]">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} />
          </InputGroupAddon>
          <InputGroupInput value={query} placeholder="Search action items" aria-label="Search action items" onChange={(event) => setQuery(event.target.value)} />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      {error ? <p className="border-b border-border px-6 py-2 text-[12px] text-rec">{error}</p> : null}
      {items && !groups.length ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle className="text-[15px]">
              {query ? "No matches" : status === "open" ? (who === "mine" ? "Nothing on your plate" : "No open action items") : "Nothing ticked off yet"}
            </EmptyTitle>
            <EmptyDescription>
              {query
                ? "Try other words."
                : status === "open"
                  ? "Action items from your calls show up here. Tick them off as you go."
                  : "Items you tick off land here, in case you need them again."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-[860px] flex-col gap-5 px-6 py-5">
            {groups.map((group) => (
              <section key={group.meetingId} className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => onOpenMeeting(group.meetingId)}
                  className="flex items-baseline gap-2 self-start rounded-md px-1 py-0.5 text-left hover:bg-accent"
                >
                  <span className="text-[13px] font-medium text-foreground/90">{group.title}</span>
                  <span className="tabular text-[12px] text-faint">{day(group.startedAt)}</span>
                </button>
                <ul className="flex flex-col">
                  {group.items.map((item) => (
                    <li key={key(item)} className="flex items-start gap-3 rounded-md px-1 py-2">
                      <ActionCheck done={item.done} label={item.task} onToggle={() => void toggle(item)} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-[14px] leading-[1.5] transition-colors", item.done ? "text-faint line-through" : "text-foreground/90")} data-selectable>
                          {item.task}
                        </p>
                        {!item.mine || who === "all" ? <p className="text-[12px] text-muted-foreground">{item.mine ? "You" : item.owner}</p> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

/** How many of your action items are still open, for the sidebar. */
export function useOpenActionCount() {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    const load = () =>
      void window.meetingRecorder
        .actionItems()
        .then((items) => setCount(items.filter((item) => item.mine && !item.done).length))
        .catch(() => setCount(null))
    load()
    window.meetingRecorder.onLibraryChanged(load)
  }, [])
  return count
}
