// How the picture and the cursor move, worked out for every frame of the edited video. The preview
// and the export both read these tracks, so the export moves exactly like the preview.
import {
  clipAt,
  editedDuration,
  freeSlots,
  newId,
  toEdited,
  type CursorSettings,
  type EditProject,
  type MotionSettings,
  type PointerSample,
  type Zoom,
} from "./model"

/** How often motion is worked out: twice the video's usual rate, so it glides between frames. */
export const FPS = 60

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const ease = (value: number) => (value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2)

/** The motion presets: how quickly zooms happen and how springy the camera and cursor are. */
export const PRESETS = {
  focused: { lead: 0.2, zoomIn: 0.2, zoomOut: 0.2, cameraSpring: 22, cameraDamping: 0.95, cursorScale: 1 },
  smooth: { lead: 0.5, zoomIn: 1.5, zoomOut: 1.0, cameraSpring: 5.5, cameraDamping: 1, cursorScale: 1 },
} as const

/** How close two zooms must be to glide from one to the next. */
export const CONNECT_GAP = 1.4
/** How near the edge of a zoomed view the pointer gets before an auto zoom moves. */
export const EDGE_SNAP = 0.25

/* The pointer, read from the recording's samples */

export interface PointerState {
  x: number
  y: number
  pressed: boolean
  shape: number
}

export function pointerAt(samples: PointerSample[], time: number): PointerState | null {
  if (!samples.length) return null
  let low = 0
  let high = samples.length - 1
  if (time <= samples[0][0]) return state(samples[0])
  if (time >= samples[high][0]) return state(samples[high])
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (samples[middle][0] <= time) low = middle
    else high = middle
  }
  const a = samples[low]
  const b = samples[high]
  const amount = b[0] > a[0] ? (time - a[0]) / (b[0] - a[0]) : 0
  // A curve through the samples either side (Catmull-Rom), so the path has no corners.
  const before = samples[Math.max(0, low - 1)]
  const after = samples[Math.min(samples.length - 1, high + 1)]
  return {
    x: curve(before[1], a[1], b[1], after[1], amount),
    y: curve(before[2], a[2], b[2], after[2], amount),
    pressed: Boolean(a[3]),
    shape: a[4] ?? 0,
  }
}

