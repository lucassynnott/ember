// The drawn cursor's looks. The arrow and text cursor are drawn here; the other shapes use macOS's
// own cursor pictures (saved by the record helper), so a hand looks like the hand you saw.
import type { CursorStyle } from "./model"

/** The shapes the recorder tells apart, in its order. */
export const CURSOR_SHAPES = ["arrow", "text", "pointer", "grab", "grabbing", "crosshair", "resize-x", "resize-y", "not-allowed"] as const
export type CursorShape = (typeof CURSOR_SHAPES)[number]

export const CURSOR_STYLES: { id: CursorStyle; label: string }[] = [
  { id: "tahoe", label: "Tahoe" },
  { id: "tahoe-inverted", label: "Tahoe Inverted" },
  { id: "macos", label: "macOS" },
  { id: "windows", label: "Windows 11" },
  { id: "dot", label: "Dot" },
  { id: "minimal", label: "Minimal" },
]

/** A cursor picture: drawn at 4× so it stays sharp; size is the height it stands for, hot spot the tip. */
export interface CursorSprite {
  canvas: HTMLCanvasElement
  hotX: number
  hotY: number
  size: number
}

const RES = 4

function canvas(width: number, height: number) {
  const element = document.createElement("canvas")
  element.width = Math.ceil(width * RES)
  element.height = Math.ceil(height * RES)
  const context = element.getContext("2d")!
  context.scale(RES, RES)
  return { element, context }
}

function shadow(context: CanvasRenderingContext2D, strength = 1) {
  context.shadowColor = `rgba(0,0,0,${0.35 * strength})`
  context.shadowBlur = 3 * RES
  context.shadowOffsetY = 1.2 * RES
}

/** The arrow, in each style's colours and proportions, on a 24-unit-high box with its tip at (pad, pad). */
function arrow(style: CursorStyle): CursorSprite {
  const pad = 4
  const { element, context } = canvas(26, 32)
  const fill = style === "tahoe-inverted" ? "#111" : "#fff"
  const line = style === "tahoe-inverted" ? "#fff" : "#000"
  const slim = style === "windows"
  context.translate(pad, pad)
  shadow(context, style === "windows" ? 0.6 : 1)
  context.beginPath()
  if (slim) {
    // Windows 11: a narrow arrow with a short tail.
    context.moveTo(0, 0)
    context.lineTo(0, 19)
    context.lineTo(4.4, 14.8)
    context.lineTo(7.4, 21.6)
    context.lineTo(10.2, 20.4)
    context.lineTo(7.3, 13.8)
    context.lineTo(13.2, 13.6)
    context.closePath()
  } else {
    // macOS: a wider arrow with a rounder, chunkier tail; Tahoe softens the corners.
    const r = style === "macos" ? 0 : 0.9
    context.moveTo(0, r)
    context.lineTo(0, 17.5)
    context.lineTo(4.1, 13.6)
    context.lineTo(6.9, 20.1)
    context.lineTo(9.8, 18.9)
    context.lineTo(7.1, 12.6)
    context.lineTo(12.6, 12.4)
    context.closePath()
  }
  context.fillStyle = fill
  context.lineJoin = "round"
  context.lineWidth = slim ? 1.1 : 1.4
  context.strokeStyle = line
  context.fill()
  context.shadowColor = "transparent"
  context.stroke()
  return { canvas: element, hotX: pad * RES, hotY: pad * RES, size: 24 * RES }
}

function textCursor(style: CursorStyle): CursorSprite {
  const { element, context } = canvas(14, 26)
  const fill = style === "tahoe-inverted" ? "#fff" : "#111"
  const line = style === "tahoe-inverted" ? "#111" : "#fff"
  context.translate(7, 13)
  shadow(context, 0.6)
  context.lineCap = "round"
  for (const [width, color] of [[3.4, line], [1.5, fill]] as const) {
    context.lineWidth = width
    context.strokeStyle = color
    context.beginPath()
    context.moveTo(0, -9)
    context.lineTo(0, 9)
    context.moveTo(-3.5, -10)
    context.quadraticCurveTo(0, -10, 0, -8)
    context.quadraticCurveTo(0, -10, 3.5, -10)
    context.moveTo(-3.5, 10)
    context.quadraticCurveTo(0, 10, 0, 8)
    context.quadraticCurveTo(0, 10, 3.5, 10)
    context.stroke()
    context.shadowColor = "transparent"
  }
  return { canvas: element, hotX: 7 * RES, hotY: 13 * RES, size: 24 * RES }
}

function dot(style: CursorStyle): CursorSprite {
  const { element, context } = canvas(28, 28)
  context.translate(14, 14)
  shadow(context, 0.8)
  context.beginPath()
  if (style === "dot") {
    context.arc(0, 0, 8, 0, Math.PI * 2)
    context.fillStyle = "rgba(255,255,255,0.95)"
    context.fill()
    context.shadowColor = "transparent"
    context.lineWidth = 1.6
    context.strokeStyle = "rgba(0,0,0,0.7)"
    context.stroke()
  } else {
    context.arc(0, 0, 5, 0, Math.PI * 2)
    context.fillStyle = "#111"
    context.fill()
    context.shadowColor = "transparent"
    context.lineWidth = 2
    context.strokeStyle = "#fff"
    context.stroke()
  }
  return { canvas: element, hotX: 14 * RES, hotY: 14 * RES, size: 24 * RES }
}

/** A macOS cursor picture (4× pixels, hot spot in points), drawn into a sprite, inverted if asked. */
function fromSystem(image: HTMLImageElement, hot: { x: number; y: number; width: number; height: number }, invert: boolean): CursorSprite {
  const element = document.createElement("canvas")
  element.width = image.naturalWidth
  element.height = image.naturalHeight
  const context = element.getContext("2d")!
  if (invert) context.filter = "invert(1)"
  context.drawImage(image, 0, 0)
  const scale = image.naturalWidth / hot.width
  // macOS hands are drawn a little bigger than the arrow.
  return { canvas: element, hotX: hot.x * scale, hotY: hot.y * scale, size: 24 * scale * (hot.height / 32) * 1.05 }
}

export interface SystemCursor {
  name: string
  width: number
  height: number
  hotX: number
  hotY: number
  image: HTMLImageElement
}

/** One shape in one style. System pictures are used for shapes the style doesn't draw itself. */
export function cursorSprite(style: CursorStyle, shape: string, system?: Map<string, SystemCursor>): CursorSprite {
  if (style === "dot" || style === "minimal") return dot(style)
  if (shape === "text") return textCursor(style)
  if (shape !== "arrow") {
    const found = system?.get(shape)
    if (found?.image.complete && found.image.naturalWidth) {
      return fromSystem(found.image, { x: found.hotX, y: found.hotY, width: found.width, height: found.height }, style === "tahoe-inverted")
    }
  }
  return arrow(style)
}

/** Every style and shape, keyed "style:shape". */
export function cursorSprites(system?: Map<string, SystemCursor>) {
  const sprites = new Map<string, CursorSprite>()
  for (const { id } of CURSOR_STYLES) for (const shape of CURSOR_SHAPES) sprites.set(`${id}:${shape}`, cursorSprite(id, shape, system))
  return sprites
}

/** A small preview of a style, for the picker. */
export function stylePreview(style: CursorStyle) {
  return cursorSprite(style, "arrow").canvas.toDataURL()
}
