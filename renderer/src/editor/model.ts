// Ember's recording editor: a non-destructive edit of a recording, kept beside it as edit.json.
// The original video is never changed.
//
// The edit is a sequence of clips, each a stretch of the recording at a speed, played back to back
// (deleting or speeding up a clip closes the gap; clips can be reordered). Everything else with a time
// (zooms, markers, notes, audio) is in the edited video's time, and is re-anchored to the moment of
// the recording it belongs to whenever the clips change, so it moves with them.

/* Types */

export interface Clip {
  id: string
  start: number
  end: number
  speed: number
  muted: boolean
  /** Another recording this clip comes from; none means this recording. */
  source?: { id: string; title: string; width: number; height: number; duration: number }
}

export type ZoomMode = "auto" | "manual"

/** A zoom, in the edited video's time. x and y (0 to 1 across the picture) are where a manual zoom looks. */
export interface Zoom {
  id: string
  start: number
  end: number
  depth: number
  mode: ZoomMode
  x: number
  y: number
  suggested: boolean
  /** The webcam's size during this zoom (1 = its own size); empty uses the webcam's setting. */
  webcamSize?: number | null
}

export interface Marker {
  id: string
  time: number
}

export type AnnotationKind = "text" | "image" | "arrow" | "blur"
export type ArrowDirection = "up" | "down" | "left" | "right" | "up-left" | "up-right" | "down-left" | "down-right"

/** A note over the video: x, y, w, h are 0 to 1 across the finished frame. */
export interface Annotation {
  id: string
  kind: AnnotationKind
  track: number
  start: number
  end: number
  x: number
  y: number
  w: number
  h: number
  text: string
  font: string
  size: number
  bold: boolean
  italic: boolean
  underline: boolean
  align: "left" | "center" | "right"
  color: string
  background: string | null
  radius: number
  image: string | null
  direction: ArrowDirection
  stroke: number
  strength: number
  fill: string | null
}

/** A sound under the video: a file, from a moment of the edited video. */
export interface AudioBlock {
  id: string
  track: number
  start: number
  duration: number
  file: string
  name: string
  volume: number
  normalize: boolean
  /** Where in the file it starts playing (for a clip's own sound, separated from it). */
  offset: number
}

export interface CaptionWord {
  text: string
  start: number
  end: number
}

/** A caption, in the recording's time (so it follows its clip), with each word's timing. */
export interface Caption {
  id: string
  start: number
  end: number
  text: string
  words: CaptionWord[]
}

export type BackgroundKind = "none" | "wallpaper" | "image" | "video" | "color" | "gradient"

export interface Scene {
  background: { kind: BackgroundKind; value: string }
  blur: number
  shadow: number
  radius: number
  padding: { top: number; bottom: number; left: number; right: number; linked: boolean }
  aspect: string
  crop: { top: number; bottom: number; left: number; right: number }
}

export type CursorStyle = "tahoe" | "tahoe-inverted" | "macos" | "windows" | "dot" | "minimal"
export type ClickEffect = "off" | "ripple" | "spotlight" | "echo"

export interface CursorSettings {
  show: boolean
  style: CursorStyle
  size: number
  smoothing: number
  bounce: number
  bounceSpeed: number
  sway: number
  effect: ClickEffect
  effectColor: string
  effectSize: number
  effectOpacity: number
  effectDuration: number
  loop: boolean
}

export type WebcamPosition = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right" | "custom"

export interface WebcamSettings {
  show: boolean
  size: number
  width: number | null
  height: number | null
  crop: { x: number; y: number; w: number; h: number }
  position: WebcamPosition
  x: number
  y: number
  margin: number
  roundness: number
  shadow: number
  mirror: boolean
  reactsToZoom: boolean
  /** Its size while zoomed in, 1 being its own size; each zoom can set its own. */
  zoomSize: number
  file: string | null
}

export interface SoundSettings {
  volume: number
  normalize: boolean
  systemVolume: number
  micVolume: number
}

export type CaptionAnimation = "off" | "fade" | "rise" | "pop"

