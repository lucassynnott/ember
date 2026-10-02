import { Fragment, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowUp02Icon, StopIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { AskScope, AskTurn, MeetingLibraryState } from "@/types/bridge"

import { errorText, meetingName } from "./meetings"

export interface AskMessage {
  role: "user" | "assistant"
  content: string
  error?: boolean
  pending?: boolean
}

const SUGGESTIONS = [
  "What did I agree to do this week?",
  "Which decisions were made in my last few calls?",
  "What's still open from my most recent call?",
]

// The preload only adds listeners, so route stream pieces by request id from one subscription.
const streams = new Map<string, (delta: string) => void>()
let subscribed = false
function subscribe() {
  if (subscribed) return
  subscribed = true
  window.meetingRecorder.onAskDelta(({ requestId, delta }) => streams.get(requestId)?.(delta))
}

function scopeKey(scope: AskScope) {
  return scope.kind === "folder" || scope.kind === "meeting" ? `${scope.kind}:${scope.id}` : scope.kind
}

function parseScope(key: string): AskScope {
  const [kind, id] = key.split(/:(.*)/s)
  if (kind === "folder" || kind === "meeting") return { kind, id }
  return kind === "unfiled" ? { kind: "unfiled" } : { kind: "all" }
}

/* Answer text: paragraphs, "- " bullets, **bold** and [[meeting]] citations. */

function Inline({
  text,
  library,
  onOpenMeeting,
}: {
  text: string
  library: MeetingLibraryState
  onOpenMeeting: (id: string) => void
}) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[\[[^\]]+\]\])/g)
  return (
    <>
      {parts.map((part, index) => {
        const citation = /^\[\[([^\]]+)\]\]$/.exec(part)
        if (citation) {
          const meeting = library.meetings.find((candidate) => candidate.id === citation[1])
          if (!meeting) return null
          // Several citations in a row read as one group.
          return (
            <button
              key={index}
              type="button"
              onClick={() => onOpenMeeting(meeting.id)}
              className="mx-0.5 inline-flex max-w-[220px] items-center rounded-sm border border-border bg-muted/60 px-1.5 align-[1px] text-[12px] leading-[18px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <span className="truncate">{meetingName(meeting)}</span>
            </button>
          )
        }
        const bold = /^\*\*([^*]+)\*\*$/.exec(part)
        if (bold) return <strong key={index} className="font-semibold text-foreground">{bold[1]}</strong>
        return <Fragment key={index}>{part}</Fragment>
      })}
    </>
  )
}

function AnswerText({
  text,
  library,
  onOpenMeeting,
}: {
  text: string
  library: MeetingLibraryState
  onOpenMeeting: (id: string) => void
}) {
  const blocks: { type: "p" | "ul" | "ol"; lines: string[] }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      blocks.push({ type: "p", lines: [] })
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const type = bullet ? "ul" : numbered ? "ol" : "p"
    const content = bullet?.[1] ?? numbered?.[1] ?? line
    const last = blocks[blocks.length - 1]
    if (last && last.type === type && (type !== "p" || last.lines.length)) last.lines.push(content)
    else blocks.push({ type, lines: [content] })
  }
  const inline = (line: string) => <Inline text={line} library={library} onOpenMeeting={onOpenMeeting} />
  return (
    <div className="flex flex-col gap-2.5 text-[14px] leading-[1.6] text-foreground/90" data-selectable>
      {blocks
        .filter((block) => block.lines.length)
        .map((block, index) =>
          block.type === "p" ? (
            <p key={index}>
              {block.lines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex ? <br /> : null}
                  {inline(line)}
                </Fragment>
              ))}
            </p>
          ) : (
            <ul key={index} className={cn("flex flex-col gap-1.5 pl-5 marker:text-faint", block.type === "ol" ? "list-decimal" : "list-disc")}>
              {block.lines.map((line, lineIndex) => (
                <li key={lineIndex}>{inline(line)}</li>
              ))}
            </ul>
          ),
        )}
    </div>
  )
}

/* Panel */

