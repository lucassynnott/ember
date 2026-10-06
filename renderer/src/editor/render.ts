// Drawing a frame of the edit. The preview draws with this on a canvas; the export uses the same
// code to make its pictures (background, masks, notes, captions, cursor) and works out, frame by
// frame, where each goes, for the native exporter to put together.
import { clipAt, editedDuration, placeClips, toEdited, type Annotation, type Caption, type CaptionStyle, type CursorSettings, type EditProject, type PointerSample, type WebcamSettings } from "./model"
import { FPS, cameraAt, cameraTrack, cursorAt, cursorTrack, type CameraFrame, type Click, type CursorFrame } from "./motion"
import { GRADIENTS, croppedSource, drawCover, layoutFor, outputSize, paintGradient, squircle, type Layout, type Resolution } from "./scene"
import { CURSOR_SHAPES, cursorSprite, type CursorSprite } from "./cursors"

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = (value: number) => Math.round(value * 100) / 100

export interface Motion {
  camera: CameraFrame[]
  cursor: CursorFrame[]
  clicks: Click[]
}

export function motionFor(project: EditProject, samples: PointerSample[]): Motion {
  const cursor = cursorTrack(project, samples)
  return { camera: cameraTrack(project, samples), cursor: cursor.frames, clicks: cursor.clicks }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Everything about one frame that isn't a picture: where things go. */
export interface FrameState {
  edited: number
  source: number
  /** Another recording's clip: shown whole, letterboxed in the frame. */
  other: { id: string; width: number; height: number } | null
  view: Rect
  zoom: number
  cursor: { x: number; y: number; size: number; shape: string; squash: number; rotation: number; visible: boolean } | null
  webcam: (Rect & { radius: number }) | null
}

export const FONTS: Record<string, string> = {
  classic: '-apple-system, "SF Pro Display", system-ui, sans-serif',
  editor: "Georgia, serif",
  strong: "Impact, Haettenschweiler, sans-serif",
  typewriter: '"Courier New", Courier, monospace',
  deco: '"Brush Script MT", cursive',
  simple: "Arial, Helvetica, sans-serif",
  modern: "Verdana, Geneva, sans-serif",
  clean: '"Trebuchet MS", sans-serif',
}

/* Where things go */

/** The part of the recording shown: inside the crop, zoomed on the camera's point. */
export function viewFor(camera: CameraFrame, crop: Rect, videoWidth: number, videoHeight: number): Rect {
  const w = crop.w / Math.max(1, camera.scale)
  const h = crop.h / Math.max(1, camera.scale)
  return {
    x: clamp(camera.x * videoWidth - w / 2, crop.x, crop.x + crop.w - w),
    y: clamp(camera.y * videoHeight - h / 2, crop.y, crop.y + crop.h - h),
    w,
    h,
  }
}

/** A point of the recording (0 to 1 across it), on the finished frame. */
export function toFrame(px: number, py: number, view: Rect, layout: Layout, videoWidth: number, videoHeight: number) {
  return {
    x: layout.content.x + ((px * videoWidth - view.x) / view.w) * layout.content.w,
    y: layout.content.y + ((py * videoHeight - view.y) / view.h) * layout.content.h,
  }
}

/**
 * How big the webcam is right now, 1 being its own size: while zoomed in it eases
 * to the zoom's webcam size (or the webcam's "while zoomed" size), and back out.
 */
export function webcamScale(project: EditProject, edited: number, zoom: number) {
  if (!project.webcam.reactsToZoom || zoom <= 1.001) return 1
  // The zoom we're in, or the one we're easing out of.
  let active = project.zooms[0]
  for (const item of project.zooms) if (item.start <= edited + 0.75) active = item
  if (!active) return 1
  const target = active.webcamSize ?? project.webcam.zoomSize ?? 0.75
  const progress = clamp((zoom - 1) / Math.max(0.05, active.depth - 1), 0, 1)
  return 1 + (target - 1) * progress
}

export function webcamRect(settings: WebcamSettings, layout: Layout, scale: number, cameraAspect: number): (Rect & { radius: number }) | null {
  if (!settings.show) return null
  const unit = Math.min(layout.width, layout.height)
  const shrink = scale
  const crop = settings.crop
  const naturalAspect = (cameraAspect * crop.w) / Math.max(0.01, crop.h)
  // Size: 10 to 100% of half the frame's short side; with roundness 100 it's a circle.
  let w = settings.size * unit * 0.5 * shrink
  let h = w
  if (settings.width && settings.height) {
    w = settings.width * unit * shrink
    h = settings.height * unit * shrink
  } else if (settings.roundness < 100) {
    w = h * clamp(naturalAspect, 0.5, 2)
  }
  const margin = (settings.margin / 1080) * layout.height
  let x: number
  let y: number
  if (settings.position === "custom") {
    x = settings.x * layout.width - w / 2
    y = settings.y * layout.height - h / 2
  } else {
    const column = settings.position.includes("left") ? 0 : settings.position.includes("right") ? 2 : 1
    const row = settings.position.startsWith("top") ? 0 : settings.position.startsWith("bottom") ? 2 : 1
    x = column === 0 ? margin : column === 2 ? layout.width - w - margin : (layout.width - w) / 2
    y = row === 0 ? margin : row === 2 ? layout.height - h - margin : (layout.height - h) / 2
  }
  if (shrink !== 1) {
    // Grows or shrinks toward the corner it's nearest, so it stays tucked in place.
    const full = { w: w / shrink, h: h / shrink }
    const fullX = settings.position === "custom" ? settings.x * layout.width - full.w / 2 : x
    const fullY = settings.position === "custom" ? settings.y * layout.height - full.h / 2 : y
    if (settings.position === "custom") {
      const centerX = fullX + full.w / 2
      const centerY = fullY + full.h / 2
      x = centerX < layout.width / 3 ? fullX : centerX > (layout.width * 2) / 3 ? fullX + full.w - w : centerX - w / 2
      y = centerY < layout.height / 3 ? fullY : centerY > (layout.height * 2) / 3 ? fullY + full.h - h : centerY - h / 2
    }
  }
  return { x, y, w, h, radius: (settings.roundness / 100) * (Math.min(w, h) / 2) }
}

export function frameState(
  project: EditProject,
  motion: Motion,
  edited: number,
  layout: Layout,
  videoWidth: number,
  videoHeight: number,
  cameraAspect: number,
  hasCamera: boolean,
): FrameState {
  const placed = clipAt(project, edited)
  const source = placed.clip.start + (edited - placed.from) * placed.clip.speed
  const preset = project.layout?.preset || "bubble"
  // In split layouts the camera has its own part of the frame, square-cornered.
  const splitCamera = layout.camera && hasCamera ? { ...layout.camera, radius: 0 } : null
  if (placed.clip.source) {
    const other = placed.clip.source
    return { edited, source, other: { id: other.id, width: other.width, height: other.height }, view: { x: 0, y: 0, w: other.width, h: other.height }, zoom: 1, cursor: null, webcam: null }
  }
  const camera = cameraAt(motion.camera, edited)
  const crop = layout.fill || croppedSource(project.scene, videoWidth, videoHeight)
  const view = viewFor(camera, crop, videoWidth, videoHeight)
  const zoom = crop.w / view.w
  let cursor: FrameState["cursor"] = null
  if (project.cursor.show && motion.cursor.length && preset !== "camera") {
    const frame = cursorAt(motion.cursor, edited)
    const point = toFrame(frame.x, frame.y, view, layout, videoWidth, videoHeight)
    const inside = point.x >= layout.content.x && point.x <= layout.content.x + layout.content.w && point.y >= layout.content.y && point.y <= layout.content.y + layout.content.h
    cursor = {
      x: point.x,
      y: point.y,
      size: layout.content.h * 0.0095 * project.cursor.size * zoom,
      // Earlier recordings mistook the arrow for "not allowed" (they look alike to the recorder).
      shape: CURSOR_SHAPES[frame.shape] === "not-allowed" ? "arrow" : CURSOR_SHAPES[frame.shape] || "arrow",
      squash: frame.squash,
      rotation: frame.rotation,
      visible: frame.visible && inside,
    }
  }
  const webcam = preset === "screen" ? null : splitCamera || (hasCamera && !layout.camera ? webcamRect(project.webcam, layout, webcamScale(project, edited, zoom), cameraAspect) : null)
  return { edited, source, other: null, view, zoom, cursor, webcam }
}

/* Pictures */

export interface Assets {
  video: HTMLVideoElement
  /** Other recordings' videos, for their clips. */
  sources?: Map<string, HTMLVideoElement>
  camera: HTMLVideoElement | null
  backgroundImage: HTMLImageElement | null
  backgroundVideo: HTMLVideoElement | null
  images: Map<string, HTMLImageElement>
}

/** The background at a size: gradient, colour, image or video, blurred if asked. */
export function drawBackground(context: CanvasRenderingContext2D, project: EditProject, assets: Pick<Assets, "backgroundImage" | "backgroundVideo">, width: number, height: number) {
  const { background, blur } = project.scene
  context.save()
  if (blur > 0) context.filter = `blur(${(blur / 1080) * height * 2}px)`
  if (background.kind === "gradient") {
    paintGradient(context, GRADIENTS.find((gradient) => gradient.id === background.value) || GRADIENTS[0], width, height)
  } else if (background.kind === "color") {
    context.fillStyle = background.value || "#000"
    context.fillRect(0, 0, width, height)
  } else if ((background.kind === "image" || background.kind === "wallpaper") && assets.backgroundImage?.complete) {
    context.fillStyle = "#000"
    context.fillRect(0, 0, width, height)
    drawCover(context, assets.backgroundImage, width, height)
  } else if (background.kind === "video" && assets.backgroundVideo && assets.backgroundVideo.readyState >= 2) {
    drawCover(context, assets.backgroundVideo, width, height)
  } else {
    context.fillStyle = "#000"
    context.fillRect(0, 0, width, height)
  }
  context.restore()
}

/** A note as a picture, the size it shows at. */
export function drawAnnotation(context: CanvasRenderingContext2D, annotation: Annotation, w: number, h: number, scale: number, images: Map<string, HTMLImageElement>) {
  if (annotation.kind === "text") {
    const size = annotation.size * scale
    context.font = `${annotation.italic ? "italic " : ""}${annotation.bold ? "700" : "400"} ${size}px ${FONTS[annotation.font] || `"${annotation.font}", sans-serif`}`
    const lines = annotation.text.split("\n")
    const lineHeight = size * 1.2
    if (annotation.background) {
      context.fillStyle = annotation.background
      context.beginPath()
      context.roundRect(0, 0, w, h, annotation.radius * scale)
      context.fill()
    }
    context.fillStyle = annotation.color
    context.textBaseline = "middle"
    context.textAlign = annotation.align
    const x = annotation.align === "left" ? size * 0.4 : annotation.align === "right" ? w - size * 0.4 : w / 2
    const top = h / 2 - ((lines.length - 1) * lineHeight) / 2
    lines.forEach((line, index) => {
      const y = top + index * lineHeight
      context.fillText(line, x, y)
      if (annotation.underline) {
        const width = context.measureText(line).width
        const left = annotation.align === "left" ? x : annotation.align === "right" ? x - width : x - width / 2
        context.fillRect(left, y + size * 0.42, width, Math.max(1, size * 0.06))
      }
    })
  } else if (annotation.kind === "image") {
    const image = annotation.image ? images.get(annotation.image) : null
    if (image?.complete && image.naturalWidth) {
      const scaleFit = Math.min(w / image.naturalWidth, h / image.naturalHeight)
      const iw = image.naturalWidth * scaleFit
      const ih = image.naturalHeight * scaleFit
      context.save()
      context.beginPath()
      context.roundRect((w - iw) / 2, (h - ih) / 2, iw, ih, annotation.radius * scale)
      context.clip()
      context.drawImage(image, (w - iw) / 2, (h - ih) / 2, iw, ih)
      context.restore()
    }
  } else if (annotation.kind === "arrow") {
    const vectors: Record<string, [number, number]> = {
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], "up-left": [-1, -1], "up-right": [1, -1], "down-left": [-1, 1], "down-right": [1, 1],
    }
    const [dx, dy] = vectors[annotation.direction]
    const stroke = annotation.stroke * scale * 1.6
    const head = stroke * 4
    const pad = head
    const from = { x: dx > 0 ? pad : dx < 0 ? w - pad : w / 2, y: dy > 0 ? pad : dy < 0 ? h - pad : h / 2 }
    const to = { x: dx > 0 ? w - pad : dx < 0 ? pad : w / 2, y: dy > 0 ? h - pad : dy < 0 ? pad : h / 2 }
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    context.strokeStyle = annotation.color
    context.fillStyle = annotation.color
    context.lineWidth = stroke
    context.lineCap = "round"
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x - Math.cos(angle) * head * 0.6, to.y - Math.sin(angle) * head * 0.6)
    context.stroke()
    context.beginPath()
    context.moveTo(to.x, to.y)
    context.lineTo(to.x - Math.cos(angle - 0.45) * head, to.y - Math.sin(angle - 0.45) * head)
    context.lineTo(to.x - Math.cos(angle + 0.45) * head, to.y - Math.sin(angle + 0.45) * head)
    context.closePath()
    context.fill()
  }
}