export interface CaptionStyle {
  show: boolean
  fontSize: number
  color: string
  inactiveColor: string
  rows: number
  bottom: number
  maxWidth: number
  boxRadius: number
  background: number
  animation: CaptionAnimation
  sidecar: boolean
  hoverAdd: boolean
}

export type MotionPreset = "focused" | "smooth"

export interface MotionSettings {
  preset: MotionPreset
  classic: boolean
  connect: boolean
  blur: boolean
  /** How strong motion blur is, 0 to 1. */
  blurStrength: number
}

export type LayoutPreset = "bubble" | "side-by-side" | "side-by-side-right" | "stacked" | "camera" | "screen"

/**
 * How the screen and the camera share the frame. Bubble is the camera over the screen; the others
 * split the frame edge to edge (the screen is cropped to its part, at screenX/screenY).
 */
export interface LayoutSettings {
  preset: LayoutPreset
  /** The camera's share of the frame in side by side and stacked: a third by default. */
  split: number
  /** Which part of the screen shows when it's cropped: 0 is the left (or top) edge, 1 the right. */
  screenX: number
  screenY: number
}

export interface EditProject {
  version: 2
  layout: LayoutSettings
  clips: Clip[]
  zooms: Zoom[]
  markers: Marker[]
  annotations: Annotation[]
  audio: AudioBlock[]
  captions: Caption[] | null
  scene: Scene
  cursor: CursorSettings
  webcam: WebcamSettings
  sound: SoundSettings
  captionStyle: CaptionStyle
  motion: MotionSettings
}

/** [seconds, x, y, pressed, shape]: x and y are 0 to 1 across the recording. */
export type PointerSample = number[]

/* Constants */

export const ZOOM_DEPTHS = [1.25, 1.5, 1.8, 2.2, 3.5, 5]
export const SPEED_MIN = 0.25
export const SPEED_MAX = 4
export const MIN_CLIP = 0.2
export const MIN_BLOCK = 0.3

let counter = 0
export const newId = (prefix = "e") => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = (value: number) => Math.round(value * 1000) / 1000
const number = (value: unknown, fallback: number, min = -Infinity, max = Infinity) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback
}
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback)
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback)

/* Defaults */

export const DEFAULT_SCENE: Scene = {
  background: { kind: "none", value: "" },
  blur: 0,
  shadow: 0.67,
  radius: 0.08,
  padding: { top: 0.08, bottom: 0.08, left: 0.08, right: 0.08, linked: true },
  aspect: "native",
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
}

export const DEFAULT_CURSOR: CursorSettings = {
  show: true,
  style: "tahoe",
  size: 3,
  smoothing: 0.67,
  bounce: 2,
  bounceSpeed: 350,
  sway: 0.4,
  effect: "off",
  effectColor: "#2563EB",
  effectSize: 1,
  effectOpacity: 0.8,
  effectDuration: 600,
  loop: false,
}

export const DEFAULT_WEBCAM: WebcamSettings = {
  show: true,
  size: 0.4,
  width: null,
  height: null,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  position: "bottom-right",
  x: 0.85,
  y: 0.8,
  margin: 24,
  roundness: 100,
  shadow: 0.3,
  mirror: true,
  reactsToZoom: true,
  zoomSize: 0.75,
  file: null,
}

export const DEFAULT_SOUND: SoundSettings = { volume: 1, normalize: false, systemVolume: 1, micVolume: 1 }

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  show: true,
  fontSize: 30,
  color: "#FFFFFF",
  inactiveColor: "#A3A3A3",
  rows: 1,
  bottom: 0.03,
  maxWidth: 0.62,
  boxRadius: 17.5,
  background: 0.9,
  animation: "fade",
  sidecar: false,
  hoverAdd: true,
}

export const DEFAULT_LAYOUT: LayoutSettings = { preset: "bubble", split: 1 / 3, screenX: 0.5, screenY: 0.5 }

export const LAYOUT_PRESETS: LayoutPreset[] = ["bubble", "side-by-side", "side-by-side-right", "stacked", "camera", "screen"]

