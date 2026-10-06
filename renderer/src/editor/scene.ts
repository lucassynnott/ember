// The frame around the recording: background, padding, corners, shadow, shape and crop.
import type { LayoutSettings, Scene } from "./model"

/** Layouts that split the frame between the screen and the camera, edge to edge. */
export const SPLIT_LAYOUTS = ["side-by-side", "side-by-side-right", "stacked", "camera"]
export const isSplit = (layout?: LayoutSettings) => Boolean(layout && SPLIT_LAYOUTS.includes(layout.preset))

export interface Gradient {
  id: string
  label: string
  kind: "linear" | "radial"
  angle?: number
  stops: [string, number][]
}

/** 24 gradients, from warm to cool to dark. Linear ones run at their angle; radial ones glow from the centre. */
export const GRADIENTS: Gradient[] = [
  { id: "ember", label: "Ember", kind: "linear", angle: 135, stops: [["#ffc15e", 0], ["#ff8a3d", 0.45], ["#e8492c", 1]] },
  { id: "peach", label: "Peach sunset", kind: "linear", angle: 135, stops: [["#ffd3a5", 0], ["#fd6585", 1]] },
  { id: "apricot", label: "Apricot", kind: "linear", angle: 120, stops: [["#f6d365", 0], ["#fda085", 1]] },
  { id: "coral", label: "Coral", kind: "linear", angle: 160, stops: [["#ff9a8b", 0], ["#ff6a88", 0.55], ["#ff99ac", 1]] },
  { id: "candy", label: "Candy", kind: "linear", angle: 135, stops: [["#fbc2eb", 0], ["#a6c1ee", 1]] },
  { id: "mint", label: "Mint", kind: "linear", angle: 135, stops: [["#d4fc79", 0], ["#96e6a1", 1]] },
  { id: "lagoon", label: "Lagoon", kind: "linear", angle: 135, stops: [["#43e97b", 0], ["#38f9d7", 1]] },
  { id: "teal-amber", label: "Teal and amber", kind: "linear", angle: 120, stops: [["#0f766e", 0], ["#f59e0b", 1]] },
  { id: "pink-green", label: "Pink and green", kind: "linear", angle: 135, stops: [["#f9a8d4", 0], ["#86efac", 1]] },
  { id: "sky", label: "Sky", kind: "linear", angle: 180, stops: [["#a1c4fd", 0], ["#c2e9fb", 1]] },
  { id: "ocean", label: "Ocean", kind: "linear", angle: 135, stops: [["#38bdf8", 0], ["#1e3a8a", 1]] },
  { id: "deep-sea", label: "Deep sea", kind: "linear", angle: 160, stops: [["#2193b0", 0], ["#6dd5ed", 1]] },
  { id: "aurora", label: "Aurora", kind: "linear", angle: 135, stops: [["#00c9ff", 0], ["#92fe9d", 1]] },
  { id: "forest", label: "Forest", kind: "linear", angle: 135, stops: [["#4d7c0f", 0], ["#14532d", 1]] },
  { id: "sand", label: "Sand", kind: "linear", angle: 135, stops: [["#f3e7cf", 0], ["#d4b483", 1]] },
  { id: "paper", label: "Paper", kind: "linear", angle: 135, stops: [["#f4f2ee", 0], ["#e7e4de", 1]] },
  { id: "graphite", label: "Graphite", kind: "linear", angle: 135, stops: [["#3b3b3b", 0], ["#121212", 1]] },
  { id: "midnight", label: "Midnight", kind: "linear", angle: 135, stops: [["#1e293b", 0], ["#0b1120", 1]] },
  { id: "dusk", label: "Dusk", kind: "linear", angle: 180, stops: [["#0f2027", 0], ["#203a43", 0.5], ["#2c5364", 1]] },
  { id: "glow-ember", label: "Ember glow", kind: "radial", stops: [["#ff8a3d", 0], ["#3a1206", 1]] },
  { id: "glow-blue", label: "Blue glow", kind: "radial", stops: [["#3b82f6", 0], ["#0b1120", 1]] },
  { id: "glow-teal", label: "Teal glow", kind: "radial", stops: [["#2dd4bf", 0], ["#042f2e", 1]] },
  { id: "glow-rose", label: "Rose glow", kind: "radial", stops: [["#fb7185", 0], ["#3b0a14", 1]] },
  { id: "glow-light", label: "Soft light", kind: "radial", stops: [["#ffffff", 0], ["#d6d3d1", 1]] },
]

