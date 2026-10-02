import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, Cancel01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

import { onLevel } from "./capture"

type PillState = "hidden" | "listening" | "transcribing" | "pasted" | "copied" | "empty" | "cancelled" | "error"

const LABELS: Partial<Record<PillState, string>> = { listening: "Listening", transcribing: "Transcribing" }
const BARS = 13

// Speech sits roughly between -55 dB (quiet room) and -15 dB (talking close to the mic).
function loudness(rms: number) {
  const db = 20 * Math.log10(Math.max(rms, 1e-5))
  return Math.min(1, Math.max(0, (db + 55) / 40))
}

// The microphone level as emission lines. Every bar moves on each frame: a small ripple while it's
// quiet, so you can see it's live, and tall, uneven strokes when it hears you.
function LevelLines() {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let target = 0
    let level = 0
    let frame = 0
    const started = performance.now()
    onLevel((rms) => {
      target = loudness(rms)
    })
    const draw = (now: number) => {
      // Rise fast, fall slower, like a VU meter.
      level += (target - level) * (target > level ? 0.45 : 0.1)
      const t = (now - started) / 1000
      const middle = (BARS - 1) / 2
      bars.current.forEach((bar, index) => {
        if (!bar) return
        const centre = 1 - Math.abs(index - middle) / middle
        const envelope = 0.4 + 0.6 * centre
        const motion = reduced ? 1 : 0.55 + 0.45 * Math.sin(t * 11 + index * 1.9) * Math.cos(t * 6.7 + index * 0.8)
        const idle = reduced ? 0.14 : 0.14 + 0.07 * Math.sin(t * 3.2 + index * 0.7)
        const height = idle + (1 - idle) * level * envelope * motion
        bar.style.transform = `scaleY(${Math.min(1, Math.max(0.1, height)).toFixed(3)})`
        bar.style.opacity = String(0.55 + 0.45 * Math.min(1, level * 1.6 + 0.2))
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      onLevel(() => {})
    }
  }, [])
  return (
    <span aria-hidden className="flex h-6 items-center gap-[3px]">
      {Array.from({ length: BARS }, (_, index) => (
        <span
          key={index}
          ref={(element) => {
            bars.current[index] = element
          }}
          className="h-6 w-[2px] origin-center rounded-full bg-live"
          style={{ transform: "scaleY(0.14)" }}
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