export const DEFAULT_MOTION: MotionSettings = { preset: "smooth", classic: false, connect: true, blur: true, blurStrength: 0.35 }

export function newAnnotation(kind: AnnotationKind, start: number, track = 0): Annotation {
  return {
    id: newId("a"),
    kind,
    track,
    start: round(start),
    end: round(start + 3),
    x: kind === "arrow" ? 0.45 : 0.3,
    y: kind === "arrow" ? 0.4 : 0.4,
    w: kind === "arrow" ? 0.1 : kind === "text" ? 0.4 : 0.3,
    h: kind === "arrow" ? 0.15 : kind === "text" ? 0.12 : 0.25,
    text: kind === "text" ? "Your text" : "",
    font: "classic",
    size: 32,
    bold: true,
    italic: false,
    underline: false,
    align: "center",
    color: "#FFFFFF",
    background: null,
    radius: 12,
    image: null,
    direction: "down-right",
    stroke: 4,
    strength: 20,
    fill: null,
  }
}

/** A new edit: the whole recording as one clip, zooms on its clicks, and the camera where the bubble was. */
export function newProject(
  duration: number,
  _pointer: PointerSample[] | null,
  options: { camera?: { x: number; y: number; size: number } | null; defaults?: Partial<EditProject> | null } = {},
): EditProject {
  const defaults = options.defaults || {}
  const project: EditProject = {
    version: 2,
    layout: { ...DEFAULT_LAYOUT, ...(defaults.layout || {}) },
    clips: [{ id: newId("c"), start: 0, end: round(duration), speed: 1, muted: false }],
    zooms: [],
    markers: [],
    annotations: [],
    audio: [],
    captions: null,
    scene: { ...DEFAULT_SCENE, ...(defaults.scene || {}) },
    cursor: { ...DEFAULT_CURSOR, ...(defaults.cursor || {}) },
    webcam: { ...DEFAULT_WEBCAM, ...(defaults.webcam || {}) },
    sound: { ...DEFAULT_SOUND, ...(defaults.sound || {}) },
    captionStyle: { ...DEFAULT_CAPTION_STYLE, ...(defaults.captionStyle || {}) },
    motion: { ...DEFAULT_MOTION, ...(defaults.motion || {}) },
  }
  if (options.camera) {
    project.webcam = { ...project.webcam, position: "custom", x: options.camera.x, y: options.camera.y, size: clamp(options.camera.size * 1.25, 0.1, 1) }
  }
  return project
}

/**
 * The webcam as a recording plays before it's edited: a square with slightly rounded corners,
 * bottom left, clear of the edges. The recording page and the finished version both use it.
 */
export function plainWebcam(_camera?: { size: number } | null): WebcamSettings {
  // A third of the frame's height (its short side): big enough to see a face clearly.
  const side = 0.3
  return { ...DEFAULT_WEBCAM, position: "bottom-left", width: side, height: side, size: side * 2, margin: 32, roundness: 18, shadow: 0.3, reactsToZoom: false }
}

/** A recording as it's shared before any editing: the screen as recorded, the plain webcam, the cursor, no zooms. */
export function plainProject(duration: number, camera: { x: number; y: number; size: number } | null | undefined): EditProject {
  const project = newProject(duration, null)
  return {
    ...project,
    layout: { ...DEFAULT_LAYOUT },
    scene: { ...DEFAULT_SCENE, background: { kind: "none", value: "" } },
    webcam: plainWebcam(camera),
    cursor: { ...DEFAULT_CURSOR, effect: "off" },
    motion: { ...DEFAULT_MOTION, blur: false },
    captionStyle: { ...DEFAULT_CAPTION_STYLE, show: false },
  }
}

/** The styling of an edit, without its content: what presets and remembered defaults hold. */
export function styleOf(project: EditProject): Partial<EditProject> {
  return {
    layout: project.layout,
    scene: project.scene,
    cursor: project.cursor,
    webcam: { ...project.webcam, file: null },
    sound: project.sound,
    captionStyle: project.captionStyle,
    motion: project.motion,
  }
}