/* Captions */

/** The caption showing at a moment of the recording, and how far through its words it is. */
export function captionAt(captions: Caption[] | null, source: number): Caption | null {
  if (!captions) return null
  return captions.find((caption) => source >= caption.start && source < caption.end) || null
}

/** Lays a caption out in lines no wider than the box, at most `rows` lines (the rest scrolls on). */
function captionLines(context: CanvasRenderingContext2D, words: string[], maxWidth: number) {
  const lines: number[][] = []
  let line: number[] = []
  let width = 0
  const space = context.measureText(" ").width
  words.forEach((word, index) => {
    const measure = context.measureText(word).width
    if (line.length && width + space + measure > maxWidth) {
      lines.push(line)
      line = []
      width = 0
    }
    width += (line.length ? space : 0) + measure
    line.push(index)
  })
  if (line.length) lines.push(line)
  return lines
}

/** A caption as a picture: a dark rounded box with the words, spoken ones bright. */
export function drawCaption(
  context: CanvasRenderingContext2D,
  caption: Caption,
  spokenUpTo: number,
  style: CaptionStyle,
  frameWidth: number,
  frameHeight: number,
): { w: number; h: number } | null {
  const scale = frameHeight / 1080
  const size = style.fontSize * scale * 1.6
  context.font = `600 ${size}px ${FONTS.classic}`
  const words = caption.words.length ? caption.words.map((word) => word.text) : caption.text.split(/\s+/)
  const maxWidth = style.maxWidth * frameWidth - size * 1.2
  let lines = captionLines(context, words, maxWidth)
  // Only the last `rows` lines that have started show.
  const current = lines.findIndex((line) => line.includes(Math.max(0, spokenUpTo)))
  const last = current < 0 ? lines.length - 1 : current
  lines = lines.slice(Math.max(0, last - style.rows + 1), last + 1)
  if (!lines.length) return null
  const lineHeight = size * 1.3
  const space = context.measureText(" ").width
  const widths = lines.map((line) => line.reduce((sum, index, position) => sum + context.measureText(words[index]).width + (position ? space : 0), 0))
  const w = Math.max(...widths) + size * 1.2
  const h = lines.length * lineHeight + size * 0.6
  if (style.background > 0) {
    context.fillStyle = `rgba(14,14,14,${style.background})`
    context.beginPath()
    context.roundRect(0, 0, w, h, style.boxRadius * scale * 1.4)
    context.fill()
  }
  context.textBaseline = "middle"
  context.textAlign = "left"
  lines.forEach((line, row) => {
    let x = (w - widths[row]) / 2
    const y = size * 0.3 + lineHeight * row + lineHeight / 2
    for (const index of line) {
      context.fillStyle = !caption.words.length || index <= spokenUpTo ? style.color : style.inactiveColor
      context.fillText(words[index], x, y)
      x += context.measureText(words[index]).width + space
    }
  })
  return { w, h }
}

