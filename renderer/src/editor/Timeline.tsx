import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown01Icon, ScissorIcon, SearchAddIcon, SparklesIcon, VolumeMute02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

import {
  MIN_BLOCK,
  placeClips,
  snapTime,
  timelineEdges,
  toEdited,
  trimClip,
  moveClip,
  type EditProject,
} from "./model"

export type Selection =
  | { kind: "clip"; index: number }
  | { kind: "zoom"; id: string }
  | { kind: "zooms" }
  | { kind: "annotation"; id: string }
  | { kind: "audio"; id: string }
  | { kind: "caption"; id: string }
  | { kind: "marker"; id: string }
  | null

type Change = (next: EditProject | ((current: EditProject) => EditProject), options?: { live?: boolean }) => void

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const LABEL = 92

function clock(seconds: number, tenths = false) {
  const total = Math.max(0, seconds)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  return tenths ? `${minutes}:${rest.toFixed(1).padStart(4, "0")}` : `${minutes}:${String(Math.floor(rest)).padStart(2, "0")}`
}

function tickStep(pixelsPerSecond: number) {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (step * pixelsPerSecond >= 72) return step
  return 600
}

/** Frames across the recording, for the clips' filmstrips. */
function useFrames(src: string, duration: number) {
  const count = clamp(Math.round(duration / 1.5), 8, 160)
  const [frames, setFrames] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    const video = document.createElement("video")
    video.src = src
    video.muted = true
    video.preload = "auto"
    const canvas = document.createElement("canvas")
    const run = async () => {
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve
        video.onerror = reject
      })
      canvas.height = 72
      canvas.width = Math.round((72 * video.videoWidth) / Math.max(1, video.videoHeight))
      const context = canvas.getContext("2d")!
      const result: string[] = []
      for (let index = 0; index < count && !cancelled; index += 1) {
        video.currentTime = ((index + 0.5) / count) * video.duration
        await new Promise((resolve) => (video.onseeked = resolve))
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        result.push(canvas.toDataURL("image/jpeg", 0.55))
        if (!cancelled && (index % 8 === 7 || index === count - 1)) setFrames([...result])
      }
    }
    run().catch(() => {})
    return () => {
      cancelled = true
      video.removeAttribute("src")
      video.load()
    }
  }, [src, count])
  return { frames, count }
}

function Waveform({ peaks, from, to, width, className }: { peaks: number[]; from: number; to: number; width: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || width < 2) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * ratio))
    canvas.height = Math.round(26 * ratio)
    const context = canvas.getContext("2d")!
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = "rgba(255,255,255,0.4)"
    if (!peaks.length) return
    const bars = Math.max(1, Math.floor(width / 2.5))
    for (let bar = 0; bar < bars; bar += 1) {
      const start = Math.floor(from * peaks.length + ((to - from) * peaks.length * bar) / bars)
      const end = Math.max(start + 1, Math.floor(from * peaks.length + ((to - from) * peaks.length * (bar + 1)) / bars))
      let peak = 0
      for (let index = start; index < end && index < peaks.length; index += 1) peak = Math.max(peak, peaks[index])
      const h = Math.max(1, peak * canvas.height * 0.9)
      context.fillRect(bar * 2.5 * ratio, (canvas.height - h) / 2, 1.6 * ratio, h)
    }
  }, [peaks, from, to, width])
  return <canvas ref={ref} style={{ width, height: 26 }} className={className} />
}

function Row({
  label,
  inner,
  children,
  className,
  onPointerMove,
  onPointerLeave,
  onClick,
}: { label: React.ReactNode; inner: number; children: React.ReactNode; className?: string } & Pick<React.HTMLAttributes<HTMLDivElement>, "onPointerMove" | "onPointerLeave" | "onClick">) {
  return (
    <div className="flex">
      <div className="sticky left-0 z-20 flex w-[92px] shrink-0 items-center bg-[#141414] pr-2 text-[11px] text-faint">{label}</div>
      <div className={cn("relative", className)} style={{ width: inner }} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onClick={onClick}>
        {children}
      </div>
    </div>
  )
}

