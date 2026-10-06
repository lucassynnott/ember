// Draws the editor's exported plan using Chromium's canvas on Windows.
export interface ExportFrameSpec {
  width: number; height: number; fps: number; content: number[]
  contentMask?: number
  sprites?: string[]
  background?: { kind: string; image?: number; blur?: number } | null
  shadows?: number[][]
  view: number[][]
  webcam?: { track: number[][]; mirror: boolean; shadow: number; crop: number[] } | null
  layers?: { kind: string; sprite?: number; start: number; end: number; rect: number[]; fade?: number; fadeIn?: number; fadeOut?: number; motion?: string; radius?: number; fill?: string; amount?: number }[]
  effects?: { rect: number[]; frames: number[][] }[]
  cursor?: number[][]
  cursorSprites?: { sprite: number; hotX: number; hotY: number; size: number }[]
  motionBlur?: number[] | null
}
export interface ExportPicture { image: CanvasImageSource; width: number; height: number }
export function trackSample(track: number[][], time: number, discrete = false): number[] | null {
  if (!track.length || (discrete && time < track[0][0] - 0.0001)) return null
  if (time <= track[0][0]) return track[0]
  let low = 0, high = track.length - 1
  if (time >= track[high][0]) return track[high]
  while (high - low > 1) { const middle = (low + high) >> 1; if (track[middle][0] <= time) low = middle; else high = middle }
  if (discrete) return track[low]
  const a = track[low], b = track[high], amount = b[0] > a[0] ? (time - a[0]) / (b[0] - a[0]) : 0
  return a.slice(0, b.length).map((value, index) => index === 0 ? time : value + (b[index] - value) * amount)
}
function surface(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width)); canvas.height = Math.max(1, Math.ceil(height))
  return canvas
}
function cover(context: CanvasRenderingContext2D, picture: ExportPicture, rect: number[]) {
  const [x, y, w, h] = rect, scale = Math.max(w / picture.width, h / picture.height)
  const sw = w / scale, sh = h / scale
  context.drawImage(picture.image, (picture.width - sw) / 2, (picture.height - sh) / 2, sw, sh, x, y, w, h)
}
function rounded(context: CanvasRenderingContext2D, rect: number[], radius: number) {
  context.beginPath(); context.roundRect(rect[0], rect[1], rect[2], rect[3], Math.max(0, Math.min(radius, rect[2] / 2, rect[3] / 2)))
}
export class ExportFrameCompositor {
  readonly spec: ExportFrameSpec
  readonly sprites: ImageBitmap[]
  private readonly contentSurface: HTMLCanvasElement
  private readonly layerSurface: HTMLCanvasElement
  private constructor(spec: ExportFrameSpec, sprites: ImageBitmap[]) {
    this.spec = spec; this.sprites = sprites
    this.contentSurface = surface(spec.content[2], spec.content[3])
    this.layerSurface = surface(spec.width, spec.height)
  }
  static async create(spec: ExportFrameSpec) {
    if (![spec.width, spec.height, spec.fps].every(value => Number.isFinite(value) && value > 0) || spec.content.length < 4) throw new Error('Invalid export canvas.')
    const sprites: ImageBitmap[] = []
    try {
      for (const encoded of spec.sprites || []) {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
        sprites.push(await createImageBitmap(new Blob([bytes], { type: 'image/png' })))
      }
      return new ExportFrameCompositor(spec, sprites)
    } catch (error) { sprites.forEach(sprite => sprite.close()); throw error }
  }
  close() { this.sprites.forEach(sprite => sprite.close()); this.contentSurface.width = 1; this.layerSurface.width = 1 }
  draw(context: CanvasRenderingContext2D, time: number, screen: ExportPicture, camera?: ExportPicture | null, background?: ExportPicture | null) {
    const spec = this.spec, [x, y, w, h] = spec.content
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.filter = 'none'
    context.clearRect(0, 0, spec.width, spec.height)
    context.fillStyle = '#000'; context.fillRect(0, 0, spec.width, spec.height)
    const backdrop = spec.background?.image === undefined ? null : this.sprites[spec.background.image]
    if (spec.background?.kind === 'image' && backdrop) context.drawImage(backdrop, 0, 0, spec.width, spec.height)
    else if (background) {
      context.save(); context.filter = `blur(${Math.max(0, (spec.background?.blur || 0) / 2)}px)`
      cover(context, background, [0, 0, spec.width, spec.height]); context.restore()
    }
    const mask = spec.contentMask === undefined ? null : this.sprites[spec.contentMask]
    if (mask) {
      for (const [blur, offset, opacity] of spec.shadows || []) {
        context.save(); context.shadowColor = `rgba(0,0,0,${opacity})`; context.shadowBlur = blur * 2; context.shadowOffsetY = offset; context.shadowOffsetX = spec.width * 2
        context.drawImage(mask, x - spec.width * 2, y, w, h); context.restore()
      }
    }
    const content = this.contentSurface, picture = content.getContext('2d')!
    picture.clearRect(0, 0, content.width, content.height)
    const stepped = trackSample(spec.view, time, true)
    const view = stepped && stepped.length >= 6 && stepped[5] > 0.5 ? stepped : trackSample(spec.view, time) || [time, 0, 0, screen.width, screen.height]
    if (view.length >= 6 && view[5] > 0.5) {
      picture.fillStyle = '#000'; picture.fillRect(0, 0, w, h)
      const scale = Math.min(w / screen.width, h / screen.height)
      picture.drawImage(screen.image, (w - screen.width * scale) / 2, (h - screen.height * scale) / 2, screen.width * scale, screen.height * scale)
    } else {
      const strength = spec.motionBlur?.[0] || 0, before = strength ? trackSample(spec.view, time - 1 / Math.max(1, spec.fps)) : null
      const pan = before ? Math.hypot(view[1] + view[3] / 2 - before[1] - before[3] / 2, view[2] + view[4] / 2 - before[2] - before[4] / 2) * w / Math.max(1, view[3]) : 0
      const zoom = before ? Math.abs(view[3] - before[3]) / Math.max(1, view[3]) : 0
      const steps = before && (pan > 2 || zoom > 0.002) ? Math.min(8, 3 + Math.round(pan * strength / 6 + zoom * 120 * strength)) : 1
      for (let step = 0; step < steps; step++) {
        const amount = 1 - step / Math.max(1, steps - 1) * Math.min(1, strength * 2.2)
        const current = before && steps > 1 ? view.map((value, index) => index === 0 ? value : before[index] + (value - before[index]) * amount) : view
        picture.globalAlpha = 1 / (step + 1)
        picture.drawImage(screen.image, current[1], current[2], Math.max(1, current[3]), Math.max(1, current[4]), 0, 0, w, h)
      }
      picture.globalAlpha = 1
    }
    if (mask) { picture.globalCompositeOperation = 'destination-in'; picture.drawImage(mask, 0, 0, w, h); picture.globalCompositeOperation = 'source-over' }
    context.drawImage(content, x, y, w, h)
    const webcam = spec.webcam, box = webcam ? trackSample(webcam.track, time) : null
    if (camera && webcam && box && box.length >= 6 && (box.length < 7 || box[6] > 0.5)) {
      const rect = box.slice(1, 5), radius = box[5], size = Math.min(rect[2], rect[3])
      if (webcam.shadow > 0) {
        context.save(); rounded(context, rect, radius); context.fillStyle = '#000'; context.shadowColor = `rgba(0,0,0,${0.55 * webcam.shadow})`; context.shadowBlur = size * 0.12; context.shadowOffsetY = size * 0.04; context.fill(); context.restore()
      }
      context.save(); rounded(context, rect, radius); context.clip()
      const crop = webcam.crop.length === 4 ? webcam.crop : [0, 0, 1, 1]
      const cw = camera.width * crop[2], ch = camera.height * crop[3], fit = Math.max(rect[2] / cw, rect[3] / ch)
      const sw = rect[2] / fit, sh = rect[3] / fit, sx = camera.width * crop[0] + (cw - sw) / 2, sy = camera.height * crop[1] + (ch - sh) / 2
      if (webcam.mirror) { context.translate(rect[0] + rect[2], rect[1]); context.scale(-1, 1); context.drawImage(camera.image, sx, sy, sw, sh, 0, 0, rect[2], rect[3]) }
      else context.drawImage(camera.image, sx, sy, sw, sh, ...rect as [number, number, number, number])
      context.restore()
    }
    for (const layer of spec.layers || []) {
      if (time < layer.start || time > layer.end) continue
      const rect = [...layer.rect]
      context.save()
      if (layer.kind === 'blur') {
        const copy = this.layerSurface; const copied = copy.getContext('2d')!; copied.clearRect(0, 0, spec.width, spec.height); copied.drawImage(context.canvas, 0, 0)
        rounded(context, rect, layer.radius || 0); context.clip()
        if (layer.fill) { context.fillStyle = layer.fill; context.fillRect(...rect as [number, number, number, number]) }
        else { context.filter = `blur(${Math.max(1, layer.amount || 10)}px)`; context.drawImage(copy, 0, 0) }
      } else if (layer.sprite !== undefined && this.sprites[layer.sprite]) {
        const fadeIn = layer.fadeIn ?? layer.fade ?? 0, fadeOut = layer.fadeOut ?? layer.fade ?? 0
        const into = fadeIn > 0 ? Math.min(1, (time - layer.start) / fadeIn) : 1
        const outOf = fadeOut > 0 ? Math.min(1, (layer.end - time) / fadeOut) : 1
        context.globalAlpha = Math.max(0, Math.min(into, outOf))
        if (layer.motion === 'rise') rect[1] += (1 - into) * rect[3] * 0.4
        if (layer.motion === 'pop') { const scale = 0.85 + 0.15 * into; rect[0] += rect[2] * (1 - scale) / 2; rect[1] += rect[3] * (1 - scale) / 2; rect[2] *= scale; rect[3] *= scale }
        context.drawImage(this.sprites[layer.sprite], ...rect as [number, number, number, number])
      }
      context.restore()
    }
    for (const effect of spec.effects || []) {
      if (!effect.frames.length || time < effect.frames[0][0] || time > effect.frames[effect.frames.length - 1][0]) continue
      const current = trackSample(effect.frames, time, true)
      if (current && this.sprites[current[1]]) context.drawImage(this.sprites[current[1]], ...effect.rect as [number, number, number, number])
    }
    const point = trackSample(spec.cursor || [], time), shown = trackSample(spec.cursor || [], time, true)
    if (point && shown && point.length >= 8 && shown[7] > 0.5) {
      const shape = spec.cursorSprites?.[Math.floor(shown[3])], sprite = shape && this.sprites[shape.sprite]
      if (shape && sprite) {
        const scale = point[4] / Math.max(1, shape.size), before = trackSample(spec.cursor || [], time - 1 / Math.max(1, spec.fps))
        const dx = before ? point[1] - before[1] : 0, dy = before ? point[2] - before[2] : 0, distance = Math.hypot(dx, dy)
        const radius = distance > 6 ? Math.min(24, distance * 0.25 * (spec.motionBlur?.[1] || 0)) : 0
        const steps = radius ? Math.min(8, 3 + Math.round(radius / 4)) : 1
        const cursorContext = this.layerSurface.getContext('2d')!
        cursorContext.clearRect(0, 0, spec.width, spec.height)
        cursorContext.globalCompositeOperation = 'lighter'
        for (let step = 0; step < steps; step++) {
          const offset = steps > 1 ? (step / (steps - 1) - 0.5) * 2 * radius / distance : 0
          cursorContext.save(); cursorContext.globalAlpha = 1 / steps; cursorContext.translate(point[1] + dx * offset, point[2] + dy * offset); cursorContext.rotate(point[6] * Math.PI / 180); cursorContext.scale(scale * (2 - point[5]), scale * point[5]); cursorContext.drawImage(sprite, -shape.hotX, -shape.hotY); cursorContext.restore()
        }
        cursorContext.globalCompositeOperation = 'source-over'
        context.drawImage(this.layerSurface, 0, 0)
      }
    }
    context.restore()
  }
}
