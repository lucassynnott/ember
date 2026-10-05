import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

import { STEP_SCENES, StepFigure } from "./StepFigure"

const SCENES = [
  { key: "reel", title: "Your calls", text: "Recorded, transcribed and written up on this Mac" },
  { key: "waveform", title: "Your voice", text: "Hold a key and speak to type in any app" },
  { key: "catalogue", title: "What you keep", text: "Clipboard, screen text and saved pages, in boards" },
]
const SCENE_MS = 6500

/** The welcome's figures: each plays on its own, the next comes on after a while, and hovering holds one to play with. */
export function WelcomeFigures() {
  const [index, setIndex] = useState(0)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % SCENES.length), SCENE_MS)
    return () => window.clearTimeout(timer)
  }, [index, held])
  const scene = SCENES[index]

  return (
    <figure className="flex w-full flex-col gap-5" aria-label="What Ember does">
      <div onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
        <StepFigure key={scene.key} scene={STEP_SCENES[scene.key]} />
      </div>
      <div className="flex flex-col" role="tablist" aria-label="Scenes">
        {SCENES.map((entry, k) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={k === index}
            className={cn("flex flex-col gap-0.5 border-l-2 py-2 pl-3 text-left transition-colors", k === index ? "border-ember" : "border-border hover:border-white/25")}
            onClick={() => setIndex(k)}
          >
            <span className={cn("text-[13px] font-medium", k === index ? "text-foreground" : "text-muted-foreground")}>{entry.title}</span>
            <span className="text-[12px] leading-[1.4] text-faint">{entry.text}</span>
          </button>
        ))}
      </div>
    </figure>
  )
}