interface BlockHandlers {
  body: (event: React.PointerEvent) => void
  left?: (event: React.PointerEvent) => void
  right?: (event: React.PointerEvent) => void
}

function Block({
  left,
  widthPx,
  selected,
  tone,
  handlers,
  children,
  dashed,
}: {
  left: number
  widthPx: number
  selected: boolean
  tone: string
  handlers: BlockHandlers
  children: React.ReactNode
  dashed?: boolean
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={handlers.body}
      className={cn(
        "absolute inset-y-[3px] flex cursor-grab items-center overflow-hidden rounded-[6px] border px-2 text-[11px] font-medium whitespace-nowrap active:cursor-grabbing",
        tone,
        dashed && "border-dashed",
        selected && "ring-2 ring-white/80",
      )}
      style={{ left, width: Math.max(6, widthPx) }}
    >
      <span className="truncate">{children}</span>
      {handlers.left ? <span onPointerDown={handlers.left} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" /> : null}
      {handlers.right ? <span onPointerDown={handlers.right} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" /> : null}
    </div>
  )
}

export interface TimelineProps {
  project: EditProject
  src: string
  duration: number
  total: number
  time: number
  peaks: number[]
  audioPeaks: Map<string, number[]>
  selection: Selection
  onSelect: (selection: Selection) => void
  onSeek: (time: number) => void
  change: Change
  endDrag: () => void
  onAddZoom: () => void
  onSuggest: () => void
  onSplit: () => void
  onAddAnnotation: (track?: number) => void
  onAddAudio: (track?: number) => void
  onAddCaption: (edited: number) => void
  canSplit: boolean
  hasPointer: boolean
}

export function Timeline(props: TimelineProps) {
  const { project, src, duration, total, time, peaks, selection, onSelect, onSeek, change, endDrag } = props
  const scroller = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [tooltip, setTooltip] = useState<{ x: number; text: string } | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(() => localStorage.getItem("ember.editor.timeline") !== "collapsed")
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth - LABEL - 16))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const perSecond = (Math.max(100, width) / Math.max(0.5, total)) * zoom
  const x = useCallback((seconds: number) => seconds * perSecond, [perSecond])
  const inner = Math.max(width, total * perSecond)
  const { frames, count } = useFrames(src, duration)
  const placed = useMemo(() => placeClips(project.clips), [project.clips])
  const step = tickStep(perSecond)
  const ticks: number[] = []
  for (let at = 0; at <= total + 0.001; at += step) ticks.push(at)

  // ⌘ or Ctrl and scroll zooms the timeline around the pointer; Shift and scroll pans.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault()
        const box = element.getBoundingClientRect()
        const pointer = event.clientX - box.left - LABEL + element.scrollLeft
        const at = pointer / perSecond
        const next = clamp(zoom * Math.exp(-event.deltaY * 0.004), 1, 60)
        setZoom(next)
        requestAnimationFrame(() => {
          const nextPerSecond = (Math.max(100, width) / Math.max(0.5, total)) * next
          element.scrollLeft = at * nextPerSecond - (event.clientX - box.left - LABEL)
        })
      } else if (event.shiftKey && !event.deltaX) {
        event.preventDefault()
        element.scrollLeft += event.deltaY
      }
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [zoom, perSecond, width, total])

  // Keeps the playhead in view while it plays past the edge.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const position = x(time)
    if (position < element.scrollLeft || position > element.scrollLeft + element.clientWidth - LABEL - 40) element.scrollLeft = Math.max(0, position - 80)
  }, [time, x])

  const timeAt = (clientX: number) => {
    const element = scroller.current!
    return clamp((clientX - element.getBoundingClientRect().left - LABEL + element.scrollLeft) / perSecond, 0, total)
  }

  const scrub = (event: React.PointerEvent) => {
    onSeek(timeAt(event.clientX))
    const move = (moved: PointerEvent) => onSeek(timeAt(moved.clientX))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  /** Follows a drag, as seconds moved, snapping to nearby edges; one step in undo. */
  const drag = (event: React.PointerEvent, options: { except?: string; anchor: number; apply: (seconds: number, snapped: number) => EditProject | null; onClick?: () => void }) => {
    event.stopPropagation()
    event.preventDefault()
    const startX = event.clientX
    const edges = [...timelineEdges(project, options.except), time]
    let moved = false
    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - startX
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      const seconds = dx / perSecond
      const target = snapTime(options.anchor + seconds, edges, 8 / perSecond)
      const next = options.apply(seconds, target - options.anchor)
      if (next) change(next, { live: true })
      setTooltip({ x: x(target), text: clock(target, true) })
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setTooltip(null)
      if (moved) endDrag()
      else options.onClick?.()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  /** A block on a row: moved by its body, resized by its edges. */
  const blockHandlers = (id: string, start: number, end: number, update: (start: number, end: number) => EditProject, select: () => void, resizable = true): BlockHandlers => ({
    body: (event: React.PointerEvent) =>
      drag(event, {
        except: id,
        anchor: start,
        onClick: select,
        apply: (_seconds, snapped) => {
          const length = end - start
          const from = clamp(start + snapped, 0, Math.max(0, total - length))
          return update(from, from + length)
        },
      }),
    left: resizable
      ? (event: React.PointerEvent) =>
          drag(event, { except: id, anchor: start, onClick: select, apply: (_seconds, snapped) => update(clamp(start + snapped, 0, end - MIN_BLOCK), end) })
      : undefined,
    right: resizable
      ? (event: React.PointerEvent) =>
          drag(event, { except: id, anchor: end, onClick: select, apply: (_seconds, snapped) => update(start, clamp(end + snapped, start + MIN_BLOCK, total)) })
      : undefined,
  })

  const annotationTracks = Math.max(1, ...project.annotations.map((annotation) => annotation.track + 1))
  const audioTracks = Math.max(1, ...project.audio.map((block) => block.track + 1))
  const frameAt = (source: number) => frames[clamp(Math.floor((source / Math.max(0.1, duration)) * count), 0, frames.length - 1)]

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-[#141414] select-none">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 pt-2 pb-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              Add layer <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={1.8} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => props.onAddAnnotation(annotationTracks)}>Annotation track</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onAddAudio(audioTracks)}>Audio track…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" onClick={props.onAddZoom} title="Add a zoom at the playhead">
          <HugeiconsIcon icon={SearchAddIcon} strokeWidth={1.7} /> Zoom <Kbd>Z</Kbd>
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onSuggest} disabled={!props.hasPointer} title="Add zooms where you clicked and paused">
          <HugeiconsIcon icon={SparklesIcon} strokeWidth={1.7} /> Suggest zooms
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onSplit} disabled={!props.canSplit} title="Split the clip at the playhead">
          <HugeiconsIcon icon={ScissorIcon} strokeWidth={1.7} /> Split <Kbd>C</Kbd>
        </Button>
        <span className="ml-auto text-[11px] text-faint">⌘ scroll to zoom · ⇧ scroll to pan</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setExpanded(!expanded)
            localStorage.setItem("ember.editor.timeline", expanded ? "collapsed" : "expanded")
          }}
        >
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>

      <div ref={scroller} className={cn("relative overflow-auto px-4 pb-3", expanded ? "max-h-[300px]" : "max-h-[128px]")} onPointerDown={(event) => event.target === event.currentTarget && scrub(event)}>
        {/* Ruler and markers */}
        <Row inner={inner} label="" className="h-6 cursor-pointer">
          <div className="absolute inset-0" onPointerDown={scrub}>
            {ticks.map((at) => (
              <span key={at} className="tabular absolute top-1 -translate-x-1/2 text-[10.5px] text-faint first:translate-x-0" style={{ left: x(at) }}>
                {clock(at)}
              </span>
            ))}
          </div>
          {project.markers.map((marker) => (
            <span
              key={marker.id}
              role="button"
              title="Marker: drag to move, select and press Delete to remove"
              onPointerDown={(event) =>
                drag(event, {
                  except: marker.id,
                  anchor: marker.time,
                  onClick: () => onSelect({ kind: "marker", id: marker.id }),
                  apply: (_seconds, snapped) => ({ ...project, markers: project.markers.map((item) => (item.id === marker.id ? { ...item, time: clamp(marker.time + snapped, 0, total) } : item)) }),
                })
              }
              className={cn(
                "absolute bottom-0 size-2.5 -translate-x-1/2 rotate-45 cursor-grab border",
                selection?.kind === "marker" && selection.id === marker.id ? "border-white bg-white" : "border-ember bg-ember/60",
              )}
              style={{ left: x(marker.time) }}
            />
          ))}
        </Row>

        {/* Zooms */}
        <Row inner={inner} label="Zoom" className="h-8">
          {project.zooms.map((zoom) => {
            const handlers = blockHandlers(
              zoom.id,
              zoom.start,
              zoom.end,
              (start, end) => ({ ...project, zooms: project.zooms.map((item) => (item.id === zoom.id ? { ...item, start, end, suggested: false } : item)) }),
              () => onSelect({ kind: "zoom", id: zoom.id }),
            )
            const selected = (selection?.kind === "zoom" && selection.id === zoom.id) || selection?.kind === "zooms"
            return (
              <Block key={zoom.id} left={x(zoom.start)} widthPx={x(zoom.end - zoom.start)} selected={selected} tone="border-ember/50 bg-ember/20 text-ember" handlers={handlers} dashed={zoom.suggested}>
                {zoom.depth}×
              </Block>
            )
          })}
        </Row>

        {/* Clips, back to back */}
        <Row inner={inner} label="Clips" className="h-[52px]">
          {placed.map((item) => {
            const { clip, index, from, to } = item
            const selected = selection?.kind === "clip" && selection.index === index
            const left = x(from)
            const w = x(to - from)
            const thumbs = Math.max(1, Math.ceil(w / 80))
            const startDrag = (event: React.PointerEvent) => {
              event.stopPropagation()
              const startX = event.clientX
              let moved = false
              const move = (pointer: PointerEvent) => {
                if (!moved && Math.abs(pointer.clientX - startX) < 4) return
                moved = true
                const at = timeAt(pointer.clientX)
                // Dropped before the first clip whose middle is past the pointer.
                const target = placed.findIndex((other) => at < (other.from + other.to) / 2)
                setDropAt(target < 0 ? placed.length : target)
              }
              const up = (pointer: PointerEvent) => {
                window.removeEventListener("pointermove", move)
                window.removeEventListener("pointerup", up)
                setDropAt(null)
                if (!moved) {
                  onSelect(selected ? null : { kind: "clip", index })
                  onSeek(timeAt(pointer.clientX))
                  return
                }
                const at = timeAt(pointer.clientX)
                let target = placed.findIndex((other) => at < (other.from + other.to) / 2)
                if (target < 0) target = placed.length
                if (target > index) target -= 1
                change(moveClip(project, index, target))
                onSelect({ kind: "clip", index: target })
              }
              window.addEventListener("pointermove", move)
              window.addEventListener("pointerup", up)
            }
            const trim = (edge: "start" | "end") => (event: React.PointerEvent) =>
              drag(event, {
                except: clip.id,
                anchor: edge === "start" ? from : to,
                onClick: () => onSelect({ kind: "clip", index }),
                apply: (seconds) => trimClip(project, index, edge, (edge === "start" ? clip.start : clip.end) + seconds * clip.speed, duration),
              })
            return (
              <div
                key={clip.id}
                onPointerDown={startDrag}
                className={cn("absolute inset-y-0 cursor-grab overflow-hidden rounded-[8px] border-2 bg-black/50 active:cursor-grabbing", selected ? "border-ember" : "border-white/10")}
                style={{ left, width: Math.max(4, w - 2) }}
              >
                <div className="absolute inset-0 flex">
                  {clip.source
                    ? Array.from({ length: thumbs }, (_, thumb) => (
                        <img key={thumb} src={`ember-media://recording/${clip.source!.id}/thumb`} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover opacity-70" />
                      ))
                    : Array.from({ length: thumbs }, (_, thumb) => {
                        const frame = frameAt(clip.start + ((thumb + 0.5) / thumbs) * (clip.end - clip.start))
                        return frame ? <img key={thumb} src={frame} alt="" draggable={false} className="h-full min-w-0 flex-1 object-cover opacity-80" /> : <span key={thumb} className="flex-1" />
                      })}
                </div>
                {clip.source ? <span className="absolute bottom-1 left-1.5 max-w-[90%] truncate rounded bg-black/75 px-1 text-[10.5px] text-white">{clip.source.title}</span> : null}
                <div className="absolute top-1 left-1.5 flex gap-1">
                  {clip.speed !== 1 ? <span className="rounded bg-black/75 px-1 text-[10.5px] font-medium text-white">{clip.speed}×</span> : null}
                  {clip.muted ? (
                    <span className="rounded bg-black/75 px-1 text-white">
                      <HugeiconsIcon icon={VolumeMute02Icon} strokeWidth={1.8} className="size-3" />
                    </span>
                  ) : null}
                </div>
                <span onPointerDown={trim("start")} className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize bg-white/0 hover:bg-white/40" />
                <span onPointerDown={trim("end")} className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-white/0 hover:bg-white/40" />
              </div>
            )
          })}
          {dropAt !== null ? <span className="absolute inset-y-[-3px] z-10 w-[3px] -translate-x-1/2 rounded bg-ember" style={{ left: x(placed[dropAt]?.from ?? total) }} /> : null}
        </Row>

        {/* The recording's sound */}
        <Row inner={inner} label="Sound" className="h-8">
          {placed.map(({ clip, from, to }) => (
            <div key={clip.id} className={cn("absolute inset-y-[3px] overflow-hidden rounded-[6px] bg-white/[0.04]", clip.muted && "opacity-30")} style={{ left: x(from), width: Math.max(2, x(to - from) - 2) }}>
              {clip.source ? null : <Waveform peaks={peaks} from={clip.start / Math.max(0.1, duration)} to={clip.end / Math.max(0.1, duration)} width={Math.max(2, x(to - from) - 2)} className="mt-px" />}
            </div>
          ))}
        </Row>

        {/* Notes */}
        {Array.from({ length: annotationTracks }, (_, track) => (
          <Row inner={inner} key={`a${track}`} label={`Notes ${track + 1}`} className="h-8" onClick={(event) => event.target === event.currentTarget && props.onAddAnnotation(track)}>
            {project.annotations
              .filter((annotation) => annotation.track === track)
              .map((annotation) => {
                const handlers = blockHandlers(
                  annotation.id,
                  annotation.start,
                  annotation.end,
                  (start, end) => ({ ...project, annotations: project.annotations.map((item) => (item.id === annotation.id ? { ...item, start, end } : item)) }),
                  () => onSelect({ kind: "annotation", id: annotation.id }),
                )
                return (
                  <Block
                    key={annotation.id}
                    left={x(annotation.start)}
                    widthPx={x(annotation.end - annotation.start)}
                    selected={selection?.kind === "annotation" && selection.id === annotation.id}
                    tone="border-sky-400/40 bg-sky-400/15 text-sky-300"
                    handlers={handlers}
                  >
                    {annotation.kind === "text" ? annotation.text.split("\n")[0] || "Text" : annotation.kind === "image" ? "Image" : annotation.kind === "arrow" ? "Arrow" : annotation.fill ? "Cover" : "Blur"}
                  </Block>
                )
              })}
          </Row>
        ))}

        {/* Added audio */}
        {Array.from({ length: audioTracks }, (_, track) => (
          <Row inner={inner} key={`s${track}`} label={`Audio ${track + 1}`} className="h-8" onClick={(event) => event.target === event.currentTarget && props.onAddAudio(track)}>
            {project.audio
              .filter((block) => block.track === track)
              .map((block) => {
                const handlers = blockHandlers(
                  block.id,
                  block.start,
                  block.start + block.duration,
                  (start) => ({ ...project, audio: project.audio.map((item) => (item.id === block.id ? { ...item, start } : item)) }),
                  () => onSelect({ kind: "audio", id: block.id }),
                  false,
                )
                const blockPeaks = props.audioPeaks.get(block.file) || []
                return (
                  <div
                    key={block.id}
                    role="button"
                    tabIndex={0}
                    onPointerDown={handlers.body}
                    className={cn(
                      "absolute inset-y-[3px] cursor-grab overflow-hidden rounded-[6px] border border-emerald-400/40 bg-emerald-400/15 active:cursor-grabbing",
                      selection?.kind === "audio" && selection.id === block.id && "ring-2 ring-white/80",
                    )}
                    style={{ left: x(block.start), width: Math.max(6, x(block.duration)) }}
                  >
                    <Waveform peaks={blockPeaks} from={0} to={1} width={Math.max(6, x(block.duration))} className="absolute inset-0 opacity-60" />
                    <span className="relative truncate px-2 text-[11px] font-medium text-emerald-300">{block.name}</span>
                  </div>
                )
              })}
          </Row>
        ))}

        {/* Captions */}
        {project.captions ? (
          <Row
            inner={inner}
            label="Captions"
            className="h-8"
            onPointerMove={(event) => project.captionStyle.hoverAdd && event.target === event.currentTarget && setHover(timeAt(event.clientX))}
            onPointerLeave={() => setHover(null)}
            onClick={(event) => {
              if (event.target !== event.currentTarget || !project.captionStyle.hoverAdd) return
              props.onAddCaption(timeAt(event.clientX))
            }}
          >
            {project.captions.map((caption) => {
              const start = toEdited(project, caption.start)
              const end = toEdited(project, Math.max(caption.start, caption.end - 0.01))
              if (start === null || end === null) return null
              return (
                <div
                  key={caption.id}
                  role="button"
                  tabIndex={0}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    onSelect({ kind: "caption", id: caption.id })
                    onSeek(start)
                  }}
                  className={cn(
                    "absolute inset-y-[3px] flex cursor-pointer items-center overflow-hidden rounded-[6px] border border-amber-300/40 bg-amber-300/15 px-1.5 text-[11px] text-amber-200",
                    selection?.kind === "caption" && selection.id === caption.id && "ring-2 ring-white/80",
                  )}
                  style={{ left: x(start), width: Math.max(6, x(end - start)) }}
                >
                  <span className="truncate">{caption.text}</span>
                </div>
              )
            })}
            {hover !== null ? <span className="pointer-events-none absolute inset-y-[3px] w-16 rounded-[6px] border border-dashed border-amber-300/40" style={{ left: x(hover) }} /> : null}
          </Row>
        ) : null}

        {/* Playhead and drag time */}
        <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-white" style={{ left: 16 + LABEL + x(time) }}>
          <span className="absolute top-0 left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-white" />
        </div>
        {tooltip ? (
          <span className="tabular pointer-events-none absolute top-0 z-40 -translate-x-1/2 rounded bg-black/90 px-1.5 py-0.5 text-[11px] text-white" style={{ left: 16 + LABEL + tooltip.x }}>
            {tooltip.text}
          </span>
        ) : null}
      </div>
    </div>
  )
}
