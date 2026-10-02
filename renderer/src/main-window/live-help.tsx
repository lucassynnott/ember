import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon, ArrowUp02Icon, BubbleChatQuestionIcon, StopIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { AskTurn, MeetingLibraryState } from "@/types/bridge"

import { AnswerText, streams, subscribe, type AskMessage } from "./ask"
import { errorText } from "./meetings"

const QUICK = ["What should I ask next?", "How do I handle the last objection?", "Sum up the call so far", "What did we agree last time?"]

/**
 * Live help during a call: ask anything about the call so far. Answers use the transcript, your
 * knowledge base and earlier calls with these people, and stay short enough to glance at.
 */
export function LiveHelp({
  library,
  onOpenMeeting,
  shortcut,
}: {
  library: MeetingLibraryState | null
  onOpenMeeting: (id: string) => void
  shortcut?: string | null
}) {
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [draft, setDraft] = useState("")
  const [open, setOpen] = useState(true)
  const [requestId, setRequestId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const busy = Boolean(requestId)
  useEffect(subscribe, [])
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages, open])

  const ask = async (question: string) => {
    const text = question.trim()
    if (!text || busy) return
    const id = crypto.randomUUID()
    const history: AskTurn[] = messages.filter((message) => !message.error && !message.pending && message.content).map(({ role, content }) => ({ role, content }))
    setDraft("")
    setOpen(true)
    setRequestId(id)
    setMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: "", pending: true }])
    const updateLast = (change: (message: AskMessage) => AskMessage) =>
      setMessages((current) => current.map((message, index) => (index === current.length - 1 ? change(message) : message)))
    streams.set(id, (delta) => updateLast((message) => ({ ...message, content: message.content + delta })))
    try {
      const result = await window.meetingRecorder.liveHelp(id, { question: text, history })
      updateLast((message) => ({ ...message, pending: false, sources: result.sources, content: result.text || message.content || "No answer came back." }))
    } catch (failure) {
      updateLast(() => ({ role: "assistant", content: errorText(failure), error: true }))
    } finally {
      streams.delete(id)
      setRequestId(null)
    }
  }

  const state = library || { meetings: [], folders: [], tags: [] }
  const showAnswers = open && messages.length > 0

  return (
    <div className="pointer-events-auto flex w-full flex-col overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur">
      {showAnswers ? (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="text-[12px] font-medium text-gold">Live help</span>
            <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" disabled={busy} onClick={() => setMessages([])}>
              Clear
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Hide answers" className="text-muted-foreground" onClick={() => setOpen(false)}>
              <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
            </Button>
          </div>
          <div className="max-h-[min(42vh,380px)] min-h-0 overflow-y-auto">
            <div className="flex flex-col gap-3 px-4 py-3">
              {messages.map((message, index) =>
                message.role === "user" ? (
                  <p key={index} className="self-end rounded-lg bg-accent px-3 py-1 text-[13px] text-foreground">
                    {message.content}
                  </p>
                ) : message.error ? (
                  <p key={index} className="text-[13px] text-rec">
                    {message.content}
                  </p>
                ) : message.pending && !message.content ? (
                  <p key={index} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Spinner className="size-3.5" /> Reading the call so far…
                  </p>
                ) : (
                  <AnswerText
                    key={index}
                    text={message.content}
                    library={state}
                    onOpenMeeting={onOpenMeeting}
                    sources={message.sources}
                    onOpenSource={(id) => message.sources?.[id] && void window.meetingRecorder.openKnowledgeFile(message.sources[id].file)}
                  />
                ),
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        </>
      ) : null}
      {!messages.length || !open ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {QUICK.map((prompt) => (
            <Button key={prompt} variant="outline" size="xs" className="h-6 rounded-full px-2.5 text-[12px] font-normal" disabled={busy} onClick={() => void ask(prompt)}>
              {prompt}
            </Button>
          ))}
          {shortcut ? <span className="self-center pl-1 text-[11px] text-faint">or press {shortcut} anywhere</span> : null}
          {messages.length && !open ? (
            <Button variant="ghost" size="xs" className="h-6 text-[12px] text-muted-foreground" onClick={() => setOpen(true)}>
              Show answers
            </Button>
          ) : null}
        </div>
      ) : null}
      <InputGroup className={cn("h-11 rounded-none border-0 bg-transparent dark:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0")}>
        <InputGroupAddon className="pl-3">
          <HugeiconsIcon icon={BubbleChatQuestionIcon} strokeWidth={1.8} className="size-4 text-gold" />
        </InputGroupAddon>
        <InputGroupInput
          value={draft}
          placeholder="Ask about this call, e.g. what's their budget?"
          aria-label="Ask about this call"
          className="text-[14px]"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void ask(draft)
            }
          }}
        />
        <InputGroupAddon align="inline-end" className="pr-2">
          {busy ? (
            <InputGroupButton size="icon-sm" variant="secondary" aria-label="Stop" onClick={() => requestId && void window.meetingRecorder.cancelAsk(requestId)}>
              <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
            </InputGroupButton>
          ) : (
            <InputGroupButton size="icon-sm" variant="default" aria-label="Ask" disabled={!draft.trim()} onClick={() => void ask(draft)}>
              <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}