/* Reading edits from disk, including the first version's format */

function normalizeScene(raw: Partial<Scene> | undefined): Scene {
  const scene = raw || {}
  const kinds = ["none", "wallpaper", "image", "video", "color", "gradient"] as const
  const padding = (scene.padding || {}) as Partial<Scene["padding"]>
  const crop = (scene.crop || {}) as Partial<Scene["crop"]>
  return {
    background: { kind: oneOf(scene.background?.kind, kinds, "none"), value: text(scene.background?.value, "") },
    blur: number(scene.blur, 0, 0, 8),
    shadow: number(scene.shadow, DEFAULT_SCENE.shadow, 0, 1),
    radius: number(scene.radius, DEFAULT_SCENE.radius, 0, 0.5),
    padding: {
      top: number(padding.top, 0.08, 0, 0.5),
      bottom: number(padding.bottom, 0.08, 0, 0.5),
      left: number(padding.left, 0.08, 0, 0.25),
      right: number(padding.right, 0.08, 0, 0.25),
      linked: bool(padding.linked, true),
    },
    aspect: /^(native|\d+(\.\d+)?:\d+(\.\d+)?)$/.test(String(scene.aspect)) ? String(scene.aspect) : "native",
    crop: {
      top: number(crop.top, 0, 0, 0.45),
      bottom: number(crop.bottom, 0, 0, 0.45),
      left: number(crop.left, 0, 0, 0.45),
      right: number(crop.right, 0, 0, 0.45),
    },
  }
}

/** The first editor's colours become gradients of the same name. */
const V1_BACKGROUNDS: Record<string, string> = {
  ember: "ember",
  graphite: "graphite",
  midnight: "midnight",
  ocean: "ocean",
  forest: "forest",
  sand: "sand",
  paper: "paper",
}

function fromVersion1(raw: Record<string, unknown>, duration: number): EditProject {
  const project = newProject(duration, null)
  const segments = Array.isArray(raw.segments) ? (raw.segments as { start: number; end: number; speed: number; removed: boolean }[]) : []
  const clips = segments
    .filter((segment) => !segment.removed && Number(segment.end) > Number(segment.start))
    .map((segment) => ({ id: newId("c"), start: Number(segment.start), end: Number(segment.end), speed: Number(segment.speed) || 1, muted: false }))
  if (clips.length) project.clips = clips
  const look = (raw.look || {}) as { background?: string; padding?: number; radius?: number; shadow?: boolean; aspect?: string }
  const gradient = V1_BACKGROUNDS[look.background || ""]
  project.scene = normalizeScene({
    background: gradient ? { kind: "gradient", value: gradient } : { kind: "none", value: "" },
    radius: (look.radius || 0) * 1.4,
    shadow: look.shadow ? 0.67 : 0,
    padding: { top: look.padding || 0, bottom: look.padding || 0, left: look.padding || 0, right: look.padding || 0, linked: true },
    aspect: look.aspect,
  } as Partial<Scene>)
  // Zooms were in the recording's time: they're placed where those moments now play.
  const zooms = Array.isArray(raw.zooms) ? (raw.zooms as { start: number; end: number; scale: number; x: number; y: number; follow: boolean; auto: boolean }[]) : []
  project.zooms = zooms
    .map((zoom) => {
      const start = toEdited(project, Number(zoom.start))
      const end = toEdited(project, Number(zoom.end))
      if (start === null || end === null || end <= start) return null
      return { id: newId("z"), start, end, depth: Number(zoom.scale) || 1.8, mode: zoom.follow ? "auto" : "manual", x: Number(zoom.x) || 0.5, y: Number(zoom.y) || 0.5, suggested: Boolean(zoom.auto) } as Zoom
    })
    .filter(Boolean) as Zoom[]
  return project
}