export function AskSheet({
  open,
  onOpenChange,
  library,
  scope,
  onScopeChange,
  selectedMeetingId,
  messages,
  onMessages,
  model,
  onOpenMeeting,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  library: MeetingLibraryState
  scope: AskScope
  onScopeChange: (scope: AskScope) => void
  selectedMeetingId: string | null
  messages: AskMessage[]
  onMessages: (update: (messages: AskMessage[]) => AskMessage[]) => void
  model: string | null
  onOpenMeeting: (id: string) => void
}) {
  const [draft, setDraft] = useState("")
  const [requestId, setRequestId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const selected = library.meetings.find((meeting) => meeting.id === selectedMeetingId)
  const busy = Boolean(requestId)

  useEffect(subscribe, [])
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages])
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const ask = async (question: string) => {
    const text = question.trim()
    if (!text || busy) return
    const id = crypto.randomUUID()
    const history: AskTurn[] = messages
      .filter((message) => !message.error && !message.pending && message.content)
      .map(({ role, content }) => ({ role, content }))
    setDraft("")
    setRequestId(id)
    onMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: "", pending: true }])
    const updateLast = (change: (message: AskMessage) => AskMessage) =>
      onMessages((current) => current.map((message, index) => (index === current.length - 1 ? change(message) : message)))
    streams.set(id, (delta) => updateLast((message) => ({ ...message, content: message.content + delta })))
    try {
      const result = await window.meetingRecorder.askMeetings(id, { question: text, history, scope })
      updateLast((message) => ({
        ...message,
        pending: false,
        content: result.cancelled ? message.content || "Stopped." : result.text || message.content || "No answer came back. Try asking again.",
      }))
    } catch (failure) {
      updateLast(() => ({ role: "assistant", content: errorText(failure), error: true }))
    } finally {
      streams.delete(id)
      setRequestId(null)
    }
  }

  const scopeOptions = [
    { key: "all", label: "All meetings" },
    ...library.folders.map((folder) => ({ key: `folder:${folder.id}`, label: folder.name })),
    ...(library.folders.length ? [{ key: "unfiled", label: "No folder" }] : []),
    ...(selected ? [{ key: `meeting:${selected.id}`, label: `This meeting: ${meetingName(selected)}` }] : []),
  ]
  const currentKey = scopeOptions.some((option) => option.key === scopeKey(scope)) ? scopeKey(scope) : "all"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[520px] gap-0 p-0 data-[side=right]:sm:max-w-[520px]">
        <SheetHeader className="gap-3 border-b border-border px-6 pt-6 pb-4">
          <SheetTitle className="text-[17px] font-semibold">Ask your meetings</SheetTitle>
          <SheetDescription className="sr-only">Ask questions about past calls. Answers cite the meetings they come from.</SheetDescription>
          <div className="flex items-center gap-2">
            <Select value={currentKey} onValueChange={(key) => onScopeChange(parseScope(key))}>
              <SelectTrigger size="sm" className="max-w-[300px]" aria-label="Which meetings to ask">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopeOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {messages.length ? (
              <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" disabled={busy} onClick={() => onMessages(() => [])}>
                New chat
              </Button>
            ) : null}
          </div>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 px-6 py-5">
            {!messages.length ? (
              <div className="flex flex-col gap-3 pt-2">
                <p className="text-[13px] leading-5 text-muted-foreground">
                  Ask about anything said in your calls. Answers link to the meetings they come from.
                </p>
                <div className="flex flex-col items-start gap-1.5">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button key={suggestion} variant="outline" size="sm" className="h-auto py-1.5 text-left font-normal whitespace-normal" onClick={() => void ask(suggestion)}>
                      {suggestion}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message, index) =>
                message.role === "user" ? (
                  <p key={index} className="self-end rounded-lg bg-accent px-3 py-2 text-[14px] leading-[1.5] text-foreground" data-selectable>
                    {message.content}
                  </p>
                ) : message.error ? (
                  <p key={index} className="text-[14px] leading-[1.5] text-rec">
                    {message.content}
                  </p>
                ) : message.pending && !message.content ? (
                  <p key={index} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Spinner className="size-3.5" /> Reading your meetings…
                  </p>
                ) : (
                  <AnswerText key={index} text={message.content} library={library} onOpenMeeting={onOpenMeeting} />
                ),
              )
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        <div className="flex flex-col gap-2 border-t border-border px-6 pt-4 pb-5">
          <InputGroup>
            <InputGroupTextarea
              ref={inputRef}
              value={draft}
              rows={2}
              placeholder="Ask a question"
              aria-label="Question"
              className="max-h-40 min-h-0 text-[14px]"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void ask(draft)
                }
              }}
            />
            <InputGroupAddon align="block-end" className="justify-end">
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
          <p className="text-[12px] leading-4 text-faint">
            {model ? `Answers come from ${model} on OpenRouter, which receives the notes and transcript passages it needs.` : "Ask needs an OpenRouter key in Settings → AI notes."}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