/** The colour palette. */
export const COLORS = [
  "#ef4444", "#eab308", "#22c55e", "#ffffff", "#3b82f6", "#f97316", "#a855f7", "#ec4899",
  "#06b6d4", "#ea580c", "#84cc16", "#f59e0b", "#2563eb", "#000000", "#607d8b", "#795548",
]

export const ASPECTS: { id: string; label: string }[] = [
  { id: "native", label: "Original" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
  { id: "4:3", label: "4:3" },
  { id: "4:5", label: "4:5" },
  { id: "16:10", label: "16:10" },
  { id: "10:16", label: "10:16" },
]

export type Resolution = "original" | "high" | "medium" | "low" | "1080" | "720"

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** The recording after cropping, in its pixels. */
export function croppedSource(scene: Scene, width: number, height: number) {
  const { top, bottom, left, right } = scene.crop
  return { x: width * left, y: height * top, w: Math.max(2, width * (1 - left - right)), h: Math.max(2, height * (1 - top - bottom)) }
}

export function aspectRatio(scene: Scene, width: number, height: number, layout?: LayoutSettings) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(scene.aspect)
  if (match && Number(match[2]) > 0) return Number(match[1]) / Number(match[2])
  // Split layouts make their own frame: wide side by side, tall stacked.
  if (layout?.preset === "stacked") return 9 / 16
  if (isSplit(layout)) return 16 / 9
  const crop = croppedSource(scene, width, height)
  return crop.w / crop.h
}

/**
 * The finished video's size. Original keeps the (cropped) recording's long side, up to 4K; the
 * quality steps scale that; 1080 and 720 set the short side.
 */
export function outputSize(scene: Scene, width: number, height: number, resolution: Resolution = "original", layout?: LayoutSettings) {
  const ratio = aspectRatio(scene, width, height, layout)
  const crop = croppedSource(scene, width, height)
  if (resolution === "1080" || resolution === "720") {
    const short = Number(resolution)
    return ratio >= 1 ? { width: even(short * ratio), height: even(short) } : { width: even(short), height: even(short / ratio) }
  }
  const scale = { original: 1, high: 0.9, medium: 0.75, low: 0.6 }[resolution]
  const long = Math.min(3840, Math.max(crop.w, crop.h)) * scale
  return ratio >= 1 ? { width: even(long), height: even(long / ratio) } : { width: even(long * ratio), height: even(long) }
}

export interface Layout {
  width: number
  height: number
  content: { x: number; y: number; w: number; h: number }
  /** In split layouts, the camera's part of the frame. */
  camera: { x: number; y: number; w: number; h: number } | null
  /** The part of the recording that fills the content, when it has to be cropped to fit. */
  fill: { x: number; y: number; w: number; h: number } | null
  radius: number
  shadows: { blur: number; offset: number; opacity: number }[]
  framed: boolean
}

/** Where the recording sits in the frame: inside the padding, keeping its shape. */
export function layoutFor(scene: Scene, width: number, height: number, videoWidth: number, videoHeight: number, layout?: LayoutSettings): Layout {
  const crop = croppedSource(scene, videoWidth, videoHeight)
  if (isSplit(layout)) return splitLayout(layout!, crop, width, height)
  const framed = scene.background.kind !== "none"
  const unit = Math.min(width, height)
  const pad = framed ? scene.padding : { top: 0, bottom: 0, left: 0, right: 0 }
  const room = {
    x: pad.left * unit,
    y: pad.top * unit,
    w: Math.max(8, width - (pad.left + pad.right) * unit),
    h: Math.max(8, height - (pad.top + pad.bottom) * unit),
  }
  const scale = Math.min(room.w / crop.w, room.h / crop.h)
  const w = crop.w * scale
  const h = crop.h * scale
  const strength = framed ? scene.shadow : 0
  return {
    width,
    height,
    content: { x: room.x + (room.w - w) / 2, y: room.y + (room.h - h) / 2, w, h },
    radius: framed ? clamp(scene.radius, 0, 0.5) * Math.min(w, h) : 0,
    // A soft three-layer shadow: tight and dark, then wider and fainter.
    shadows: strength
      ? [
          { blur: unit * 0.008, offset: unit * 0.003, opacity: 0.28 * strength },
          { blur: unit * 0.025, offset: unit * 0.012, opacity: 0.22 * strength },
          { blur: unit * 0.06, offset: unit * 0.03, opacity: 0.18 * strength },
        ]
      : [],
    framed,
    camera: null,
    fill: null,
  }
}