/** Anything read from disk, made safe to edit; null when it isn't an edit at all. */
export function normalizeProject(raw: unknown, duration: number): EditProject | null {
  if (!raw || typeof raw !== "object") return null
  const data = raw as Record<string, unknown>
  if (data.version !== 2) return Array.isArray(data.segments) ? fromVersion1(data, duration) : null
  const clips = (Array.isArray(data.clips) ? (data.clips as Partial<Clip>[]) : [])
    .map((clip) => {
      const source = clip.source && typeof clip.source.id === "string" ? clip.source : undefined
      const length = source ? number(source.duration, 1, 0.1, 36000) : duration
      return {
        id: text(clip.id, newId("c")),
        start: number(clip.start, 0, 0, length),
        end: number(clip.end, length, 0, length),
        speed: number(clip.speed, 1, SPEED_MIN, SPEED_MAX),
        muted: bool(clip.muted, false),
        ...(source ? { source: { id: source.id, title: text(source.title, "Recording"), width: number(source.width, 1920, 2, 10000), height: number(source.height, 1080, 2, 10000), duration: length } } : {}),
      }
    })
    .filter((clip) => clip.end - clip.start >= 0.05)
  if (!clips.length) return null
  const total = clips.reduce((sum, clip) => sum + (clip.end - clip.start) / clip.speed, 0)
  const within = <T extends { start: number; end: number }>(item: T) => item.end > item.start && item.start < total
  const defaults = newProject(duration, null)
  const annotationKinds = ["text", "image", "arrow", "blur"] as const
  const directions = ["up", "down", "left", "right", "up-left", "up-right", "down-left", "down-right"] as const
  const layout = (data.layout || {}) as Partial<LayoutSettings>
  return {
    version: 2,
    layout: {
      preset: oneOf(layout.preset, LAYOUT_PRESETS, "bubble"),
      split: number(layout.split, 1 / 3, 0.2, 0.6),
      screenX: number(layout.screenX, 0.5, 0, 1),
      screenY: number(layout.screenY, 0.5, 0, 1),
    },
    clips,
    zooms: (Array.isArray(data.zooms) ? (data.zooms as Partial<Zoom>[]) : [])
      .map((zoom) => ({
        id: text(zoom.id, newId("z")),
        start: number(zoom.start, 0, 0, total),
        end: number(zoom.end, 0, 0, total),
        depth: number(zoom.depth, 1.8, 1.05, 6),
        mode: oneOf(zoom.mode, ["auto", "manual"] as const, "auto"),
        x: number(zoom.x, 0.5, 0, 1),
        y: number(zoom.y, 0.5, 0, 1),
        suggested: bool(zoom.suggested, false),
        webcamSize: typeof zoom.webcamSize === "number" ? number(zoom.webcamSize, 0.75, 0.2, 1.5) : null,
      }))
      .filter(within),
    markers: (Array.isArray(data.markers) ? (data.markers as Partial<Marker>[]) : []).map((marker) => ({ id: text(marker.id, newId("m")), time: number(marker.time, 0, 0, total) })),
    annotations: (Array.isArray(data.annotations) ? (data.annotations as Partial<Annotation>[]) : [])
      .map((item) => {
        const base = newAnnotation(oneOf(item.kind, annotationKinds, "text"), 0)
        return {
          ...base,
          ...item,
          id: text(item.id, base.id),
          kind: oneOf(item.kind, annotationKinds, "text"),
          track: number(item.track, 0, 0, 20),
          start: number(item.start, 0, 0, total),
          end: number(item.end, 0, 0, total),
          x: number(item.x, base.x, -0.5, 1.5),
          y: number(item.y, base.y, -0.5, 1.5),
          w: number(item.w, base.w, 0.01, 2),
          h: number(item.h, base.h, 0.01, 2),
          size: number(item.size, 32, 8, 200),
          direction: oneOf(item.direction, directions, "down-right"),
          stroke: number(item.stroke, 4, 1, 6),
          strength: number(item.strength, 20, 1, 100),
        } as Annotation
      })
      .filter(within),
    audio: (Array.isArray(data.audio) ? (data.audio as Partial<AudioBlock>[]) : [])
      .filter((block) => typeof block.file === "string" && block.file)
      .map((block) => ({
        id: text(block.id, newId("s")),
        track: number(block.track, 0, 0, 20),
        start: number(block.start, 0, 0, total),
        duration: number(block.duration, 1, 0.1, 36000),
        file: String(block.file),
        name: text(block.name, "Audio"),
        volume: number(block.volume, 1, 0, 1),
        normalize: bool(block.normalize, false),
        offset: number(block.offset, 0, 0, 36000),
      })),
    captions: Array.isArray(data.captions)
      ? (data.captions as Partial<Caption>[])
          .filter((caption) => Number(caption.end) > Number(caption.start))
          .map((caption) => ({
            id: text(caption.id, newId("t")),
            start: Number(caption.start),
            end: Number(caption.end),
            text: text(caption.text, ""),
            words: Array.isArray(caption.words) ? caption.words.filter((word) => word && typeof word.text === "string") : [],
          }))
      : null,
    scene: normalizeScene(data.scene as Partial<Scene>),
    cursor: {
      ...defaults.cursor,
      ...((data.cursor || {}) as Partial<CursorSettings>),
      style: oneOf((data.cursor as CursorSettings)?.style, ["tahoe", "tahoe-inverted", "macos", "windows", "dot", "minimal"] as const, "tahoe"),
      size: number((data.cursor as CursorSettings)?.size, 3, 0.5, 10),
      effect: oneOf((data.cursor as CursorSettings)?.effect, ["off", "ripple", "spotlight", "echo"] as const, "off"),
    },
    webcam: { ...defaults.webcam, ...((data.webcam || {}) as Partial<WebcamSettings>) },
    sound: { ...defaults.sound, ...((data.sound || {}) as Partial<SoundSettings>) },
    captionStyle: { ...defaults.captionStyle, ...((data.captionStyle || {}) as Partial<CaptionStyle>) },
    motion: {
      ...defaults.motion,
      ...((data.motion || {}) as Partial<MotionSettings>),
      preset: oneOf((data.motion as MotionSettings)?.preset, ["focused", "smooth"] as const, "smooth"),
      blurStrength: Math.min(1, Math.max(0, Number((data.motion as MotionSettings)?.blurStrength ?? defaults.motion.blurStrength) || 0)),
    },
  }
}

