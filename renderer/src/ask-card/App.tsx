import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { BubbleChatQuestionIcon, Cancel01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { MeetingLibraryState, MeetingSummary } from "@/types/bridge"

import { AnswerText, RelevantCalls, citedIds } from "../main-window/ask"

interface CardState {
  question?: string
  text?: string
  status?: "answering" | "done" | "error"
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
    const report = () => window.askCard.resize(Math.ceil(card.getBoundingClientRect().height) + 2)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(card)
    return () => observer.disconnect()
  }, [])

  const library: MeetingLibraryState = { meetings: state.meetings || [], folders: [], tags: [] }
  const open = (id: string) => window.askCard.openMeeting(id)
  const cited = state.status === "done" ? citedIds(state.text || "") : []

  return (
    <div className="flex h-full items-end justify-center bg-transparent">
      <div
        ref={cardRef}
        className="flex max-h-[516px] w-full flex-col overflow-hidden rounded-xl border border-white/10 bg-popover/97 text-foreground shadow-[0_12px_32px_rgb(0_0_0/0.45)]"
      >
        <header className="flex items-start gap-2.5 border-b border-border px-4 py-3">
          <HugeiconsIcon icon={BubbleChatQuestionIcon} strokeWidth={1.8} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="line-clamp-2 flex-1 text-[13px] leading-5 text-foreground/90">{state.question}</p>
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
              <AnswerText text={state.text} library={library} onOpenMeeting={open} />
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner className="size-3.5" /> Reading your meetings…
              </p>
            )}
            {cited.length ? <RelevantCalls ids={cited} library={library} selectedId={null} onOpenMeeting={open} /> : null}
          </div>
        </div>
        <footer className="border-t border-border px-4 py-1.5 text-[11px] text-faint">Esc to close · Click a call to open it</footer>
      </div>
    </div>
  )
}
