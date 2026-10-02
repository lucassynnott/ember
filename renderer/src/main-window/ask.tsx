import { Fragment, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowUp02Icon,
  BubbleChatQuestionIcon,
  Cancel01Icon,
  Search01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AskScope, AskTurn, KnowledgeSources, MeetingLibraryState, MeetingSummary } from "@/types/bridge"

import { errorText, meetingName, shortDate } from "./meetings"

export interface AskMessage {
  role: "user" | "assistant"
  content: string
  error?: boolean
  pending?: boolean
  sources?: KnowledgeSources
}


// The preload only adds listeners, so route stream pieces by request id from one subscription.
export const streams = new Map<string, (delta: string) => void>()
let subscribed = false
export function subscribe() {
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
  sources,
  onOpenSource,
}: {
  text: string
  library: MeetingLibraryState
  onOpenMeeting: (id: string) => void
  sources?: KnowledgeSources
  onOpenSource?: (id: string) => void
}) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[\[[^\]]+\]\])/g)
  return (
    <>
      {parts.map((part, index) => {
        const citation = /^\[\[([^\]]+)\]\]$/.exec(part)
        if (citation && citation[1].startsWith("kb:")) {
          const source = sources?.[citation[1]]
          if (!source) return null
          // A passage from your knowledge base: shows the file it came from.
          return (
            <button
              key={index}
              type="button"
              title={source.file}
              onClick={() => onOpenSource?.(citation[1])}
              className="mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded-sm border border-gold/35 bg-gold-soft px-1.5 align-[1px] text-[12px] leading-[18px] text-foreground/80 transition-colors hover:border-gold/70 hover:text-foreground"
            >
              <span aria-hidden className="text-gold">◆</span>
              <span className="truncate">{source.name.replace(/\.[a-z0-9]+$/i, "")}</span>
            </button>
          )
        }
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

export function AnswerText({
  text,
  library,
  onOpenMeeting,
  sources,
  onOpenSource,
}: {
  text: string
  library: MeetingLibraryState
  onOpenMeeting: (id: string) => void
  sources?: KnowledgeSources
  onOpenSource?: (id: string) => void
}) {
  const blocks: { type: "p" | "ul" | "ol" | "h"; lines: string[] }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      blocks.push({ type: "p", lines: [] })
      continue
    }
    const heading = /^#{1,3}\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: "h", lines: [heading[1]] })
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
  const inline = (line: string) => (
    <Inline text={line} library={library} onOpenMeeting={onOpenMeeting} sources={sources} onOpenSource={onOpenSource} />
  )
  return (
    <div className="flex min-w-0 flex-col gap-2.5 text-[14px] leading-[1.6] [overflow-wrap:anywhere] text-foreground/90" data-selectable>
      {blocks
        .filter((block) => block.lines.length)
        .map((block, index) =>
          block.type === "h" ? (
            <h3 key={index} className="pt-2 text-[14px] font-semibold text-foreground first:pt-0">
              {inline(block.lines[0])}
            </h3>
          ) : block.type === "p" ? (
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

/* Conversation state */

export function citedIds(text: string) {
  return [...new Set([...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]))]
}

export function useAsk(scope: AskScope) {
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [requestId, setRequestId] = useState<string | null>(null)
  const busy = Boolean(requestId)
  useEffect(subscribe, [])

  const ask = async (question: string) => {
    const text = question.trim()
    if (!text || busy) return
    const id = crypto.randomUUID()
    const history: AskTurn[] = messages
      .filter((message) => !message.error && !message.pending && message.content)
      .map(({ role, content }) => ({ role, content }))
    setRequestId(id)
    setMessages((current) => [...current, { role: "user", content: text }, { role: "assistant", content: "", pending: true }])
    const updateLast = (change: (message: AskMessage) => AskMessage) =>
      setMessages((current) => current.map((message, index) => (index === current.length - 1 ? change(message) : message)))
    streams.set(id, (delta) => updateLast((message) => ({ ...message, content: message.content + delta })))
    try {
      const result = await window.meetingRecorder.askMeetings(id, { question: text, history, scope })
      updateLast((message) => ({
        ...message,
        pending: false,
        sources: result.sources,
        content: result.cancelled ? message.content || "Stopped." : result.text || message.content || "No answer came back. Try asking again.",
      }))
    } catch (failure) {
      updateLast(() => ({ role: "assistant", content: errorText(failure), error: true }))
    } finally {
      streams.delete(id)
      setRequestId(null)
    }
  }

  return {
    messages,
    busy,
    ask,
    stop: () => requestId && void window.meetingRecorder.cancelAsk(requestId),
    reset: () => setMessages([]),
  }
}

/* Calls behind an answer */

export function RelevantCalls({
  ids,
  library,
  selectedId,
  onOpenMeeting,
  onShowInList,
}: {
  ids: string[]
  library: MeetingLibraryState
  selectedId: string | null
  onOpenMeeting: (id: string) => void
  onShowInList?: (ids: string[]) => void
}) {
  const calls = ids.map((id) => library.meetings.find((meeting) => meeting.id === id)).filter(Boolean) as MeetingSummary[]
  if (!calls.length) return null
  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-border bg-background/40 p-1.5">
      <div className="flex items-center justify-between px-2 pt-1">
        <h3 className="text-[12px] font-medium text-muted-foreground">
          {calls.length === 1 ? "1 call in this answer" : `${calls.length} calls in this answer`}
        </h3>
        {calls.length > 1 && onShowInList ? (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => onShowInList(calls.map((call) => call.id))}>
            Show these in the list
          </Button>
        ) : null}
      </div>
      {calls.map((call) => (
        <div
          key={call.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpenMeeting(call.id)}
          onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onOpenMeeting(call.id)}
          className={cn(
            "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent",
            call.id === selectedId && "bg-accent",
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{meetingName(call)}</span>
              <span className="tabular shrink-0 text-[12px] text-faint">{shortDate(call)}</span>
            </span>
            {call.preview ? <span className="truncate text-[12px] text-muted-foreground">{call.preview}</span> : null}
          </span>
          <Button
            variant="secondary"
            size="xs"
            className="shrink-0"
            onClick={(event) => {
              event.stopPropagation()
              onOpenMeeting(call.id)
            }}
          >
            Open meeting note
          </Button>
        </div>
      ))}
    </section>
  )
}

/* Floating search and ask bar */

export type SearchMode = "search" | "ask"

export function SearchBar({
  library,
  mode,
  onModeChange,
  query,
  onQueryChange,
  collapsed,
  onCollapsedChange,
  chat,
  scope,
  onScopeChange,
  selectedMeetingId,
  model,
  onOpenMeeting,
  onShowInList,
  inputRef,
}: {
  library: MeetingLibraryState
  mode: SearchMode
  onModeChange: (mode: SearchMode) => void
  query: string
  onQueryChange: (query: string) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  chat: ReturnType<typeof useAsk>
  scope: AskScope
  onScopeChange: (scope: AskScope) => void
  selectedMeetingId: string | null
  model: string | null
  onOpenMeeting: (id: string) => void
  onShowInList: (ids: string[]) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [draft, setDraft] = useState("")
  const [chatOpen, setChatOpen] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const selected = library.meetings.find((meeting) => meeting.id === selectedMeetingId)
  const { messages, busy } = chat
  const showChat = mode === "ask" && chatOpen && messages.length > 0

  useEffect(() => {
    if (showChat) bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages, showChat])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    setChatOpen(true)
    void chat.ask(text)
  }

  const scopeOptions = [
    { key: "all", label: "All meetings" },
    ...library.folders.map((folder) => ({ key: `folder:${folder.id}`, label: folder.name })),
    ...(library.folders.length ? [{ key: "unfiled", label: "No folder" }] : []),
    ...(selected ? [{ key: `meeting:${selected.id}`, label: `This meeting: ${meetingName(selected)}` }] : []),
  ]
  const currentKey = scopeOptions.some((option) => option.key === scopeKey(scope)) ? scopeKey(scope) : "all"

  const modeButton = (value: SearchMode, label: string, shortcut: string, icon: typeof Search01Icon) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToggleGroupItem
          value={value}
          aria-label={label}
          className="size-8 rounded-md p-0 text-muted-foreground aria-checked:bg-foreground/15 aria-checked:text-foreground"
        >
          <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-4" />
        </ToggleGroupItem>
      </TooltipTrigger>
      <TooltipContent>
        {label} · {shortcut}
      </TooltipContent>
    </Tooltip>
  )

  if (collapsed) {
    return (
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-popover/95 p-1 shadow-lg backdrop-blur">
        {(
          [
            ["search", "Search", "⌘F", Search01Icon],
            ["ask", "Ask AI", "⌘K", BubbleChatQuestionIcon],
          ] as const
        ).map(([value, label, shortcut, icon]) => (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={label}
                className="size-9 rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onModeChange(value)
                  onCollapsedChange(false)
                }}
              >
                <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {label} · {shortcut}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    )
  }

  return (
    <div className="pointer-events-auto flex w-full flex-col overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur">
      {showChat ? (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Select value={currentKey} onValueChange={(key) => onScopeChange(parseScope(key))}>
              <SelectTrigger size="sm" className="h-7 max-w-[280px] text-[12px]" aria-label="Which meetings to ask">
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
            <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" disabled={busy} onClick={chat.reset}>
              New chat
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Hide answers" className="text-muted-foreground" onClick={() => setChatOpen(false)}>
              <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
            </Button>
          </div>
          <ScrollArea className="max-h-[min(56vh,520px)] [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="flex flex-col gap-4 px-4 py-4">
              {messages.map((message, index) =>
                message.role === "user" ? (
                  <p key={index} className="self-end rounded-lg bg-accent px-3 py-1.5 text-[13px] leading-[1.5] text-foreground" data-selectable>
                    {message.content}
                  </p>
                ) : message.error ? (
                  <p key={index} className="text-[13px] leading-[1.5] text-rec">
                    {message.content}
                  </p>
                ) : message.pending && !message.content ? (
                  <p key={index} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Spinner className="size-3.5" /> Reading your meetings…
                  </p>
                ) : (
                  <div key={index} className="flex flex-col gap-3">
                    <AnswerText
                      text={message.content}
                      library={library}
                      onOpenMeeting={onOpenMeeting}
                      sources={message.sources}
                      onOpenSource={(id) => message.sources?.[id] && void window.meetingRecorder.openKnowledgeFile(message.sources[id].file)}
                    />
                    {!message.pending ? (
                      <RelevantCalls
                        ids={citedIds(message.content)}
                        library={library}
                        selectedId={selectedMeetingId}
                        onOpenMeeting={onOpenMeeting}
                        onShowInList={onShowInList}
                      />
                    ) : null}
                  </div>
                ),
              )}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        </>
      ) : null}

      <InputGroup className={cn("h-12 rounded-none border-0 bg-transparent dark:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0", showChat && "border-t border-border")}>
        <InputGroupAddon className="pl-2">
          <ToggleGroup
            type="single"
            size="sm"
            value={mode}
            onValueChange={(value) => {
              if (!value) return
              onModeChange(value as SearchMode)
              inputRef.current?.focus()
            }}
            className="gap-0.5"
            aria-label="Search or ask"
          >
            {modeButton("search", "Search", "⌘F", Search01Icon)}
            {modeButton("ask", "Ask AI", "⌘K", BubbleChatQuestionIcon)}
          </ToggleGroup>
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          value={mode === "search" ? query : draft}
          className="pl-2 text-[14px]"
          onChange={(event) => (mode === "search" ? onQueryChange(event.target.value) : setDraft(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              const value = mode === "search" ? query : draft
              if (value) {
                if (mode === "search") onQueryChange("")
                else setDraft("")
              } else if (showChat) setChatOpen(false)
              else onCollapsedChange(true)
            }
            if (event.key === "Enter" && mode === "ask" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={
            mode === "search"
              ? "Search transcripts and notes"
              : model
                ? "Ask about your calls, e.g. which call covered pricing?"
                : "Add an OpenRouter key in Settings to ask about your calls"
          }
          aria-label={mode === "search" ? "Search meetings" : "Ask about your meetings"}
        />
        <InputGroupAddon align="inline-end" className="gap-1 pr-2">
          {mode === "search" && query ? (
            <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onQueryChange("")}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </InputGroupButton>
          ) : null}
          {mode === "ask" && messages.length && !showChat ? (
            <InputGroupButton size="xs" className="text-muted-foreground" onClick={() => setChatOpen(true)}>
              Show answers
            </InputGroupButton>
          ) : null}
          {mode === "ask" ? (
            busy ? (
              <InputGroupButton size="icon-sm" variant="secondary" aria-label="Stop" onClick={chat.stop}>
                <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
              </InputGroupButton>
            ) : (
              <InputGroupButton size="icon-sm" variant="default" aria-label="Ask" disabled={!draft.trim()} onClick={submit}>
                <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} />
              </InputGroupButton>
            )
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <InputGroupButton size="icon-xs" aria-label="Collapse" className="text-muted-foreground" onClick={() => onCollapsedChange(true)}>
                <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent>Collapse · Esc</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
      {mode === "ask" && model && !messages.length ? (
        <p className="border-t border-border px-4 py-2 text-[11px] leading-4 text-faint">
          Answers come from {model} on OpenRouter, which receives the notes and transcript passages it needs. Each answer links to the calls it used.
        </p>
      ) : null}
    </div>
  )
}