/* Time */

export interface Placed {
  clip: Clip
  index: number
  from: number
  to: number
}

/** Where each clip plays in the edited video. */
export function placeClips(clips: Clip[]): Placed[] {
  let at = 0
  return clips.map((clip, index) => {
    const length = (clip.end - clip.start) / clip.speed
    const placed = { clip, index, from: at, to: at + length }
    at += length
    return placed
  })
}

export function editedDuration(project: Pick<EditProject, "clips">) {
  return project.clips.reduce((sum, clip) => sum + (clip.end - clip.start) / clip.speed, 0)
}

/** The clip playing at a moment of the edited video. */
export function clipAt(project: Pick<EditProject, "clips">, edited: number): Placed {
  const placed = placeClips(project.clips)
  return placed.find((item) => edited < item.to) || placed[placed.length - 1]
}

/** The moment of the recording that plays at a moment of the edited video. */
export function toSource(project: Pick<EditProject, "clips">, edited: number): number {
  const placed = clipAt(project, edited)
  return clamp(placed.clip.start + (edited - placed.from) * placed.clip.speed, placed.clip.start, placed.clip.end)
}

/** Where a moment of the recording plays in the edited video (its first appearance), or null when it's cut. */
export function toEdited(project: Pick<EditProject, "clips">, source: number, preferClip?: string): number | null {
  const placed = placeClips(project.clips)
  const inside = (item: Placed) => !item.clip.source && source >= item.clip.start && source < item.clip.end + 1e-6
  const match = (preferClip && placed.find((item) => item.clip.id === preferClip && inside(item))) || placed.find(inside)
  return match ? match.from + (source - match.clip.start) / match.clip.speed : null
}

/* Changing clips, with everything re-anchored */

