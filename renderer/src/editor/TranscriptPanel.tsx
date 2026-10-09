import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { pauseCuts, type Levels } from "./levels"
import { cutSourceRanges, editedDuration, toEdited, toSource, type EditProject } from "./model"
import type { Selection } from "./Timeline"
import { fillerSpans, isFiller, type Word } from "./transcript"

type Change = (next: EditProject | ((current: EditProject) => EditProject), options?: { live?: boolean }) => void

export interface WordsState {
  status: "idle" | "loading" | "ready" | "error"
  words: (Word & { line: number })[]
  timing: "parakeet" | "aligned" | null
  progress: number
  error?: string
  model: { available: boolean; installing: boolean }
}

const PAUSES = [0.5, 0.75, 1, 1.5, 2]

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`

/**
 * The recording's words, to edit the video by: click a word to go there, drag across words to select them, ⌫ to
 * cut them (or put cut ones back). Fillers and long pauses go in one click each.
 */
export function TranscriptPanel({
  project,
  change,
  state,
  levels,
  time,
  selection,
  onSelect,
  onSeek,
  onLoad,
  onRetime,
  onInstallModel,
  onCutSelection,
  duration,
}: {
  project: EditProject
  change: Change
  state: WordsState
  levels: Levels | null
  time: number
  selection: Selection
  onSelect: (selection: Selection) => void
  onSeek: (edited: number) => void
  onLoad: () => void
  onRetime: () => void
  onInstallModel: () => void
  onCutSelection: () => void
  duration: number
}) {
  useEffect(() => {
    if (state.status === "idle") onLoad()
  }, [state.status, onLoad])

  const { words } = state
  const kept = useMemo(() => words.map((word) => toEdited(project, (word.start + word.end) / 2) !== null), [words, project])
  const now = toSource(project, time)
  const current = words.findIndex((word) => now >= word.start && now < word.end)
  const range = selection?.kind === "words" ? [Math.min(selection.first, selection.last), Math.max(selection.first, selection.last)] : null

  // Fillers still in the video, and pauses longer than the chosen length.
  const keptAt = (source: number) => toEdited(project, source) !== null
  const fillers = useMemo(() => fillerSpans(words, levels).filter(([start, end]) => keptAt((start + end) / 2)), [words, levels, project]) // eslint-disable-line react-hooks/exhaustive-deps
  const [pause, setPause] = useState(() => Number(localStorage.getItem("ember.editor.pause") || 1))
  const pauses = useMemo(() => (levels ? pauseCuts(levels, pause, 0.3).filter(([start, end]) => keptAt((start + end) / 2)) : []), [levels, pause, project]) // eslint-disable-line react-hooks/exhaustive-deps
  const pauseSeconds = pauses.reduce((sum, [start, end]) => sum + end - start, 0)
  const cutSeconds = Math.max(0, duration - editedDuration(project))

  // Follows the word being played, unless you've just scrolled the transcript yourself.
  const scroller = useRef<HTMLDivElement>(null)
  const scrolledAt = useRef(0)
  useEffect(() => {
    if (current < 0 || Date.now() - scrolledAt.current < 3000) return
    const element = scroller.current?.querySelector(`[data-word="${current}"]`) as HTMLElement | null
    element?.scrollIntoView({ block: "nearest" })
  }, [current])

  // Selecting by dragging across words.
  const dragging = useRef<number | null>(null)
  useEffect(() => {
    const up = () => (dragging.current = null)
    window.addEventListener("pointerup", up)
    return () => window.removeEventListener("pointerup", up)
  }, [])

  const paragraphs = useMemo(() => {
    const groups: { line: number; indexes: number[] }[] = []
    words.forEach((word, index) => {
      const last = groups[groups.length - 1]
      if (last && last.line === word.line) last.indexes.push(index)
      else groups.push({ line: word.line, indexes: [index] })
    })
    return groups
  }, [words])

  if (state.status === "loading" || state.status === "idle") {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="flex items-center gap-2 text-[13px]">
          <Spinner className="size-3.5 text-ember" /> Timing every word…
        </p>
        <Progress value={Math.round(state.progress * 100)} />
        <p className="text-[12px] text-faint">{state.model.available ? "Parakeet is listening to the recording again for each word's exact timing." : "Lining the words up with the speech in the recording."}</p>
      </div>
    )
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        <p className="text-rec">{state.error || "The words couldn't be timed."}</p>
        <Button variant="pill" size="sm" className="self-start" onClick={onLoad}>
          Try again
        </Button>
      </div>
    )
  }
  if (!words.length) {
    return <p className="p-4 text-[13px] text-muted-foreground">This recording has no transcript yet. It appears here once it's been written up.</p>
  }

  const selectedKept = range ? kept.slice(range[0], range[1] + 1).some(Boolean) : false

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2.5 border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="pill"
            size="sm"
            disabled={!fillers.length}
            onClick={() => change((value) => cutSourceRanges(value, fillers))}
            title="Cut every um, uh, er and ah"
          >
            Remove {fillers.length || ""} {fillers.length === 1 ? "um or ah" : "ums and ahs"}
          </Button>
          <div className="flex items-center gap-1.5">
            <Button
              variant="pill"
              size="sm"
              disabled={!pauses.length}
              onClick={() => change((value) => cutSourceRanges(value, pauses))}
              title={pauses.length ? `Shortens ${pauses.length} pauses, saving ${pauseSeconds.toFixed(1)} s` : "No pauses that long"}
            >
              Shorten {pauses.length || ""} pauses
            </Button>
            <Select
              value={String(pause)}
              onValueChange={(value) => {
                setPause(Number(value))
                localStorage.setItem("ember.editor.pause", value)
              }}
            >
              <SelectTrigger size="sm" className="h-8 w-[92px]" aria-label="Pauses longer than">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAUSES.map((seconds) => (
                  <SelectItem key={seconds} value={String(seconds)}>
                    over {seconds} s
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-[12px] text-faint">
          {cutSeconds > 0.05 ? `${clock(cutSeconds)} cut · ` : ""}
          Click a word to go there, drag across words and press <Kbd>⌫</Kbd> to cut them.
        </p>
        {state.timing === "aligned" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-2.5 py-2 text-[12px] text-muted-foreground">
            <span className="min-w-0 flex-1">
              {state.model.available ? "Word timings are approximate. Parakeet can time them exactly." : "Word timings are approximate. Parakeet (670 MB, on this Mac) times every word exactly."}
            </span>
            {state.model.available ? (
              <Button variant="pill" size="sm" className="shrink-0" onClick={onRetime}>
                Time exactly
              </Button>
            ) : (
              <Button variant="pill" size="sm" className="shrink-0" disabled={state.model.installing} onClick={onInstallModel}>
                {state.model.installing ? <Spinner /> : null} {state.model.installing ? "Downloading…" : "Download"}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {range ? (
        <div className="flex items-center gap-2 border-b border-border bg-ember/[0.06] px-4 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1">
            {range[1] - range[0] + 1} {range[1] === range[0] ? "word" : "words"} selected
          </span>
          <Button size="sm" variant={selectedKept ? "destructive" : "pill"} className="h-7" onClick={onCutSelection}>
            {selectedKept ? "Cut" : "Restore"} <Kbd>⌫</Kbd>
          </Button>
        </div>
      ) : null}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 select-none" onWheel={() => (scrolledAt.current = Date.now())}>
        {paragraphs.map((paragraph) => (
          <p key={paragraph.indexes[0]} className="mb-3 text-[14px] leading-[1.75]">
            {paragraph.indexes.map((index) => {
              const word = words[index]
              const isKept = kept[index]
              const selected = range && index >= range[0] && index <= range[1]
              return (
                <span key={index}>
                  <span
                    data-word={index}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      if (event.shiftKey && selection?.kind === "words") {
                        onSelect({ kind: "words", first: selection.first, last: index })
                        return
                      }
                      dragging.current = index
                      onSelect({ kind: "words", first: index, last: index })
                      const at = toEdited(project, word.start)
                      if (at !== null) onSeek(at)
                    }}
                    onPointerEnter={() => {
                      if (dragging.current !== null) onSelect({ kind: "words", first: dragging.current, last: index })
                    }}
                    className={cn(
                      "cursor-pointer rounded-[3px] px-[1px] transition-colors",
                      !isKept && "text-faint line-through decoration-ember/70",
                      isKept && isFiller(word.text) && "underline decoration-amber-300/70 decoration-dotted underline-offset-4",
                      index === current && isKept && "bg-white/[0.12] text-foreground",
                      selected && "bg-ember/30 text-foreground",
                      !selected && index !== current && "hover:bg-white/[0.06]",
                    )}
                  >
                    {word.text}
                  </span>{" "}
                </span>
              )
            })}
          </p>
        ))}
      </div>
    </div>
  )
}
