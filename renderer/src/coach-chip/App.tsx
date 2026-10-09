import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon, ArrowUp01Icon, BookOpen01Icon, Clock01Icon, Target02Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { CoachState } from "@/types/bridge"

const TONES: Record<string, string> = {
  delivery: "text-amber-200",
  room: "text-ember",
  time: "text-foreground",
}

// The coach chip at the top of the screen during a call: the goal and checklist progress at a glance, a short cue
// now and then, and the checklist when you click it.
export function App() {
  const [state, setState] = useState<CoachState | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.coachChip.state().then((initial) => initial && setState(initial as CoachState))
    window.coachChip.onState((next) => setState(next as CoachState))
  }, [])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const report = () => window.coachChip.resize(Math.ceil(element.getBoundingClientRect().height) + 16)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const items = state?.items || []
  const done = items.filter((item) => item.done).length
  const cue = state?.cue
  const sourceName = (sources?: Record<string, { name: string }>) => Object.values(sources || {})[0]?.name

  return (
    <div className="flex justify-center bg-transparent p-2">
      <div ref={ref} className="w-full">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-full border border-white/10 bg-[#141210]/92 px-3 text-left text-[12.5px] shadow-[0_6px_20px_rgb(0_0_0/0.35)] backdrop-blur transition-colors",
            cue && "border-ember/50",
          )}
          aria-expanded={open}
        >
          <span className={cn("size-2 shrink-0 rounded-full", cue ? "animate-pulse bg-ember" : "bg-ember/70")} aria-hidden />
          <span key={cue?.at || "goal"} className={cn("min-w-0 flex-1 truncate animate-in fade-in duration-300", cue ? TONES[cue.tone] || "text-foreground" : "text-foreground/85")}>
            {cue ? cue.text : state?.goal?.text || (state?.enabled.goals ? "Working out a goal for this call…" : "Coaching this call")}
          </span>
          {items.length ? (
            <span className="shrink-0 tabular-nums text-faint" title={`${done} of ${items.length} covered`}>
              {done}/{items.length}
            </span>
          ) : null}
          {state?.minutesLeft !== null && state?.minutesLeft !== undefined ? (
            <span className={cn("flex shrink-0 items-center gap-1 tabular-nums", state.minutesLeft <= 10 ? "text-ember" : "text-faint")}>
              <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.8} className="size-3" />
              {state.minutesLeft}m
            </span>
          ) : null}
          <HugeiconsIcon icon={open ? ArrowUp01Icon : ArrowDown01Icon} strokeWidth={2} className="size-3 shrink-0 text-faint" />
        </button>

        {open && state ? (
          <div className="mt-1.5 flex flex-col gap-3 rounded-xl border border-white/10 bg-[#141210]/95 p-3.5 text-[12.5px] shadow-[0_12px_32px_rgb(0_0_0/0.45)] backdrop-blur">
            <section className="flex items-start gap-2">
              <HugeiconsIcon icon={Target02Icon} strokeWidth={1.8} className="mt-0.5 size-3.5 shrink-0 text-ember" />
              <div className="min-w-0">
                <p className="font-medium text-foreground">{state.goal?.text || "No goal yet"}</p>
                {state.goal?.why ? <p className="mt-0.5 text-faint">{state.goal.why}</p> : null}
                {sourceName(state.goal?.sources) ? (
                  <button type="button" className="mt-1 flex items-center gap-1 text-[11.5px] text-ember hover:underline" onClick={() => window.coachChip.action("open-source", Object.values(state.goal!.sources!)[0].file)}>
                    <HugeiconsIcon icon={BookOpen01Icon} strokeWidth={1.8} className="size-3" /> {sourceName(state.goal?.sources)}
                  </button>
                ) : null}
              </div>
            </section>

            {items.length ? (
              <ul className="flex flex-col gap-0.5" aria-label="Checklist">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => window.coachChip.action("toggle-item", item.id)}
                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.05]"
                    >
                      <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-[4px] border", item.done ? "border-ember bg-ember text-black" : "border-white/25")}>
                        {item.done ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} className="size-2.5" /> : null}
                      </span>
                      <span className={cn(item.done ? "text-faint line-through" : "text-foreground/90")}>{item.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {state.next ? (
              <section className="rounded-lg bg-ember/[0.08] px-3 py-2">
                <p className="text-[11px] font-medium tracking-wide text-ember uppercase">Next</p>
                <p className="mt-0.5 text-foreground/90">{state.next.text}</p>
                {sourceName(state.next.sources) ? (
                  <button type="button" className="mt-1 flex items-center gap-1 text-[11.5px] text-ember hover:underline" onClick={() => window.coachChip.action("open-source", Object.values(state.next!.sources!)[0].file)}>
                    <HugeiconsIcon icon={BookOpen01Icon} strokeWidth={1.8} className="size-3" /> {sourceName(state.next.sources)}
                  </button>
                ) : null}
              </section>
            ) : null}

            <footer className="-mx-1 -mb-1 flex items-center gap-1 text-faint">
              {state.focus ? <span className="px-1 text-[11.5px]">This week: {state.focus.label}</span> : null}
              <Button variant="ghost" size="xs" className="ml-auto text-faint" onClick={() => window.coachChip.action("open-live")}>
                Edit goal
              </Button>
              <Button variant="ghost" size="xs" className="text-faint" onClick={() => window.coachChip.action("hide")}>
                Hide this call
              </Button>
            </footer>
          </div>
        ) : null}
      </div>
    </div>
  )
}
