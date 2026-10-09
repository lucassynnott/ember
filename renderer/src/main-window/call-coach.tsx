import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { BookOpen01Icon, Target02Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { CallCoaching, CoachFocusState, CoachSource, CoachState } from "@/types/bridge"

export const FRAMEWORK_NAMES: Record<string, string> = {
  discovery: "Discovery",
  bant: "BANT",
  meddic: "MEDDIC",
  spin: "SPIN",
  custom: "Your checklist",
  none: "Just the goal",
}

function Source({ sources }: { sources?: Record<string, CoachSource> }) {
  const source = Object.values(sources || {})[0]
  if (!source) return null
  return (
    <button
      type="button"
      className="flex items-center gap-1 self-start text-[12px] text-ember hover:underline"
      onClick={() => void window.meetingRecorder.openKnowledgeFile?.(source.file)}
      title="Open in your knowledge base"
    >
      <HugeiconsIcon icon={BookOpen01Icon} strokeWidth={1.8} className="size-3" />
      {source.name}
    </button>
  )
}

export function useCoachState() {
  const [state, setState] = useState<CoachState | null>(null)
  useEffect(() => {
    void window.meetingRecorder.coachState().then(setState).catch(() => {})
    return window.meetingRecorder.onCoachState(setState)
  }, [])
  return [state, setState] as const
}

/** The call's goal and checklist in the live view, where you can change them. */
export function LiveCoachPanel() {
  const [state, setState] = useCoachState()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [suggesting, setSuggesting] = useState(false)
  if (!state || !state.enabled.goals) return null
  const done = state.items.filter((item) => item.done).length

  return (
    <section className="flex flex-col gap-2.5" aria-label="Call goal">
      <div className="flex items-center gap-2">
        <h2 className="text-[14px] font-semibold text-foreground">Goal</h2>
        <span className="text-[12px] text-faint">{state.mode.label}</span>
        <Button variant="ghost" size="xs" className="ml-auto text-faint" onClick={() => void window.meetingRecorder.coachShowChip()}>
          Show chip
        </Button>
      </div>
      {editing ? (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void window.meetingRecorder.coachSetGoal(draft).then((next) => next && setState(next))
            setEditing(false)
          }}
        >
          <Input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="What should this call achieve?" className="h-8 text-[13px]" />
          <Button size="sm" type="submit">
            Set
          </Button>
        </form>
      ) : (
        <button
          type="button"
          className="flex items-start gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-left hover:bg-white/[0.04]"
          onClick={() => {
            setDraft(state.goal?.text || "")
            setEditing(true)
          }}
        >
          <HugeiconsIcon icon={Target02Icon} strokeWidth={1.8} className="mt-0.5 size-3.5 shrink-0 text-ember" />
          <span className={cn("text-[13.5px] leading-5", state.goal ? "text-foreground" : "text-faint")}>
            {state.goal?.text || "Working out a goal from your calendar and knowledge base… Click to set your own."}
          </span>
        </button>
      )}
      {state.goal?.why ? <p className="text-[12.5px] leading-5 text-muted-foreground">{state.goal.why}</p> : null}
      <div className="flex items-center gap-2">
        <Source sources={state.goal?.sources} />
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-faint"
          disabled={suggesting}
          onClick={() => {
            setSuggesting(true)
            void window.meetingRecorder
              .coachSuggestGoal()
              .then((next) => next && setState(next))
              .finally(() => setSuggesting(false))
          }}
        >
          {suggesting ? <Spinner className="size-3" /> : null} Suggest again
        </Button>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <h2 className="text-[14px] font-semibold text-foreground">Checklist</h2>
        {state.items.length ? <span className="tabular text-[12px] text-faint">{done}/{state.items.length}</span> : null}
        <Select value={state.framework} onValueChange={(value) => void window.meetingRecorder.coachSetFramework(value).then((next) => next && setState(next))}>
          <SelectTrigger size="sm" className="ml-auto h-7 w-[132px] text-[12px]" aria-label="Framework">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(FRAMEWORK_NAMES).map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {state.items.length ? (
        <ul className="-mx-1.5 flex flex-col">
          {state.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-white/[0.04]"
                onClick={() => void window.meetingRecorder.coachToggleItem(item.id).then((next) => next && setState(next))}
              >
                <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-[4px] border", item.done ? "border-ember bg-ember text-black" : "border-white/25")}>
                  {item.done ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={3} className="size-2.5" /> : null}
                </span>
                <span className={item.done ? "text-faint line-through" : "text-foreground/90"}>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-faint">{state.framework === "custom" ? "Add your checklist in Settings → Coaching." : "Only the goal is tracked."}</p>
      )}
      {state.next ? (
        <div className="flex flex-col gap-1 rounded-lg bg-ember/[0.08] px-3 py-2">
          <p className="text-[11px] font-medium tracking-wide text-ember uppercase">Next</p>
          <p className="text-[13px] leading-5 text-foreground/90">{state.next.text}</p>
          <Source sources={state.next.sources} />
        </div>
      ) : null}
      {state.cue ? <p className="text-[12.5px] text-amber-200">{state.cue.text}</p> : null}
    </section>
  )
}

