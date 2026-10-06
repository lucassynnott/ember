import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowUpRight01Icon, Cancel01Icon, Search01Icon, SentIcon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { ActionDestination, ActionItemEntry, IntegrationState, SentAction } from "@/types/bridge"

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
        done ? "ember-fill border-transparent text-background" : "border-ember/60 hover:border-ember hover:bg-ember-soft",
        className,
      )}
    >
      {done ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} className="size-3" /> : null}
    </button>
  )
}

const key = (item: Pick<ActionItemEntry, "meetingId" | "index">) => `${item.meetingId}#${item.index}`

const DESTINATION_LABEL: Record<ActionDestination, string> = { linear: "Linear", notion: "Notion", reminders: window.meetingRecorder.platform === "win32" ? "Microsoft To Do" : "Reminders" }

/** Where action items can go right now, and what's already been sent. */
export function useIntegrations() {
  const [state, setState] = useState<IntegrationState | null>(null)
  const [sent, setSent] = useState<Record<string, SentAction>>({})
  const load = useCallback(() => {
    void window.meetingRecorder.integrations().then(setState).catch(() => setState(null))
    void window.meetingRecorder.sentActions().then(setSent).catch(() => setSent({}))
  }, [])
  useEffect(() => {
    load()
    window.meetingRecorder.onIntegrationsChanged(load)
  }, [load])
  const destinations: ActionDestination[] = []
  if (state?.connected.linear && state.linearTeam) destinations.push("linear")
  if (state?.connected.notion && state.notionDatabase) destinations.push("notion")
  if (state?.remindersList) destinations.push("reminders")
  return { destinations, sent, reload: load }
}

/** Send one action item to Linear, Notion or Reminders; once sent, a link to it. */
export function SendMenu({ meetingId, index, sent, destinations, onSent }: {
  meetingId: string
  index: number
  sent?: SentAction
  destinations: ActionDestination[]
  onSent: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  if (sent) {
    return sent.url ? (
      <button
        type="button"
        onClick={() => void window.meetingRecorder.openSentLink(sent.url!)}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-ember hover:bg-ember-soft"
      >
        {DESTINATION_LABEL[sent.destination]}
        <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} className="size-3" />
      </button>
    ) : (
      <span className="shrink-0 px-1.5 text-[12px] text-faint">In {DESTINATION_LABEL[sent.destination]}</span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Send to…" title={error || "Send to…"} disabled={busy} className={cn("shrink-0 text-muted-foreground", error && "text-rec")}>
          <HugeiconsIcon icon={SentIcon} strokeWidth={1.8} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-[12px] text-faint">Send to</DropdownMenuLabel>
        {destinations.map((destination) => (
          <DropdownMenuItem
            key={destination}
            onSelect={async () => {
              setBusy(true)
              setError("")
              try {
                await window.meetingRecorder.sendAction(meetingId, index, destination)
                onSent()
              } catch (failure) {
                setError(String((failure as Error)?.message || failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
              } finally {
                setBusy(false)
              }
            }}
          >
            {DESTINATION_LABEL[destination]}
          </DropdownMenuItem>
        ))}
        {destinations.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => void window.meetingRecorder.openSettings("connections")}>
          {destinations.length ? "Connections…" : "Connect Linear, Notion or Reminders…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Every action item from your calls, to tick off. */
export function ActionsPage({ onOpenMeeting }: { onOpenMeeting: (id: string) => void }) {
  const [items, setItems] = useState<ActionItemEntry[] | null>(null)
  const [who, setWho] = useState<"mine" | "all">("mine")
  const [status, setStatus] = useState<"open" | "done">("open")
  const [query, setQuery] = useState("")
  // Ticked in this view: kept in place, struck through, until you change the filter.
  const [recent, setRecent] = useState<Set<string>>(new Set())
  const [error, setError] = useState("")
  const integrations = useIntegrations()

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

  // Eden's segmented control: a soft track with the chosen option raised.
  const groupClass = "gap-0.5 rounded-[10px] bg-white/[0.05] p-0.5"
  const toggleClass = "h-7 rounded-[8px]! border-0 px-3 text-[13px] text-muted-foreground data-[state=on]:bg-white/[0.1] data-[state=on]:text-foreground"
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-10 pb-4">
        <ToggleGroup type="single" spacing={0} size="sm" className={groupClass} value={who} onValueChange={(value) => value && setWho(value as "mine" | "all")}>
          <ToggleGroupItem value="mine" className={toggleClass}>
            Mine
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className={toggleClass}>
            Everyone's
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" spacing={0} size="sm" className={groupClass} value={status} onValueChange={(value) => value && setStatus(value as "open" | "done")}>
          <ToggleGroupItem value="open" className={toggleClass}>
            Open <span className="tabular ml-1 text-faint">{counts.open}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="done" className={toggleClass}>
            Done <span className="tabular ml-1 text-faint">{counts.done}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <InputGroup className="ml-auto h-9 w-[280px] rounded-full bg-white/[0.025] px-1">
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
                      <SendMenu
                        meetingId={item.meetingId}
                        index={item.index}
                        sent={integrations.sent[key(item)]}
                        destinations={integrations.destinations}
                        onSent={integrations.reload}
                      />
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
