import { useEffect, useRef, useState } from "react"
import { dish, exploded, keyboard, laptop, padlock, patch, phosphor, riffle, terminal } from "@lucasmarkes/hairline"

import { catalogue } from "./catalogue.js"
import { HL } from "./kernel.js"
import { reel } from "./reel.js"
import type { HairlineFigure } from "./types"
import { waveform } from "./waveform.js"

type Point = [number, number] | null
/** Where the virtual pointer is t seconds in, in the figure's 400 × 320 viewBox; null is away (the figure rests). */
type Path = (t: number) => Point

/** Starts a figure in an element and returns its tear-down. */
type Start = (el: HTMLElement, onRead: (text: string) => void) => () => void

export interface Scene {
  start: Start
  /** For figures that only answer the pointer: a gentle path it follows while nobody is hovering. */
  path?: Path
  label: string
}

/** One of Ember's own figures, mounted the way the Hairline bench mounts one. */
function own(figure: HairlineFigure): Start {
  return (stage, onRead) => {
    HL.inject(document)
    stage.setAttribute("data-hairline", figure.name)
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
  }
}

/** One of the package's nineteen. */
function pkg(make: (el: HTMLElement, options: { intensity: number; theme: "dark"; onRead: (text: string) => void }) => { destroy(): void }): Start {
  return (el, onRead) => {
    const figure = make(el, { intensity: 0.6, theme: "dark", onRead })
    return () => figure.destroy()
  }
}

// Paths: each cycle drifts for a while, then rests for a moment so the resting composition shows too.
const CYCLE = 11, AWAY = 2.2
const away = (t: number) => t % CYCLE > CYCLE - AWAY
const orbit = (rx: number, ry: number, cx = 200, cy = 166, speed = 0.55): Path => (t) =>
  away(t) ? null : [cx + rx * Math.sin(t * speed), cy + ry * Math.sin(t * speed * 1.6 + 1)]
const sweep = (y0: number, y1: number, x = 200, speed = 0.5): Path => (t) =>
  away(t) ? null : [x + 18 * Math.sin(t * 0.9), (y0 + y1) / 2 + ((y1 - y0) / 2) * Math.sin(t * speed)]

export const STEP_SCENES: Record<string, Scene> = {
  you: { start: own(waveform), label: "Ember's bars, speaking" },
  permissions: { start: pkg(padlock), path: orbit(150, 80), label: "A padlock whose shackle lifts as you come near" },
  model: { start: pkg(laptop), path: sweep(70, 270), label: "A laptop, opening on its hinge" },
  notes: { start: pkg(terminal), path: sweep(80, 250), label: "Lines of history, lifting as they scroll" },
  destination: { start: pkg(patch), path: orbit(140, 55), label: "A patch panel, its cables lifting in turn" },
  calls: { start: pkg(dish), path: orbit(160, 100), label: "A dish turning to listen" },
  dictation: { start: pkg(keyboard), path: orbit(130, 55, 200, 170, 0.7), label: "Keys sinking as if typed" },
  capture: { start: pkg(riffle), path: orbit(120, 60, 200, 150), label: "Cards pulled from a tray" },
  practice: { start: pkg(phosphor), path: orbit(140, 70), label: "A dot matrix, glowing where it's touched" },
  done: { start: pkg(exploded), path: orbit(140, 90), label: "An app window opening into its layers" },
  // Welcome cycles through these three.
  reel: { start: own(reel), label: "A recorder taking down a call" },
  waveform: { start: own(waveform), label: "Ember's bars, speaking" },
  catalogue: { start: own(catalogue), label: "A card cabinet, a drawer for each board" },
}

/** The step's figure, drawn in Ember's colours. It plays on its own, and hands over to your pointer when you hover. */
export function StepFigure({ scene, className }: { scene: Scene; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [readout, setReadout] = useState("")
  const hovering = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = scene.start(el, setReadout)
    const path = scene.path
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!path || still) return stop
    // The virtual pointer: the same events a mouse would send the figure's stage, until a real one arrives.
    const stage = (el.matches("[data-hairline]") ? el : el.querySelector("[data-hairline]")) as HTMLElement | null
    let frame = 0, start = performance.now(), was: Point = null
    const send = (type: string, point: Point) => {
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const [x, y] = point || [0, 0]
      stage.dispatchEvent(new PointerEvent(type, { clientX: rect.left + (x / 400) * rect.width, clientY: rect.top + (y / 320) * rect.height, pointerType: "mouse", bubbles: false }))
    }
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (hovering.current) { start = now - 1000 * CYCLE * 0.3; was = null; return }
      const point = path((now - start) / 1000)
      if (point) send("pointermove", point)
      else if (was) send("pointerleave", null)
      was = point
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      stop()
    }
  }, [scene])

  return (
    <div
      className={className}
      style={
        {
          "--hairline-plate": "var(--panel)",
          "--hairline-hi": "var(--ember)",
          "--hairline-edge": "rgb(255 255 255 / 66%)",
          "--hairline-mid": "rgb(255 255 255 / 34%)",
          "--hairline-lo": "rgb(255 255 255 / 15%)",
          "--hairline-stroke": "1",
        } as React.CSSProperties
      }
    >
      <div
        className="relative"
        onPointerEnter={(event) => event.isTrusted && (hovering.current = true)}
        onPointerLeave={(event) => event.isTrusted && (hovering.current = false)}
      >
        <div ref={ref} role="img" aria-label={scene.label} className="onb-figure-in w-full" />
        {readout && readout !== "rest" ? (
          <span className="tabular pointer-events-none absolute top-1 right-1 font-mono text-[11px] text-faint">{readout}</span>
        ) : null}
      </div>
    </div>
  )
}