const VERDICTS: Record<string, { label: string; className: string }> = {
  met: { label: "Goal met", className: "bg-emerald-400/15 text-emerald-300" },
  partly: { label: "Partly met", className: "bg-amber-300/15 text-amber-200" },
  missed: { label: "Goal missed", className: "bg-rec/15 text-rec" },
  none: { label: "Reviewed", className: "bg-white/[0.06] text-muted-foreground" },
}

/** The scorecard of how a call went against its goal, or how a practice call went. */
export function ScorecardView({ card, coaching }: { card: NonNullable<CallCoaching["scorecard"]> | Omit<NonNullable<CallCoaching["scorecard"]>, "at">; coaching?: CallCoaching | null }) {
  const verdict = VERDICTS[card.goal] || VERDICTS.none
  return (
    <div className="flex flex-col gap-3">
      {coaching?.goal ? (
        <p className="flex items-start gap-2 text-[14px] text-foreground">
          <HugeiconsIcon icon={Target02Icon} strokeWidth={1.8} className="mt-1 size-3.5 shrink-0 text-ember" />
          {coaching.goal}
        </p>
      ) : null}
      <div className="flex items-start gap-2.5">
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium", verdict.className)}>{verdict.label}</span>
        <p className="text-[14px] leading-[1.5] text-foreground/90">{card.verdict}</p>
      </div>
      {coaching?.items?.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {coaching.items.map((item) => {
            const covered = coaching.covered.includes(item.id)
            return (
              <li key={item.id} className={cn("rounded-full border px-2 py-0.5 text-[12px]", covered ? "border-ember/40 text-foreground" : "border-border text-faint line-through")}>
                {item.label}
              </li>
            )
          })}
        </ul>
      ) : null}
      {card.wins.length || card.missed.length ? (
        <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
          <div className="flex flex-col gap-1">
            <p className="text-[12px] text-faint">Went well</p>
            {card.wins.map((line) => (
              <p key={line} className="text-[13.5px] leading-5 text-foreground/85">
                {line}
              </p>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-[12px] text-faint">Missed</p>
            {card.missed.map((line) => (
              <p key={line} className="text-[13.5px] leading-5 text-foreground/85">
                {line}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {card.tryNext ? (
        <div className="flex flex-col gap-1 rounded-lg border border-ember/25 bg-ember/[0.06] px-4 py-3">
          <p className="text-[11.5px] font-medium tracking-wide text-ember uppercase">Try next time</p>
          <p className="text-[14px] leading-[1.5] text-foreground">{card.tryNext.text}</p>
          <Source sources={card.sources} />
        </div>
      ) : null}
    </div>
  )
}

/** A call's scorecard, when it had a goal or checklist. */
export function CallScorecard({ meetingId }: { meetingId: string }) {
  const [coaching, setCoaching] = useState<CallCoaching | null>(null)
  useEffect(() => {
    let current = true
    const load = () =>
      void window.meetingRecorder
        .coachCall(meetingId)
        .then((result) => current && setCoaching(result))
        .catch(() => current && setCoaching(null))
    load()
    const off = window.meetingRecorder.onCoachScorecard((change) => change.id === meetingId && load())
    return () => {
      current = false
      off()
    }
  }, [meetingId])
  if (!coaching?.scorecard) return null
  return <ScorecardView card={coaching.scorecard} coaching={coaching} />
}

export function useCoachFocus(refresh: unknown) {
  const [focus, setFocus] = useState<CoachFocusState | null>(null)
  const load = () => void window.meetingRecorder.coachFocus().then(setFocus).catch(() => setFocus(null))
  useEffect(load, [refresh])
  return [focus, load] as const
}

/** This week's focus on Home: what it is, where you are against it, and each call so far. */
export function WeeklyFocus({ refresh, onPractice }: { refresh: unknown; onPractice: () => void }) {
  const [state, reload] = useCoachFocus(refresh)
  if (!state) return null
  const { focus, progress } = state
  const values = progress?.values || []
  // Bars are scaled around the target, so small changes show, with the target as a line across them.
  const target = focus?.id === "talk-less" ? 0.5 : focus?.id === "ask-more" ? 6 : focus?.id === "fewer-fillers" ? 2 : 165
  const lower = focus?.id === "ask-more"
  const all = [...values.map((item) => item.value), target]
  const low = Math.min(...all) * 0.8
  const high = Math.max(...all) * 1.05
  const height = (value: number) => Math.max(4, ((value - low) / (high - low || 1)) * 100)
  const onTarget = (value: number) => (lower ? value >= target : value <= target)
  return (
    <div className="flex items-stretch gap-6 p-5 max-[860px]:flex-col">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex items-center gap-2 text-[14px] font-medium text-muted-foreground">
          <HugeiconsIcon icon={Target02Icon} strokeWidth={1.7} className="size-4" />
          This week's focus
        </p>
        {focus ? (
          <>
            <p className="text-[20px] font-semibold tracking-[-0.015em] text-foreground">{focus.label}</p>
            <p className="text-[13.5px] text-muted-foreground">
              {focus.currentText ? `Now ${focus.currentText}. ` : ""}Aim for {focus.targetText}. Live cues watch for it during calls.
            </p>
            {progress ? (
              <p className="text-[13px] text-faint">
                {progress.met} of {values.length} calls on target
                {progress.trend ? ` · ${progress.trend === "better" ? "getting better" : progress.trend === "worse" ? "slipping" : "holding steady"}` : ""}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[13.5px] text-muted-foreground">{state.chosen === "off" ? "Weekly focus is off." : "Nothing stands out yet. A focus appears once a few calls show a habit worth working on."}</p>
        )}
        <div className="mt-auto flex items-center gap-2 pt-1">
          <Select value={state.chosen} onValueChange={(value) => void window.meetingRecorder.coachSetFocus(value).then(reload)}>
            <SelectTrigger size="sm" className="h-8 w-[200px] text-[12.5px]" aria-label="Weekly focus">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Pick for me</SelectItem>
              {state.choices.map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>
                  {choice.label}
                </SelectItem>
              ))}
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="pill" size="sm" onClick={onPractice}>
            Practise
          </Button>
        </div>
      </div>
      {focus && values.length ? (
        <div className="flex w-[300px] shrink-0 flex-col justify-end gap-1.5 max-[860px]:w-full" aria-label="Each call this week">
          <div className="relative flex h-[88px] items-end gap-1.5">
            <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/40" style={{ bottom: `${height(target)}%` }} aria-hidden />
            {values.slice(-12).map((item) => (
              <div
                key={item.id}
                title={`${item.title || "Call"}: ${focus.id === "talk-less" ? `${Math.round(item.value * 100)}%` : Math.round(item.value * 10) / 10}`}
                className={cn("min-w-[8px] flex-1 rounded-t-[4px]", onTarget(item.value) ? "ember-fill" : "bg-foreground/15")}
                style={{ height: `${height(item.value)}%` }}
              />
            ))}
          </div>
          <p className="text-[11.5px] text-faint">Each call this week, oldest first. Dashed line: {focus.targetText}.</p>
        </div>
      ) : null}
    </div>
  )
}
