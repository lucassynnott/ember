// A hidden, isolated capture window. File paths stay in the Electron main process.
interface CaptureConfig {
  nativeDesktop?: boolean
  sourceId: string | null
  rect: { x: number; y: number; width: number; height: number } | null
  displaySize: { width: number; height: number } | null
  microphone: string
  camera: string | null
  cameraOnly: boolean
  systemAudio: boolean
  fps: number
}
interface CaptureBridge {
  desktopFrame(): Promise<ArrayBuffer>
  config(): Promise<CaptureConfig>
  chunk(kind: string, bytes: ArrayBuffer): Promise<void>
  event(message: Record<string, unknown>): void
  command(handler: (command: string) => void): void
}
const bridge = (window as unknown as { windowsCapture: CaptureBridge }).windowsCapture
const streams: MediaStream[] = []
const recorders: MediaRecorder[] = []
let audioContext: AudioContext | null = null
let nativePump = false
let drawTimer: ReturnType<typeof setInterval> | undefined
let levelTimer: ReturnType<typeof setInterval> | undefined
let started = 0
let pauseStarted = 0
let pausedMs = 0
let stopping = false
let pendingCommand: string | null = null
let ready = false
let queue: Promise<void> = Promise.resolve()

function keep(stream: MediaStream) { streams.push(stream); return stream }
async function device(kind: "audioinput" | "videoinput", label: string) {
  const permission = keep(await navigator.mediaDevices.getUserMedia(kind === "audioinput" ? { audio: true } : { video: true }))
  permission.getTracks().forEach((track) => track.stop())
  const devices = await navigator.mediaDevices.enumerateDevices()
  const selected = label === "default" ? null : devices.find((candidate) => candidate.kind === kind && (candidate.label === label || candidate.deviceId === label))
  if (label !== "default" && !selected) throw new Error(`Device “${label}” isn't connected.`)
  return keep(await navigator.mediaDevices.getUserMedia(kind === "audioinput"
    ? { audio: { ...(selected ? { deviceId: { exact: selected.deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } }
    : { video: { ...(selected ? { deviceId: { exact: selected.deviceId } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 } } }))
}
async function videoElement(stream: MediaStream) {
  const video = document.createElement("video")
  video.muted = true
  video.srcObject = stream
  document.body.appendChild(video)
  await video.play()
  if (!video.videoWidth) await new Promise<void>((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true }))
  return video
}
function recorder(stream: MediaStream, kind: string) {
  const types = kind === "system" ? ["audio/webm;codecs=opus", "audio/webm"] : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
  const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error("No supported recording codec was found.")
  const instance = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16000000, audioBitsPerSecond: 192000 })
  instance.addEventListener("dataavailable", (event) => {
    if (!event.data.size) return
    queue = queue.then(async () => bridge.chunk(kind, await event.data.arrayBuffer()))
    // Keep errors observable even before Stop is pressed.
    void queue.catch((error: Error) => { if (!stopping) bridge.event({ type: "error", message: error.message }) })
  })
  instance.addEventListener("error", () => bridge.event({ type: "error", message: "MediaRecorder failed." }))
  recorders.push(instance)
  return instance
}
function cleanup() {
  nativePump = false
  clearInterval(drawTimer); clearInterval(levelTimer)
  for (const stream of streams) stream.getTracks().forEach((track) => track.stop())
  void audioContext?.close()
}
async function stop(cancel: boolean) {
  if (stopping) return
  stopping = true
  const duration = (performance.now() - started - pausedMs - (pauseStarted ? performance.now() - pauseStarted : 0)) / 1000
  try {
    await Promise.all(recorders.map((instance) => new Promise<void>((resolve) => {
      if (instance.state === "inactive") return resolve()
      instance.addEventListener("stop", () => resolve(), { once: true })
      instance.stop()
    })))
    await queue
    cleanup()
    bridge.event({ type: cancel ? "cancelled" : "captured", duration })
  } catch (error) { cleanup(); bridge.event({ type: "error", message: (error as Error).message }) }
}
function command(value: string) {
  if (!ready) { pendingCommand = value; return }
  if (value === "stop" || value === "cancel") return void stop(value === "cancel")
  if (value === "pause" && !pauseStarted && !stopping) {
    pauseStarted = performance.now()
    for (const instance of recorders) if (instance.state === "recording") instance.pause()
  } else if (value === "resume" && pauseStarted && !stopping) {
    pausedMs += performance.now() - pauseStarted; pauseStarted = 0
    for (const instance of recorders) if (instance.state === "paused") instance.resume()
  }
}
bridge.command(command)
async function start() {
  const config = await bridge.config()
  const microphone = config.microphone === "none" ? null : await device("audioinput", config.microphone)
  const camera = config.camera ? await device("videoinput", config.camera) : null
  let desktop: MediaStream | null = null
  if (!config.cameraOnly && !config.nativeDesktop) {
    if (!config.sourceId) throw new Error("The selected screen or window is no longer available.")
    // Electron's Windows desktop constraints select the exact source from desktopCapturer.
    desktop = keep(await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: config.sourceId, maxFrameRate: config.fps } } } as unknown as MediaStreamConstraints))
  }
  let system: MediaStream | null = null
  if (config.systemAudio) {
    const capture = keep(await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }))
    if (!capture.getAudioTracks().length) throw new Error("Windows did not provide a system audio track.")
    system = new MediaStream(capture.getAudioTracks())
    capture.getVideoTracks().forEach((track) => track.stop())
  }
  const input = config.cameraOnly ? camera : desktop
  let video: HTMLVideoElement | HTMLCanvasElement
  let sourceWidth: number, sourceHeight: number
  if (config.nativeDesktop) {
    const nativeCanvas = document.createElement("canvas")
    const first = await createImageBitmap(new Blob([await bridge.desktopFrame()], { type: "image/jpeg" }))
    nativeCanvas.width = first.width; nativeCanvas.height = first.height
    const nativeContext = nativeCanvas.getContext("2d")!
    nativeContext.drawImage(first, 0, 0); first.close()
    video = nativeCanvas; sourceWidth = video.width; sourceHeight = video.height
    nativePump = true
    void (async () => {
      while (nativePump && !stopping) {
        const frame = await createImageBitmap(new Blob([await bridge.desktopFrame()], { type: "image/jpeg" }))
        try { if (nativePump) nativeContext.drawImage(frame, 0, 0) } finally { frame.close() }
      }
    })().catch((error: Error) => { if (nativePump && !stopping) { cleanup(); bridge.event({ type: "error", message: error.message }) } })
  } else {
    if (!input) throw new Error("No video device was selected.")
    const element = await videoElement(input)
    video = element; sourceWidth = element.videoWidth; sourceHeight = element.videoHeight
  }
  const scaleX = config.displaySize ? sourceWidth / config.displaySize.width : 1
  const scaleY = config.displaySize ? sourceHeight / config.displaySize.height : 1
  const rect = config.rect ? { x: config.rect.x * scaleX, y: config.rect.y * scaleY, width: config.rect.width * scaleX, height: config.rect.height * scaleY } : { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(2, Math.ceil(rect.width / 2) * 2); canvas.height = Math.max(2, Math.ceil(rect.height / 2) * 2)
  const context = canvas.getContext("2d")!
  const draw = () => context.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height)
  draw(); drawTimer = setInterval(draw, 1000 / config.fps)
  const recording = keep(canvas.captureStream(config.fps))
  if (microphone) {
    recording.addTrack(microphone.getAudioTracks()[0])
    audioContext = new AudioContext()
    await audioContext.resume()
    const analyser = audioContext.createAnalyser()
    audioContext.createMediaStreamSource(microphone).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    levelTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      bridge.event({ type: "level", value: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) })
    }, 100)
  }
  recorder(recording, "video")
  if (camera && !config.cameraOnly) recorder(new MediaStream(camera.getVideoTracks()), "camera")
  if (system) recorder(system, "system")
  for (const instance of recorders) instance.start(1000)
  started = performance.now(); ready = true
  bridge.event({ type: "started", width: canvas.width, height: canvas.height, microphone: Boolean(microphone), camera: Boolean(camera && !config.cameraOnly), system: Boolean(system) })
  if (pendingCommand) command(pendingCommand)
  for (const track of input?.getVideoTracks() || []) track.addEventListener("ended", () => { if (!stopping) void stop(false) })
}
void start().catch((error: Error) => { cleanup(); bridge.event({ type: "error", message: error.message }) })

export {}
