import { ExportFrameCompositor, trackSample } from './windows-export-compositor'
import type { ExportFrameSpec } from './windows-export-compositor'
Object.assign(window, { emberExport: { ExportFrameCompositor, trackSample } })
interface ExportConfig {
  spec: ExportFrameSpec & { clips: number[][] }
  duration: number; sources: string[]; camera: string | null; background: string | null
}
interface ExportBridge {
  config(): Promise<ExportConfig>
  frame(index: number, bytes: ArrayBuffer): Promise<void>
  finish(): Promise<void>
  error(message: string): void
}
async function loadVideo(url: string) {
  const video = document.createElement('video')
  video.muted = true; video.preload = 'auto'; video.playsInline = true
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve()
    video.onerror = () => reject(new Error('An export video could not be decoded.'))
    video.src = url; video.load()
  })
  return video
}
async function seek(video: HTMLVideoElement, time: number) {
  const target = Math.max(0, Math.min(Math.ceil(time * 1000000) / 1000000, Math.max(0, video.duration - 0.000001)))
  if (Math.abs(video.currentTime - target) < 0.000001 && video.readyState >= 2) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Export video seeking timed out.')) }, 30000)
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', failed) }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('An export video could not be decoded.')) }
    video.addEventListener('seeked', done, { once: true }); video.addEventListener('error', failed, { once: true }); video.currentTime = target
  })
}
async function exportFrames(bridge: ExportBridge) {
  const config = await bridge.config(), spec = config.spec
  const videos: HTMLVideoElement[] = []
  let compositor: ExportFrameCompositor | null = null
  const load = async (url: string) => { const video = await loadVideo(url); videos.push(video); return video }
  try {
    const sources = []
    for (const url of config.sources) sources.push(await load(url))
    const camera = config.camera ? await load(config.camera) : null
    const background = config.background ? await load(config.background) : null
    compositor = await ExportFrameCompositor.create(spec)
    const canvas = document.createElement('canvas'); canvas.width = spec.width; canvas.height = spec.height
    const context = canvas.getContext('2d')!
    const picture = (video: HTMLVideoElement) => ({ image: video, width: video.videoWidth, height: video.videoHeight })
    let clipIndex = 0, clipAt = 0
    for (let index = 0; index < Math.ceil(config.duration * spec.fps); index++) {
      const time = index / spec.fps
      let clip = spec.clips[clipIndex]
      while (clipIndex < spec.clips.length - 1 && time >= clipAt + (clip[1] - clip[0]) / clip[2] - 0.0000001) {
        clipAt += (clip[1] - clip[0]) / clip[2]; clip = spec.clips[++clipIndex]
      }
      const sourceIndex = clip[3] || 0, sourceTime = clip[0] + (time - clipAt) * clip[2]
      const source = sources[sourceIndex]
      if (!source) throw new Error('A clip source is missing from the export.')
      await seek(source, sourceTime)
      if (camera && sourceIndex === 0) await seek(camera, sourceTime)
      if (background) await seek(background, time % background.duration)
      compositor.draw(context, time, picture(source), camera && sourceIndex === 0 ? picture(camera) : null, background ? picture(background) : null)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The export frame could not be encoded.')), 'image/png'))
      await bridge.frame(index, await blob.arrayBuffer())
    }
    await bridge.finish()
  } finally {
    compositor?.close()
    for (const video of videos) { video.removeAttribute('src'); video.load() }
  }
}
const bridge = (window as unknown as { windowsExport?: ExportBridge }).windowsExport
if (bridge) void exportFrames(bridge).catch(error => bridge.error(error instanceof Error ? error.message : String(error)))