function curve(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

function state(sample: PointerSample): PointerState {
  return { x: sample[1], y: sample[2], pressed: Boolean(sample[3]), shape: sample[4] ?? 0 }
}

/** Every press of the button, in the recording's time. */
export function presses(samples: PointerSample[]) {
  const found: { t: number; x: number; y: number }[] = []
  let down = false
  for (const sample of samples) {
    if (sample[3] && !down && sample[1] >= 0 && sample[1] <= 1 && sample[2] >= 0 && sample[2] <= 1) found.push({ t: sample[0], x: sample[1], y: sample[2] })
    down = Boolean(sample[3])
  }
  return found
}

/* Zoom suggestions */

/**
 * Moments worth zooming into: clicks close together (within 2.5 s of each other), each group
 * padded half a second either side. In the recording's time.
 */
export function zoomMoments(samples: PointerSample[], duration: number) {
  const moments: { start: number; end: number; x: number; y: number }[] = []
  const clicks = presses(samples)
  let group: typeof clicks = []
  const flush = () => {
    if (!group.length) return
    moments.push({
      start: Math.max(0, group[0].t - 0.5),
      end: Math.min(duration, group[group.length - 1].t + 0.5 + 1),
      x: group.reduce((sum, click) => sum + click.x, 0) / group.length,
      y: group.reduce((sum, click) => sum + click.y, 0) / group.length,
    })
    group = []
  }
  for (const click of clicks) {
    if (group.length && click.t - group[group.length - 1].t > 2.5) flush()
    group.push(click)
  }
  flush()
  return moments.sort((left, right) => left.start - right.start)
}

/** Suggested zooms, placed in the edited video where there's room for them. */
export function suggestZooms(project: EditProject, samples: PointerSample[], duration: number): Zoom[] {
  const total = editedDuration(project)
  const zooms: Zoom[] = []
  for (const moment of zoomMoments(samples, duration)) {
    const start = toEdited(project, moment.start)
    const end = toEdited(project, moment.end)
    if (start === null || end === null || end - start < 0.5) continue
    const slot = freeSlots([...project.zooms, ...zooms], total, 0.5).find(([from, to]) => start >= from - 0.01 && start < to)
    if (!slot) continue
    zooms.push({ id: newId("z"), start, end: Math.min(end, slot[1]), depth: 1.8, mode: "auto", x: moment.x, y: moment.y, suggested: true })
  }
  return zooms
}

/* The camera */

export interface CameraFrame {
  scale: number
  x: number
  y: number
}

/** A critically damped spring, stepped in small increments so it's the same whatever the frame rate. */
function spring(value: number, velocity: number, target: number, omega: number, damping: number, dt: number): [number, number] {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
  const h = dt / steps
  for (let step = 0; step < steps; step += 1) {
    const acceleration = omega * omega * (target - value) - 2 * damping * omega * velocity
    velocity += acceleration * h
    value += velocity * h
  }
  return [value, velocity]
}

/** What the camera aims for at each frame: how deep, and where (before springs smooth it). */
function cameraTargets(project: EditProject, samples: PointerSample[], frames: number) {
  const preset = PRESETS[project.motion.preset]
  const zooms = [...project.zooms].sort((left, right) => left.start - right.start)
  const depth = new Float32Array(frames)
  const focusX = new Float32Array(frames)
  const focusY = new Float32Array(frames)
  const active = new Int16Array(frames).fill(-1)
  // Which zoom is in charge of each frame, counting the lead-in and, for connected zooms, the gap.
  zooms.forEach((zoom, index) => {
    const next = zooms[index + 1]
    const connected = project.motion.connect && next && next.start - preset.lead - zoom.end < CONNECT_GAP
    const from = Math.max(0, Math.floor((zoom.start - preset.lead) * FPS))
    const to = Math.min(frames - 1, Math.ceil((connected ? next.start - preset.lead : zoom.end) * FPS))
    for (let frame = from; frame <= to; frame += 1) active[frame] = index
  })
  let x = 0.5
  let y = 0.5
  let current = -1
  for (let frame = 0; frame < frames; frame += 1) {
    const index = active[frame]
    const zoom = index >= 0 ? zooms[index] : null
    const edited = frame / FPS
    if (zoom) {
      depth[frame] = zoom.depth
      if (zoom.mode === "manual") {
        x = zoom.x
        y = zoom.y
      } else {
        const pointer = pointerAt(samples, sourceTime(project, edited))
        if (index !== current) {
          // A new auto zoom starts on the pointer.
          if (pointer) [x, y] = [pointer.x, pointer.y]
        } else if (pointer) {
          // Then only moves when the pointer nears the edge of what's shown, just enough to keep it in.
          const half = 0.5 / zoom.depth
          const inner = half * (1 - EDGE_SNAP)
          if (pointer.x > x + inner) x = pointer.x - inner
          if (pointer.x < x - inner) x = pointer.x + inner
          if (pointer.y > y + inner) y = pointer.y - inner
          if (pointer.y < y - inner) y = pointer.y + inner
        }
      }
      const half = 0.5 / zoom.depth
      x = clamp(x, half, 1 - half)
      y = clamp(y, half, 1 - half)
    } else {
      // Zooming out holds where it was.
      depth[frame] = 1
    }
    current = index
    focusX[frame] = x
    focusY[frame] = y
  }
  return { depth, focusX, focusY, active, zooms }
}

const sourceTime = (project: EditProject, edited: number) => {
  const placed = clipAt(project, edited)
  return placed.clip.start + (edited - placed.from) * placed.clip.speed
}

/** The camera for every frame: springs toward the targets, or (classic) eases between them. */
export function cameraTrack(project: EditProject, samples: PointerSample[]): CameraFrame[] {
  const total = editedDuration(project)
  const frames = Math.max(1, Math.ceil(total * FPS) + 1)
  const { depth, focusX, focusY, active, zooms } = cameraTargets(project, samples, frames)
  const preset = PRESETS[project.motion.preset]
  const track: CameraFrame[] = new Array(frames)
  if (project.motion.classic) {
    // Each zoom's run (with its lead-in, and the gap when it glides into the next) eases in and out.
    const runEnd = new Map<number, number>()
    for (let frame = 0; frame < frames; frame += 1) if (active[frame] >= 0) runEnd.set(active[frame], frame / FPS)
    for (let frame = 0; frame < frames; frame += 1) {
      const index = active[frame]
      if (index < 0) {
        track[frame] = { scale: 1, x: focusX[frame], y: focusY[frame] }
        continue
      }
      const zoom = zooms[index]
      const edited = frame / FPS
      const end = runEnd.get(index) ?? zoom.end
      const glidesOn = end + 1 / FPS < frames / FPS && active[Math.min(frames - 1, frame + Math.ceil((end - edited) * FPS) + 1)] >= 0
      const into = ease(clamp((edited - (zoom.start - preset.lead)) / Math.max(0.05, preset.zoomIn), 0, 1))
      const out = glidesOn ? 1 : ease(clamp((end - edited) / Math.max(0.05, preset.zoomOut), 0, 1))
      // A zoom glided into from another starts already in.
      const arrived = index > 0 && active[Math.max(0, Math.floor((zoom.start - preset.lead) * FPS) - 1)] === index - 1 ? 1 : into
      track[frame] = { scale: 1 + (depth[frame] - 1) * Math.min(arrived, out), x: focusX[frame], y: focusY[frame] }
    }
    return track
  }
  let scale = 1
  let scaleVelocity = 0
  let x = focusX[0]
  let xVelocity = 0
  let y = focusY[0]
  let yVelocity = 0
  const dt = 1 / FPS
  for (let frame = 0; frame < frames; frame += 1) {
    ;[scale, scaleVelocity] = spring(scale, scaleVelocity, depth[frame], preset.cameraSpring, preset.cameraDamping, dt)
    ;[x, xVelocity] = spring(x, xVelocity, focusX[frame], preset.cameraSpring, preset.cameraDamping, dt)
    ;[y, yVelocity] = spring(y, yVelocity, focusY[frame], preset.cameraSpring, preset.cameraDamping, dt)
    track[frame] = { scale: Math.max(1, scale), x, y }
  }
  return track
}

/** The camera between two frames. */
export function cameraAt(track: CameraFrame[], edited: number): CameraFrame {
  const position = clamp(edited * FPS, 0, track.length - 1)
  const low = Math.floor(position)
  const high = Math.min(track.length - 1, low + 1)
  const amount = position - low
  const a = track[low]
  const b = track[high]
  return { scale: a.scale + (b.scale - a.scale) * amount, x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount }
}

/* The cursor */

export interface CursorFrame {
  x: number
  y: number
  shape: number
  pressed: boolean
  squash: number
  rotation: number
  visible: boolean
}

export interface Click {
  time: number
  x: number
  y: number
}

/** The drawn cursor for every frame: smoothed, squashed on clicks, tilted as it moves, and looped if asked. */
export function cursorTrack(project: EditProject, samples: PointerSample[]): { frames: CursorFrame[]; clicks: Click[] } {
  const settings: CursorSettings = project.cursor
  const total = editedDuration(project)
  const count = Math.max(1, Math.ceil(total * FPS) + 1)
  const frames: CursorFrame[] = new Array(count)
  const clicks: Click[] = []
  if (!samples.length) {
    for (let frame = 0; frame < count; frame += 1) frames[frame] = { x: 0.5, y: 0.5, shape: 0, pressed: false, squash: 1, rotation: 0, visible: false }
    return { frames, clicks }
  }
  // Smoothing: 0 follows exactly; the default 0.67 glides; 2 is very floaty.
  // A softer spring than before: the default glides without lagging far behind.
  const omega = settings.smoothing <= 0.01 ? 0 : 18 / (1 + 2 * settings.smoothing)
  const dt = 1 / FPS
  let x = 0.5
  let y = 0.5
  let vx = 0
  let vy = 0
  let rotation = 0
  let lastPress = -Infinity
  let wasPressed = false
  let clipIndex = -1
  for (let frame = 0; frame < count; frame += 1) {
    const edited = Math.min(total, frame / FPS)
    const placed = clipAt(project, edited)
    const source = placed.clip.start + (edited - placed.from) * placed.clip.speed
    // Another recording's clip has no pointer data: no cursor while it plays.
    if (placed.clip.source) {
      frames[frame] = { x, y, shape: 0, pressed: false, squash: 1, rotation: 0, visible: false }
      clipIndex = -1
      continue
    }
    const pointer = pointerAt(samples, source)!
    // A cut jumps straight to where the pointer is in the next clip.
    if (placed.index !== clipIndex || omega === 0) {
      x = pointer.x
      y = pointer.y
      vx = 0
      vy = 0
      clipIndex = placed.index
    } else {
      // Tiny movements (hand tremor, a sub-pixel nudge) are ignored, so a still cursor stays still.
      const targetX = Math.abs(pointer.x - x) < 0.0006 && Math.abs(vx) < 0.01 ? x : pointer.x
      const targetY = Math.abs(pointer.y - y) < 0.0006 && Math.abs(vy) < 0.01 ? y : pointer.y
      ;[x, vx] = spring(x, vx, targetX, omega, 1, dt)
      ;[y, vy] = spring(y, vy, targetY, omega, 1, dt)
    }
    if (pointer.pressed && !wasPressed) {
      lastPress = edited
      clicks.push({ time: edited, x: pointer.x, y: pointer.y })
    }
    wasPressed = pointer.pressed
    const speed = settings.bounceSpeed / 1000
    const since = edited - lastPress
    const squash = since >= 0 && since < speed ? 1 - 0.06 * settings.bounce * Math.sin((since / speed) * Math.PI) : 1
    // Leans up to 10° toward where it's heading, more the faster it goes.
    const lean = clamp((omega ? vx : 0) * 40 * settings.sway, -10, 10)
    rotation += (lean - rotation) * 0.2
    frames[frame] = { x, y, shape: pointer.shape, pressed: pointer.pressed, squash: Math.max(0.5, squash), rotation, visible: x >= 0 && x <= 1 && y >= 0 && y <= 1 }
  }
  // For a looping GIF: hold, then glide back to where it started so the loop is seamless.
  if (settings.loop && count > FPS * 1.5) {
    const glide = Math.round(0.67 * FPS)
    const from = count - 1 - glide
    const held = frames[from]
    const first = frames[0]
    for (let frame = from; frame < count; frame += 1) {
      const amount = ease((frame - from) / glide)
      frames[frame] = { ...frames[frame], x: held.x + (first.x - held.x) * amount, y: held.y + (first.y - held.y) * amount, shape: first.shape, squash: 1, rotation: 0 }
    }
  }
  return { frames, clicks }
}

export function cursorAt(track: CursorFrame[], edited: number): CursorFrame {
  const position = clamp(edited * FPS, 0, track.length - 1)
  const low = Math.floor(position)
  const high = Math.min(track.length - 1, low + 1)
  const amount = position - low
  const a = track[low]
  const b = track[high]
  return { ...a, x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount, rotation: a.rotation + (b.rotation - a.rotation) * amount }
}

export type { MotionSettings }
