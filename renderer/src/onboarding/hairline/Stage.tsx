import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

import { catalogue } from "./catalogue.js"
import { HL } from "./kernel.js"
import { reel } from "./reel.js"
import type { HairlineFigure } from "./types"
import { waveform } from "./waveform.js"

/** One figure, mounted as the Hairline bench mounts it: a stage, its svg, and a read-out it writes to. */
function Figure({ figure, onRead }: { figure: HairlineFigure; onRead: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const stage = ref.current
    if (!stage) return
    HL.inject(document)
    const svg = HL.mk("svg", { viewBox: "0 0 400 320", "aria-hidden": "true" }, stage) as SVGSVGElement
    const read = document.createElement("span")
    const watch = new MutationObserver(() => onRead(read.textContent || ""))
    watch.observe(read, { childList: true, characterData: true, subtree: true })
    const handle = figure.mount({ stage, svg, read }, figure.range[1])
    onRead(read.textContent || "")
    return () => {
      watch.disconnect()
      handle.destroy()
      svg.remove()
    }
  }, [figure, onRead])
  return <div ref={ref} data-hairline={figure.name} role="img" aria-label={figure.means} className="onb-figure-in w-full" />
}

const SCENES: { figure: HairlineFigure; title: string; text: string }[] = [
  { figure: reel, title: "Your calls", text: "Recorded, transcribed and written up on this Mac" },
  { figure: waveform, title: "Your voice", text: "Hold a key and speak to type in any app" },
  { figure: catalogue, title: "What you keep", text: "Clipboard, screen text and saved pages, in boards" },
]
const SCENE_MS = 6500

/** The welcome's figures: each plays on its own, the next comes on after a while, and hovering holds one to play with. */
export function WelcomeFigures() {
  const [index, setIndex] = useState(0)
  const [readout, setReadout] = useState("")
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % SCENES.length), SCENE_MS)
    return () => window.clearTimeout(timer)
  }, [index, held])
  const scene = SCENES[index]

  return (
    <figure className="flex flex-col gap-3" aria-label="What Ember does">
      <div
        className="relative mx-auto -my-4 w-full max-w-[380px]"
        style={
          {
            "--hairline-plate": "var(--background)",
            "--hairline-hi": "var(--ember)",
            "--hairline-edge": "rgb(255 255 255 / 66%)",
            "--hairline-mid": "rgb(255 255 255 / 34%)",
            "--hairline-lo": "rgb(255 255 255 / 15%)",
            "--hairline-stroke": "1",
          } as React.CSSProperties
        }
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
      >
        <Figure key={scene.figure.name} figure={scene.figure} onRead={setReadout} />
        {readout && readout !== "rest" ? (
          <span className="tabular pointer-events-none absolute top-6 right-3 font-mono text-[11px] text-faint">{readout}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Scenes">
        {SCENES.map((entry, k) => (
          <button
            key={entry.title}
            type="button"
            role="tab"
            aria-selected={k === index}
            className={cn(
              "flex flex-col gap-0.5 border-t-2 pt-2 text-left transition-colors",
              k === index ? "border-ember" : "border-border hover:border-white/25",
            )}
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