interface Anchor {
  clip: string
  source: number
}

function anchorOf(project: Pick<EditProject, "clips">, edited: number): Anchor {
  const placed = clipAt(project, edited)
  return { clip: placed.clip.id, source: placed.clip.start + (edited - placed.from) * placed.clip.speed }
}

/** Where an anchored moment plays now: in its clip if it's still there, else wherever that moment plays. */
function placeAnchor(project: Pick<EditProject, "clips">, anchor: Anchor): number | null {
  // In its own clip if that's still there (which also covers clips from other recordings).
  const placed = placeClips(project.clips).find((item) => item.clip.id === anchor.clip && anchor.source >= item.clip.start && anchor.source < item.clip.end + 1e-6)
  if (placed) return placed.from + (anchor.source - placed.clip.start) / placed.clip.speed
  return toEdited(project, anchor.source, anchor.clip)
}

/**
 * New clips, with zooms, markers, notes and audio moved to where their moments of the recording now
 * play. Things whose moment was cut are dropped (zooms, markers) or kept at the cut (notes, audio).
 */
export function withClips(project: EditProject, clips: Clip[]): EditProject {
  if (!clips.length) return project
  const next = { ...project, clips }
  // Where a deleted clip was: the start of the first clip after it that's still there.
  const cutAt = (edited: number) => {
    const old = clipAt(project, edited)
    const after = project.clips.slice(old.index + 1).find((clip) => clips.some((kept) => kept.id === clip.id))
    const placed = placeClips(clips)
    return after ? placed.find((item) => item.clip.id === after.id)!.from : editedDuration(next)
  }
  const moveRange = <T extends { start: number; end: number }>(item: T, keepIfCut: boolean): T | null => {
    const start = placeAnchor(next, anchorOf(project, item.start))
    if (start === null && !keepIfCut) return null
    const length = item.end - item.start
    const at = start ?? cutAt(item.start)
    const total = editedDuration(next)
    const from = clamp(at, 0, Math.max(0, total - MIN_BLOCK))
    return { ...item, start: round(from), end: round(Math.min(total, from + length)) }
  }
  next.zooms = project.zooms.map((zoom) => moveRange(zoom, false)).filter(Boolean) as Zoom[]
  next.annotations = project.annotations.map((item) => moveRange(item, true)).filter(Boolean) as Annotation[]
  next.markers = project.markers
    .map((marker) => {
      const time = placeAnchor(next, anchorOf(project, marker.time))
      return time === null ? null : { ...marker, time: round(time) }
    })
    .filter(Boolean) as Marker[]
  next.audio = project.audio.map((block) => {
    const start = placeAnchor(next, anchorOf(project, block.start)) ?? cutAt(block.start)
    return { ...block, start: round(clamp(start, 0, editedDuration(next))) }
  })
  return next
}

/** Splits the clip playing at a moment of the edited video; nothing happens too close to a cut. */
export function splitAt(project: EditProject, edited: number): EditProject {
  const placed = clipAt(project, edited)
  const at = placed.clip.start + (edited - placed.from) * placed.clip.speed
  if (at - placed.clip.start < MIN_CLIP || placed.clip.end - at < MIN_CLIP) return project
  const clips = [...project.clips]
  clips.splice(placed.index, 1, { ...placed.clip, end: round(at) }, { ...placed.clip, id: newId("c"), start: round(at) })
  return withClips(project, clips)
}

export function deleteClip(project: EditProject, index: number): EditProject {
  if (project.clips.length <= 1) return project
  return withClips(project, project.clips.filter((_, position) => position !== index))
}

export function updateClip(project: EditProject, index: number, changes: Partial<Clip>): EditProject {
  const clips = project.clips.map((clip, position) => {
    if (position !== index) return clip
    const next = { ...clip, ...changes }
    next.speed = clamp(Math.round(next.speed * 4) / 4, SPEED_MIN, SPEED_MAX)
    return next
  })
  return withClips(project, clips)
}