/** Screen and camera side by side (or stacked), edge to edge; the screen cropped to its part. */
function splitLayout(layout: LayoutSettings, crop: { x: number; y: number; w: number; h: number }, width: number, height: number): Layout {
  let content = { x: 0, y: 0, w: width, h: height }
  let camera = { x: 0, y: 0, w: width, h: height }
  if (layout.preset === "side-by-side" || layout.preset === "side-by-side-right") {
    const share = Math.round(width * layout.split)
    camera = { x: layout.preset === "side-by-side" ? 0 : width - share, y: 0, w: share, h: height }
    content = { x: layout.preset === "side-by-side" ? share : 0, y: 0, w: width - share, h: height }
  } else if (layout.preset === "stacked") {
    const share = Math.round(height * layout.split)
    camera = { x: 0, y: 0, w: width, h: share }
    content = { x: 0, y: share, w: width, h: height - share }
  }
  // The recording, cropped to the content's shape around the chosen part.
  const target = content.w / Math.max(1, content.h)
  let fill = { ...crop }
  if (crop.w / crop.h > target) {
    const w = crop.h * target
    fill = { x: crop.x + (crop.w - w) * layout.screenX, y: crop.y, w, h: crop.h }
  } else {
    const h = crop.w / target
    fill = { x: crop.x, y: crop.y + (crop.h - h) * layout.screenY, w: crop.w, h }
  }
  return { width, height, content, radius: 0, shadows: [], framed: false, camera, fill }
}

/** A squircle (rounded with continuous curves, like macOS icons) as a path. */
export function squircle(path: CanvasPath, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2)
  if (r <= 0.5) {
    path.rect(x, y, w, h)
    return
  }
  const n = 5
  const corner = (cx: number, cy: number, from: number) => {
    for (let step = 0; step <= 12; step += 1) {
      const angle = from + (step / 12) * (Math.PI / 2)
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const px = cx + r * Math.sign(cos) * Math.pow(Math.abs(cos), 2 / n)
      const py = cy + r * Math.sign(sin) * Math.pow(Math.abs(sin), 2 / n)
      if (step === 0 && from === Math.PI) path.moveTo(px, py)
      else path.lineTo(px, py)
    }
  }
  corner(x + r, y + r, Math.PI)
  corner(x + w - r, y + r, Math.PI * 1.5)
  corner(x + w - r, y + h - r, 0)
  corner(x + r, y + h - r, Math.PI / 2)
  path.closePath()
}

/** The same squircle as an SVG path, for outlines drawn over the preview. */
export function squirclePath(x: number, y: number, w: number, h: number, radius: number) {
  const parts: string[] = []
  const at = (value: number) => Math.round(value * 100) / 100
  squircle(
    {
      moveTo: (px: number, py: number) => parts.push(`M${at(px)} ${at(py)}`),
      lineTo: (px: number, py: number) => parts.push(`L${at(px)} ${at(py)}`),
      rect: (rx: number, ry: number, rw: number, rh: number) => parts.push(`M${at(rx)} ${at(ry)}h${at(rw)}v${at(rh)}h${at(-rw)}Z`),
      closePath: () => parts.push("Z"),
    } as unknown as CanvasPath,
    x,
    y,
    w,
    h,
    radius,
  )
  return parts.join("")
}

/** Fills a canvas with a gradient. */
export function paintGradient(context: CanvasRenderingContext2D, gradient: Gradient, width: number, height: number) {
  let fill: CanvasGradient
  if (gradient.kind === "radial") {
    fill = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width, height) / 2)
  } else {
    const angle = (((gradient.angle ?? 135) - 90) * Math.PI) / 180
    const length = Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))
    const cx = width / 2
    const cy = height / 2
    fill = context.createLinearGradient(cx - (Math.cos(angle) * length) / 2, cy - (Math.sin(angle) * length) / 2, cx + (Math.cos(angle) * length) / 2, cy + (Math.sin(angle) * length) / 2)
  }
  for (const [color, offset] of gradient.stops) fill.addColorStop(offset, color)
  context.fillStyle = fill
  context.fillRect(0, 0, width, height)
}

export function gradientCss(gradient: Gradient) {
  const stops = gradient.stops.map(([color, offset]) => `${color} ${Math.round(offset * 100)}%`).join(", ")
  return gradient.kind === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${gradient.angle ?? 135}deg, ${stops})`
}

/** Fills a rect with an image like CSS background-size: cover. */
export function drawCover(context: CanvasRenderingContext2D, image: CanvasImageSource & { width: number; height: number }, width: number, height: number) {
  const iw = (image as HTMLVideoElement).videoWidth || image.width
  const ih = (image as HTMLVideoElement).videoHeight || image.height
  if (!iw || !ih) return
  const scale = Math.max(width / iw, height / ih)
  const w = iw * scale
  const h = ih * scale
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h)
}
