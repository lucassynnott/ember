import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { BubbleChatQuestionIcon, Calendar03Icon, Cancel01Icon, Idea01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { KnowledgeSources, MeetingLibraryState, MeetingSummary } from "@/types/bridge"

import { AnswerText, RelevantCalls, citedIds } from "../main-window/ask"

interface CardState {
  kind?: "ask" | "prep" | "live" | "nudge"
  question?: string
  text?: string
  status?: "answering" | "done" | "error"
  join?: { url: string; label: string } | null
  sources?: KnowledgeSources
  error?: string
  meetings?: MeetingSummary[]
}

// The answer to a question asked out loud, floating above the dictation pill.
export function App() {
  const [state, setState] = useState<CardState>({})
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.askCard.onState((next) => setState(next as CardState))
  }, [])

  // The window follows the card's height, up to a limit; longer answers scroll.
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    // The window is the card plus a 24 px margin each side, so the glow isn't clipped.
    const report = () => window.askCard.resize(Math.ceil(card.getBoundingClientRect().height) + 48)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(card)
    return () => observer.disconnect()
  }, [])

  const library: MeetingLibraryState = { meetings: state.meetings || [], folders: [], tags: [] }
  const open = (id: string) => window.askCard.openMeeting(id)
  const cited = state.status === "done" ? citedIds(state.text || "") : []

  return (
    <div className="flex h-full items-end justify-center bg-transparent p-6">
      <div ref={cardRef} className="relative w-full rounded-xl">
      <div aria-hidden className="silver-glow" />
      <div className="silver-border flex max-h-[516px] flex-col overflow-hidden rounded-[inherit] text-foreground shadow-[0_12px_32px_rgb(0_0_0/0.45)]">
        <header className="flex items-start gap-2.5 border-b border-border px-4 py-3">
          <HugeiconsIcon
            icon={state.kind === "prep" ? Calendar03Icon : state.kind === "nudge" ? Idea01Icon : BubbleChatQuestionIcon}
            strokeWidth={1.8}
            className={cn("mt-0.5 size-4 shrink-0", state.kind === "live" || state.kind === "nudge" ? "text-ember" : "text-muted-foreground")}
          />
          {state.kind === "live" ? <span className="shrink-0 pt-px text-[12px] font-medium text-ember">Live help</span> : null}
          {state.kind === "nudge" ? <span className="shrink-0 pt-px text-[12px] font-medium text-ember">Tip</span> : null}
          <p className={cn("line-clamp-2 flex-1 text-[13px] leading-5 text-foreground/90", (state.kind === "prep" || state.kind === "nudge") && "font-medium")}>
            {state.question}
          </p>
          {state.join ? (
            <Button size="xs" className="-mt-0.5 shrink-0" onClick={() => window.askCard.join()}>
              {state.join.label}
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-xs" aria-label="Close" className="-mt-0.5 text-muted-foreground" onClick={() => window.askCard.close()}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </header>
        {/* A plain scroller: the ScrollArea viewport lays out as a table and stops text wrapping. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="flex flex-col gap-3 px-4 py-3.5">
            {state.status === "error" ? (
              <p className="text-[13px] leading-5 text-rec">{state.error}</p>
            ) : state.text ? (
              <AnswerText text={state.text} library={library} onOpenMeeting={open} sources={state.sources} onOpenSource={(id) => window.askCard.openSource(id)} />
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner className="size-3.5" />{" "}
                {state.kind === "prep" ? "Reading your last calls with them…" : state.kind === "live" ? "Reading the call so far…" : "Reading your meetings…"}
              </p>
            )}
            {cited.length && state.kind !== "nudge" ? <RelevantCalls ids={cited} library={library} selectedId={null} onOpenMeeting={open} /> : null}
          </div>
        </div>
        {state.kind === "nudge" ? (
          <footer className="flex items-center gap-1 border-t border-border px-2 py-1">
            <Button variant="ghost" size="xs" className="text-ember" onClick={() => window.askCard.action("nudge:more")}>
              More
            </Button>
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => window.askCard.close()}>
              Not now
            </Button>
            <Button variant="ghost" size="xs" className="ml-auto text-faint" onClick={() => window.askCard.action("nudge:off")}>
              No more tips this call
            </Button>
          </footer>
        ) : (
          <footer className="border-t border-border px-4 py-1.5 text-[11px] text-faint">Esc to close · Click a call to open it</footer>
        )}
      </div>
      </div>
    </div>
  )
}