/** Which word of a caption has been reached at a moment of the recording. */
export function spokenWord(caption: Caption, source: number) {
  if (!caption.words.length) return Infinity
  let reached = -1
  caption.words.forEach((word, index) => {
    if (source >= word.start) reached = index
  })
  return reached
}

/** Caption animation: opacity, rise and scale at a moment in its life. */
export function captionMotion(style: CaptionStyle, since: number, until: number) {
  const span = 0.18
  const amount = clamp(Math.min(since / span, until / span), 0, 1)
  if (style.animation === "off") return { alpha: 1, rise: 0, scale: 1 }
  if (style.animation === "rise") return { alpha: amount, rise: (1 - amount) * 0.4, scale: 1 }
  if (style.animation === "pop") return { alpha: amount, rise: 0, scale: 0.85 + 0.15 * amount }
  return { alpha: amount, rise: 0, scale: 1 }
}

/* Click effects */

export function drawClickEffect(context: CanvasRenderingContext2D, settings: CursorSettings, x: number, y: number, progress: number, unit: number) {
  const size = unit * 0.045 * settings.effectSize
  const alpha = settings.effectOpacity * (1 - progress)
  context.save()
  context.globalAlpha = clamp(alpha, 0, 1)
  context.strokeStyle = settings.effectColor
  context.fillStyle = settings.effectColor
  if (settings.effect === "ripple") {
    for (const delay of [0, 0.22]) {
      const local = clamp((progress - delay) / (1 - delay), 0, 1)
      if (local <= 0) continue
      context.globalAlpha = settings.effectOpacity * (1 - local)
      context.lineWidth = size * 0.12
      context.beginPath()
      context.arc(x, y, size * (0.25 + local), 0, Math.PI * 2)
      context.stroke()
    }
  } else if (settings.effect === "spotlight") {
    const radius = size * (0.8 + 0.5 * Math.sin(progress * Math.PI))
    const halo = context.createRadialGradient(x, y, 0, x, y, radius)
    halo.addColorStop(0, settings.effectColor)
    halo.addColorStop(1, "transparent")
    context.globalAlpha = settings.effectOpacity * Math.sin(progress * Math.PI)
    context.fillStyle = halo
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  } else if (settings.effect === "echo") {
    context.lineWidth = size * 0.08
    for (const ring of [0.55, 1]) {
      context.globalAlpha = settings.effectOpacity * (1 - progress) * (ring === 1 ? 0.5 : 0.8)
      context.beginPath()
      context.arc(x, y, size * ring * (0.4 + 0.6 * progress), 0, Math.PI * 2)
      context.stroke()
    }
    context.globalAlpha = settings.effectOpacity * (1 - progress)
    context.beginPath()
    context.arc(x, y, size * 0.18, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
}

/* A whole frame, for the preview */

export interface DrawOptions {
  /** The canvas's pixels per frame pixel. */
  scale: number
  layout: Layout
  videoWidth: number
  videoHeight: number
  cameraAspect: number
  background: HTMLCanvasElement | null
  sprites: Map<string, CursorSprite>
  selected?: string | null
}

/** A video's last good picture, kept so a seek in progress never shows black. */
interface Still {
  image: CanvasImageSource
  width: number
  height: number
}
const stills = new WeakMap<HTMLVideoElement, { canvas: HTMLCanvasElement; time: number }>()

/** The picture to draw for a video: the video itself when it's ready, or the last frame it showed while it seeks. */
export function videoFrame(element: HTMLVideoElement | null | undefined): Still | null {
  if (!element) return null
  const saved = stills.get(element)
  if (element.readyState >= 2 && !element.seeking && element.videoWidth) {
    if (!saved || saved.time !== element.currentTime || saved.canvas.width !== element.videoWidth) {
      const canvas = saved?.canvas || document.createElement("canvas")
      if (canvas.width !== element.videoWidth || canvas.height !== element.videoHeight) {
        canvas.width = element.videoWidth
        canvas.height = element.videoHeight
      }
      canvas.getContext("2d")?.drawImage(element, 0, 0)
      stills.set(element, { canvas, time: element.currentTime })
    }
    return { image: element, width: element.videoWidth, height: element.videoHeight }
  }
  return saved ? { image: saved.canvas, width: saved.canvas.width, height: saved.canvas.height } : null
}

export function drawFrame(context: CanvasRenderingContext2D, project: EditProject, motion: Motion, edited: number, assets: Assets, options: DrawOptions) {
  const { scale, layout, videoWidth, videoHeight } = options
  const state = frameState(project, motion, edited, layout, videoWidth, videoHeight, options.cameraAspect, Boolean(assets.camera))
  const content = layout.content
  context.save()
  context.setTransform(scale, 0, 0, scale, 0, 0)
  context.clearRect(0, 0, layout.width, layout.height)
  if (layout.framed) {
    if (options.background && project.scene.background.kind !== "video") context.drawImage(options.background, 0, 0, layout.width, layout.height)
    else drawBackground(context, project, assets, layout.width, layout.height)
    for (const shadow of layout.shadows) {
      context.save()
      context.shadowColor = `rgba(0,0,0,${shadow.opacity})`
      context.shadowBlur = shadow.blur * 2 * scale
      context.shadowOffsetY = shadow.offset * scale
      context.beginPath()
      squircle(context, content.x, content.y, content.w, content.h, layout.radius)
      context.fillStyle = "#000"
      context.fill()
      context.restore()
    }
  } else {
    context.fillStyle = "#000"
    context.fillRect(0, 0, layout.width, layout.height)
  }

  // The recording.
  const screen = state.other ? null : videoFrame(assets.video)
  context.save()
  context.beginPath()
  squircle(context, content.x, content.y, content.w, content.h, layout.radius)
  context.clip()
  if (state.other) {
    // Letterboxed: the whole of the other recording, at its own shape.
    const other = videoFrame(assets.sources?.get(state.other.id))
    context.fillStyle = "#000"
    context.fillRect(content.x, content.y, content.w, content.h)
    if (other) {
      const fit = letterbox(state.other.width, state.other.height, content)
      context.drawImage(other.image, fit.x, fit.y, fit.w, fit.h)
    }
  } else if (screen) {
    const blur = project.motion.blur !== false ? project.motion.blurStrength ?? 0.35 : 0
    const before = blur ? frameState(project, motion, Math.max(0, edited - 1 / 30), layout, videoWidth, videoHeight, options.cameraAspect, Boolean(assets.camera)) : null
    const pan = before && !before.other ? Math.hypot(state.view.x + state.view.w / 2 - (before.view.x + before.view.w / 2), state.view.y + state.view.h / 2 - (before.view.y + before.view.h / 2)) * (content.w / state.view.w) : 0
    const zoom = before && !before.other ? Math.abs(state.view.w - before.view.w) / state.view.w : 0
    if (before && (pan > 2 || zoom > 0.002)) {
      // Motion blur: the frame drawn along the camera's path over the last frame, averaged.
      const steps = Math.min(8, 3 + Math.round((pan * blur) / 6 + zoom * 120 * blur))
      for (let step = 0; step < steps; step += 1) {
        const amount = 1 - (step / Math.max(1, steps - 1)) * Math.min(1, blur * 2.2)
        const view = {
          x: before.view.x + (state.view.x - before.view.x) * amount,
          y: before.view.y + (state.view.y - before.view.y) * amount,
          w: before.view.w + (state.view.w - before.view.w) * amount,
          h: before.view.h + (state.view.h - before.view.h) * amount,
        }
        context.globalAlpha = 1 / (step + 1)
        context.drawImage(screen.image, view.x, view.y, view.w, view.h, content.x, content.y, content.w, content.h)
      }
      context.globalAlpha = 1
    } else {
      context.drawImage(screen.image, state.view.x, state.view.y, state.view.w, state.view.h, content.x, content.y, content.w, content.h)
    }
  }
  context.restore()

  // The camera.
  const camera = state.webcam ? videoFrame(assets.camera) : null
  if (state.webcam && camera) drawWebcam(context, camera, layout.camera ? { ...project.webcam, shadow: 0 } : project.webcam, state.webcam, scale)

  // Notes, in track order; a blur box blurs what's under it.
  for (const annotation of visibleAnnotations(project, edited)) {
    const rect = { x: annotation.x * layout.width, y: annotation.y * layout.height, w: annotation.w * layout.width, h: annotation.h * layout.height }
    if (annotation.kind === "blur") {
      drawBlurBox(context, annotation, rect, scale, layout.height)
      continue
    }
    context.save()
    context.translate(rect.x, rect.y)
    drawAnnotation(context, annotation, rect.w, rect.h, layout.height / 1080, assets.images)
    context.restore()
  }

  // Captions.
  if (project.captionStyle.show) {
    const caption = captionAt(project.captions, state.source)
    if (caption) {
      const box = document.createElement("canvas")
      box.width = Math.ceil(layout.width)
      box.height = Math.ceil(layout.height)
      const boxContext = box.getContext("2d")!
      const size = drawCaption(boxContext, caption, spokenWord(caption, state.source), project.captionStyle, layout.width, layout.height)
      if (size) {
        const motion = captionMotion(project.captionStyle, state.source - caption.start, caption.end - state.source)
        context.save()
        context.globalAlpha = motion.alpha
        const w = size.w * motion.scale
        const h = size.h * motion.scale
        const x = (layout.width - w) / 2
        const y = layout.height * (1 - project.captionStyle.bottom) - h + motion.rise * h
        context.drawImage(box, 0, 0, size.w, size.h, x, y, w, h)
        context.restore()
      }
    }
  }

  // Clicks, then the cursor.
  if (project.cursor.show && project.cursor.effect !== "off") {
    const duration = project.cursor.effectDuration / 1000
    for (const click of motion.clicks) {
      const since = edited - click.time
      if (since < 0 || since > duration) continue
      const point = toFrame(click.x, click.y, state.view, layout, videoWidth, videoHeight)
      drawClickEffect(context, project.cursor, point.x, point.y, since / duration, Math.min(layout.width, layout.height))
    }
  }
  if (state.cursor?.visible) {
    const blur = project.motion.blur !== false ? (project.motion.blurStrength ?? 0.35) * 1.7 : 0
    const before = blur ? frameState(project, motion, Math.max(0, edited - 1 / 30), layout, videoWidth, videoHeight, options.cameraAspect, Boolean(assets.camera)).cursor : null
    const speed = before ? Math.hypot(state.cursor.x - before.x, state.cursor.y - before.y) : 0
    if (before && speed > 6) {
      // A fast cursor leaves a soft trail along its path.
      const trail = Math.min(6, 2 + Math.round(speed / 12))
      for (let step = trail - 1; step >= 1; step -= 1) {
        const amount = (step / trail) * Math.min(1, blur * 0.6)
        context.save()
        context.globalAlpha = 0.18 * (1 - step / trail)
        drawCursor(context, { ...state.cursor, x: state.cursor.x + (before.x - state.cursor.x) * amount, y: state.cursor.y + (before.y - state.cursor.y) * amount }, project.cursor, options.sprites)
        context.restore()
      }
    }
    drawCursor(context, state.cursor, project.cursor, options.sprites)
  }
  context.restore()
  return state
}

export function letterbox(width: number, height: number, box: Rect): Rect {
  const scale = Math.min(box.w / width, box.h / height)
  const w = width * scale
  const h = height * scale
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

export function visibleAnnotations(project: EditProject, edited: number) {
  return project.annotations
    .filter((annotation) => edited >= annotation.start && edited <= annotation.end)
    .sort((left, right) => left.track - right.track)
}

function drawBlurBox(context: CanvasRenderingContext2D, annotation: Annotation, rect: Rect, scale: number, height: number) {
  const canvas = context.canvas
  const radius = (annotation.radius / 1080) * height
  context.save()
  context.beginPath()
  context.roundRect(rect.x, rect.y, rect.w, rect.h, radius)
  context.clip()
  if (annotation.fill) {
    context.fillStyle = annotation.fill
    context.fillRect(rect.x, rect.y, rect.w, rect.h)
  } else {
    // Blur a copy of what's drawn so far, inside the box.
    const copy = document.createElement("canvas")
    copy.width = canvas.width
    copy.height = canvas.height
    copy.getContext("2d")!.drawImage(canvas, 0, 0)
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.filter = `blur(${(annotation.strength / 1080) * height * scale * 0.6}px)`
    context.drawImage(copy, 0, 0)
  }
  context.restore()
}

function drawWebcam(context: CanvasRenderingContext2D, camera: Still, settings: WebcamSettings, rect: Rect & { radius: number }, scale: number) {
  const crop = settings.crop
  const sw = camera.width * crop.w
  const sh = camera.height * crop.h
  // Cover the box with the cropped camera picture.
  const fit = Math.max(rect.w / sw, rect.h / sh)
  const cw = rect.w / fit
  const ch = rect.h / fit
  const sx = camera.width * crop.x + (sw - cw) / 2
  const sy = camera.height * crop.y + (sh - ch) / 2
  if (settings.shadow > 0) {
    context.save()
    context.shadowColor = `rgba(0,0,0,${0.55 * settings.shadow})`
    context.shadowBlur = Math.min(rect.w, rect.h) * 0.12 * scale
    context.shadowOffsetY = Math.min(rect.w, rect.h) * 0.04 * scale
    context.beginPath()
    squircle(context, rect.x, rect.y, rect.w, rect.h, rect.radius)
    context.fillStyle = "#000"
    context.fill()
    context.restore()
  }
  context.save()
  context.beginPath()
  squircle(context, rect.x, rect.y, rect.w, rect.h, rect.radius)
  context.clip()
  if (settings.mirror) {
    context.translate(rect.x * 2 + rect.w, 0)
    context.scale(-1, 1)
  }
  context.drawImage(camera.image, sx, sy, cw, ch, rect.x, rect.y, rect.w, rect.h)
  context.restore()
}

export function drawCursor(context: CanvasRenderingContext2D, cursor: NonNullable<FrameState["cursor"]>, settings: CursorSettings, sprites: Map<string, CursorSprite>) {
  const sprite = sprites.get(`${settings.style}:${cursor.shape}`) || sprites.get(`${settings.style}:arrow`)
  if (!sprite) return
  const scale = cursor.size / sprite.size
  context.save()
  context.translate(cursor.x, cursor.y)
  context.rotate((cursor.rotation * Math.PI) / 180)
  context.scale(scale * (2 - cursor.squash), scale * cursor.squash)
  context.drawImage(sprite.canvas, -sprite.hotX, -sprite.hotY)
  context.restore()
}

/* The export */

export interface ExportOptions {
  resolution: Resolution
  fps: number
  format: "mp4" | "gif"
  gifFps: number
  gifSize: "medium" | "large" | "original"
  loop: boolean
  encoding: "fast" | "balanced" | "quality"
}

const toPng = (canvas: HTMLCanvasElement) => canvas.toDataURL("image/png").split(",")[1]

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  return { canvas, context: canvas.getContext("2d")! }
}

/**
 * Everything the native exporter needs: the clips, the pictures, and frame by frame where the
 * recording, the camera, the notes, the captions, the clicks and the cursor go.
 */
export async function exportSpec(project: EditProject, samples: PointerSample[], assets: Assets, sprites: Map<string, CursorSprite>, videoWidth: number, videoHeight: number, cameraAspect: number, options: ExportOptions) {
  const size = outputSize(project.scene, videoWidth, videoHeight, options.resolution, project.layout)
  const layout = layoutFor(project.scene, size.width, size.height, videoWidth, videoHeight, project.layout)
  const motion = motionFor(project, samples)
  const total = editedDuration(project)
  const fps = options.format === "gif" ? FPS : options.fps
  const frameCount = Math.max(1, Math.ceil(total * fps))
  const pictures: string[] = []
  const add = (canvas: HTMLCanvasElement) => pictures.push(toPng(canvas)) - 1

  // The background, the recording's shape (for corners and shadows) and the camera's.
  let background: Record<string, unknown> | null = null
  if (layout.framed && project.scene.background.kind !== "video") {
    const { canvas, context } = canvasOf(size.width, size.height)
    drawBackground(context, project, assets, size.width, size.height)
    background = { kind: "image", image: add(canvas) }
  } else if (layout.framed) {
    background = { kind: "video", blur: (project.scene.blur / 1080) * size.height * 2 }
  }
  const { canvas: shape, context: shapeContext } = canvasOf(layout.content.w, layout.content.h)
  shapeContext.fillStyle = "#fff"
  shapeContext.beginPath()
  squircle(shapeContext, 0, 0, layout.content.w, layout.content.h, layout.radius)
  shapeContext.fill()
  const contentMask = add(shape)

  const view: number[][] = []
  const cursor: number[][] = []
  const webcamTrack: number[][] = []
  for (let frame = 0; frame <= frameCount; frame += 1) {
    const edited = Math.min(total, frame / fps)
    const state = frameState(project, motion, edited, layout, videoWidth, videoHeight, cameraAspect, Boolean(assets.camera))
    view.push([round(edited * 1000) / 1000, round(state.view.x), round(state.view.y), round(state.view.w), round(state.view.h), state.other ? 1 : 0])
    if (state.webcam) webcamTrack.push([edited, round(state.webcam.x), round(state.webcam.y), round(state.webcam.w), round(state.webcam.h), round(state.webcam.radius), 1])
    else if (webcamTrack.length) webcamTrack.push([edited, 0, 0, 1, 1, 0, 0])
    if (state.cursor) cursor.push([edited, round(state.cursor.x), round(state.cursor.y), CURSOR_SHAPES.indexOf(state.cursor.shape as never), round(state.cursor.size), state.cursor.squash, round(state.cursor.rotation), state.cursor.visible ? 1 : 0])
  }

  // Cursor pictures for this style, each shape once.
  const cursorShapes = CURSOR_SHAPES.map((shape) => {
    const sprite = sprites.get(`${project.cursor.style}:${shape}`) || sprites.get(`${project.cursor.style}:arrow`) || cursorSprite(project.cursor.style, shape)
    return { sprite: add(sprite.canvas), hotX: sprite.hotX, hotY: sprite.hotY, size: sprite.size }
  })

  // Notes: pictures at the size they're shown; blur boxes are drawn by the exporter.
  const layers: Record<string, unknown>[] = []
  const scale = size.height / 1080
  for (const annotation of [...project.annotations].sort((left, right) => left.track - right.track)) {
    const rect = [annotation.x * size.width, annotation.y * size.height, annotation.w * size.width, annotation.h * size.height].map(round)
    if (annotation.kind === "blur") {
      layers.push({ kind: "blur", start: annotation.start, end: annotation.end, rect, amount: (annotation.strength / 1080) * size.height * 0.6, radius: annotation.radius * scale, fill: annotation.fill })
      continue
    }
    const { canvas, context } = canvasOf(rect[2], rect[3])
    drawAnnotation(context, annotation, rect[2], rect[3], scale, assets.images)
    layers.push({ kind: "picture", sprite: add(canvas), start: annotation.start, end: annotation.end, rect, fade: 0.15, motion: "none" })
  }

  // Captions: a picture for each word reached, placed where the caption box goes.
  if (project.captionStyle.show && project.captions?.length) {
    for (const caption of project.captions) {
      const words = Math.max(1, caption.words.length)
      for (let index = caption.words.length ? 0 : -1; index < words; index += 1) {
        const from = caption.words.length ? caption.words[index].start : caption.start
        const to = caption.words.length ? (caption.words[index + 1]?.start ?? caption.end) : caption.end
        const start = toEdited(project, Math.max(caption.start, from))
        const end = toEdited(project, Math.min(caption.end, to))
        if (start === null || end === null || end <= start) continue
        const { canvas, context } = canvasOf(size.width, size.height)
        const box = drawCaption(context, caption, caption.words.length ? index : Infinity, project.captionStyle, size.width, size.height)
        if (!box) continue
        const { canvas: crop, context: cropContext } = canvasOf(box.w, box.h)
        cropContext.drawImage(canvas, 0, 0)
        const first = index <= 0
        const lastWord = index === words - 1 || !caption.words.length
        const anim = project.captionStyle.animation
        layers.push({
          kind: "picture",
          sprite: add(crop),
          start,
          end,
          rect: [round((size.width - box.w) / 2), round(size.height * (1 - project.captionStyle.bottom) - box.h), round(box.w), round(box.h)],
          fadeIn: first && anim !== "off" ? 0.18 : 0,
          fadeOut: lastWord && anim !== "off" ? 0.18 : 0,
          motion: first ? (anim === "rise" ? "rise" : anim === "pop" ? "pop" : "none") : "none",
        })
      }
    }
  }

  // Click effects, as short animations.
  const effects: Record<string, unknown>[] = []
  if (project.cursor.show && project.cursor.effect !== "off") {
    const duration = project.cursor.effectDuration / 1000
    const unit = Math.min(size.width, size.height)
    const reach = unit * 0.045 * project.cursor.effectSize * 2.4
    for (const click of motion.clicks) {
      const state = frameState(project, motion, click.time, layout, videoWidth, videoHeight, cameraAspect, false)
      const point = toFrame(click.x, click.y, state.view, layout, videoWidth, videoHeight)
      const frames: number[] = []
      const steps = Math.max(2, Math.round(duration * fps))
      const sprites: number[] = []
      for (let step = 0; step <= steps; step += 1) {
        const { canvas, context } = canvasOf(reach * 2, reach * 2)
        drawClickEffect(context, project.cursor, reach, reach, step / steps, unit)
        sprites.push(add(canvas))
        frames.push(click.time + (step / steps) * duration)
      }
      effects.push({ rect: [round(point.x - reach), round(point.y - reach), round(reach * 2), round(reach * 2)], frames: frames.map((time, index) => [time, sprites[index]]) })
    }
  }

  // Sound: the clips' mute, the recording's volume, and added audio.
  const muted = placeClips(project.clips)
    .filter((placed) => placed.clip.muted)
    .map((placed) => [placed.from, placed.to])
  const crop = layout.fill || croppedSource(project.scene, videoWidth, videoHeight)

  // Other recordings the clips come from, numbered from 1 (0 is this recording).
  const others = [...new Set(project.clips.filter((clip) => clip.source).map((clip) => clip.source!.id))]
  return {
    clips: project.clips.map((clip) => [clip.start, clip.end, clip.speed, clip.source ? others.indexOf(clip.source.id) + 1 : 0]),
    sources: others,
    width: size.width,
    height: size.height,
    fps,
    content: [layout.content.x, layout.content.y, layout.content.w, layout.content.h].map(round),
    contentMask,
    shadows: layout.shadows.map((shadow) => [round(shadow.blur), round(shadow.offset), round(shadow.opacity)]),
    background,
    crop: [crop.x, crop.y, crop.w, crop.h].map(round),
    view,
    webcam:
      assets.camera && project.webcam.show && webcamTrack.length
        ? {
            track: webcamTrack,
            mirror: project.webcam.mirror,
            shadow: layout.camera ? 0 : project.webcam.shadow,
            crop: [project.webcam.crop.x, project.webcam.crop.y, project.webcam.crop.w, project.webcam.crop.h],
          }
        : null,
    sprites: pictures,
    layers,
    effects,
    cursorSprites: cursorShapes,
    cursor: project.cursor.show ? cursor : [],
    audio: {
      volume: project.sound.volume * (project.sound.normalize ? 1.35 : 1),
      systemVolume: project.sound.systemVolume,
      muted,
      extras: project.audio.map((block) => ({ file: block.file, start: block.start, duration: block.duration, offset: block.offset || 0, volume: block.volume * (block.normalize ? 1.35 : 1) })),
    },
    gif: options.format === "gif" ? { fps: options.gifFps, width: options.gifSize === "original" ? size.width : options.gifSize === "large" ? Math.round((1080 * size.width) / size.height) : Math.round((720 * size.width) / size.height), loop: options.loop } : null,
    encoding: options.encoding,
    motionBlur: project.motion.blur !== false ? [project.motion.blurStrength ?? 0.35, (project.motion.blurStrength ?? 0.35) * 1.7] : null,
  }
}

export type ExportSpecV2 = Awaited<ReturnType<typeof exportSpec>>
