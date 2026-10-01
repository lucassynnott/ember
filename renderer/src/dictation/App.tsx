import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, Cancel01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { onLevel } from "./capture"

type PillState = "hidden" | "listening" | "transcribing" | "pasted" | "copied" | "empty" | "cancelled" | "error"

const LABELS: Partial<Record<PillState, string>> = { listening: "Listening", transcribing: "Transcribing" }
const LINES = 9

// The microphone level drawn as emission lines: hairlines whose height follows your voice.
function LevelLines() {
  const lines = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    onLevel((level) => {
      const scaled = Math.min(1, Math.sqrt(level) * 3.2)
      lines.current.forEach((line, index) => {
        if (!line) return
        const shape = 0.35 + 0.65 * Math.sin(((index + 1) / (LINES + 1)) * Math.PI)
        const jitter = 0.75 + Math.random() * 0.5
        line.style.transform = `scaleY(${Math.max(3, 3 + 15 * scaled * shape * jitter) / 18})`
      })
    })
    return () => onLevel(() => {})
  }, [])
  return (
    <span aria-hidden className="flex h-[18px] items-center gap-[3px]">
      {Array.from({ length: LINES }, (_, index) => (
        <span
          key={index}
          ref={(element) => {
            lines.current[index] = element
          }}
          className="h-[18px] w-px origin-center scale-y-[0.17] bg-live transition-transform duration-75 ease-linear"
        />
      ))}
    </span>
  )
}

function Icon({ state }: { state: PillState }) {
  if (state === "listening") return <LevelLines />
  if (state === "transcribing") return <Spinner className="size-3.5 text-foreground/80" />
  const icon =
    state === "pasted" ? Tick02Icon : state === "copied" ? Copy01Icon : state === "error" ? Alert02Icon : Cancel01Icon
  return (
    <HugeiconsIcon
      icon={icon}
      className={cn("size-4", state === "error" ? "text-rec" : state === "pasted" || state === "copied" ? "text-foreground" : "text-muted-foreground")}
      strokeWidth={1.8}
    />
  )
}

export function App() {
  const [pill, setPill] = useState<{ state: PillState; message?: string }>({ state: "hidden" })

  useEffect(() => {
    window.dictation.onState(({ state, message }) => setPill({ state: state as PillState, message }))
  }, [])

  const visible = pill.state !== "hidden"
  const label = pill.message || LABELS[pill.state] || ""

  return (
    <div className="flex h-full items-center justify-center bg-transparent">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex h-10 max-w-[400px] items-center gap-3 rounded-[20px] border border-white/10 bg-background/95 pr-4 pl-3.5 text-[13px] font-medium text-foreground shadow-[0_8px_24px_rgb(0_0_0/0.35)] transition-[opacity,transform] duration-150 ease-out",
          visible ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0",
        )}
      >
        <Icon state={pill.state} />
        <span className="truncate">{label}</span>
      </div>
    </div>
  )
}