/** Moves one edge of a clip within the recording; the clips after it close up or make room. */
export function trimClip(project: EditProject, index: number, edge: "start" | "end", source: number, ownDuration: number): EditProject {
  const clip = project.clips[index]
  if (!clip) return project
  const duration = clip.source?.duration ?? ownDuration
  const changes =
    edge === "start" ? { start: round(clamp(source, 0, clip.end - MIN_CLIP)) } : { end: round(clamp(source, clip.start + MIN_CLIP, duration)) }
  return withClips(project, project.clips.map((item, position) => (position === index ? { ...item, ...changes } : item)))
}

/** Moves a clip to another place in the sequence. */
export function moveClip(project: EditProject, from: number, to: number): EditProject {
  if (from === to || from < 0 || from >= project.clips.length) return project
  const clips = [...project.clips]
  const [clip] = clips.splice(from, 1)
  clips.splice(clamp(to, 0, clips.length), 0, clip)
  return withClips(project, clips)
}

/* Blocks on the timeline */

export function updateZoom(project: EditProject, id: string, changes: Partial<Zoom>): EditProject {
  return { ...project, zooms: project.zooms.map((zoom) => (zoom.id === id ? { ...zoom, ...changes, suggested: changes.suggested ?? false } : zoom)) }
}

export function addZoom(project: EditProject, at: number, length = 1): { project: EditProject; id: string } {
  const total = editedDuration(project)
  const start = clamp(at, 0, Math.max(0, total - MIN_BLOCK))
  const zoom: Zoom = { id: newId("z"), start: round(start), end: round(Math.min(total, start + Math.max(length, 1))), depth: 1.8, mode: "auto", x: 0.5, y: 0.5, suggested: false }
  return { project: { ...project, zooms: [...project.zooms, zoom].sort((left, right) => left.start - right.start) }, id: zoom.id }
}

/** Free stretches of the zoom row, longer than a length. */
export function freeSlots(zooms: Zoom[], total: number, length: number): [number, number][] {
  const sorted = [...zooms].sort((left, right) => left.start - right.start)
  const slots: [number, number][] = []
  let at = 0
  for (const zoom of sorted) {
    if (zoom.start - at >= length) slots.push([at, zoom.start])
    at = Math.max(at, zoom.end)
  }
  if (total - at >= length) slots.push([at, total])
  return slots
}

/** The nearest edge of anything else on the timeline, within a few pixels' worth of time. */
export function snapTime(time: number, edges: number[], tolerance: number): number {
  let best = time
  let distance = tolerance
  for (const edge of edges) {
    const gap = Math.abs(edge - time)
    if (gap < distance) {
      distance = gap
      best = edge
    }
  }
  return best
}

/** Where everything on the timeline starts and ends, for snapping. */
export function timelineEdges(project: EditProject, except?: string): number[] {
  const edges = new Set<number>([0, editedDuration(project)])
  for (const placed of placeClips(project.clips)) edges.add(placed.from)
  for (const zoom of project.zooms) if (zoom.id !== except) (edges.add(zoom.start), edges.add(zoom.end))
  for (const item of project.annotations) if (item.id !== except) (edges.add(item.start), edges.add(item.end))
  for (const block of project.audio) if (block.id !== except) (edges.add(block.start), edges.add(block.start + block.duration))
  for (const marker of project.markers) edges.add(marker.time)
  return [...edges]
}

/** True when the edit changes nothing, so exporting would just copy the recording. */
export function isUnedited(project: EditProject, duration: number) {
  const [clip] = project.clips
  return (
    project.clips.length === 1 &&
    clip.start <= 0.01 &&
    clip.end >= duration - 0.01 &&
    clip.speed === 1 &&
    !clip.muted &&
    !project.zooms.length &&
    !project.annotations.length &&
    !project.audio.length &&
    !(project.captions?.length && project.captionStyle.show) &&
    project.scene.background.kind === "none" &&
    (project.layout?.preset ?? "bubble") === "bubble" &&
    project.scene.aspect === "native" &&
    !Object.values(project.scene.crop).some(Boolean)
  )
}
