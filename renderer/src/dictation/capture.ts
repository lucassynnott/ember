// Microphone capture for dictation: opens the configured input, buffers 16 kHz PCM and reports a level.
const SAMPLE_RATE = 16000

let capture: {
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  chunks: Float32Array[]
  length: number
} | null = null
let cachedDeviceId: string | null = null
let cachedLabel: string | null = null
let levelListener: (level: number) => void = () => {}

export function onLevel(listener: (level: number) => void) {
  levelListener = listener
}

function normalizeLabel(label: string) {
  return String(label || "")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim()
    .toLocaleLowerCase()
}

function downsample(samples: Float32Array, inputRate: number) {
  if (inputRate === SAMPLE_RATE) return new Float32Array(samples)
  const ratio = inputRate / SAMPLE_RATE
  const output = new Float32Array(Math.floor(samples.length / ratio))
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let source = start; source < end; source += 1) sum += samples[source]
    output[index] = sum / Math.max(1, end - start)
  }
  return output
}

const constraints = (deviceId: string | null): MediaStreamConstraints => ({
  audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    autoGainControl: true,
    echoCancellation: false,
    noiseSuppression: true,
  },
})

// Opens the configured microphone, reusing the stream when the default device already is it.
async function openMicrophone(preferredLabel: string) {
  if (cachedDeviceId && cachedLabel === preferredLabel) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(cachedDeviceId))
    } catch {
      cachedDeviceId = null
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints(null))
  const devices = await navigator.mediaDevices.enumerateDevices()
  const preferred = devices.find(
    (device) => device.kind === "audioinput" && normalizeLabel(device.label) === normalizeLabel(preferredLabel),
  )
  cachedLabel = preferredLabel
  if (!preferred) return stream
  cachedDeviceId = preferred.deviceId
  if (stream.getAudioTracks()[0]?.getSettings().deviceId === preferred.deviceId) return stream
  stream.getTracks().forEach((track) => track.stop())
  return navigator.mediaDevices.getUserMedia(constraints(preferred.deviceId))
}

navigator.mediaDevices.addEventListener("devicechange", () => {
  cachedDeviceId = null
})

function stopStream(current: NonNullable<typeof capture>) {
  current.processor.onaudioprocess = null
  current.processor.disconnect()
  current.source.disconnect()
  current.stream.getTracks().forEach((track) => track.stop())
  void current.context.close()
}

let installed = false

export function installCapture() {
  if (installed) return
  installed = true

  window.dictation.onCaptureStart(async ({ id, microphoneLabel }) => {
    try {
      if (capture) stopStream(capture)
      const stream = await openMicrophone(microphoneLabel)
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(2048, 1, 1)
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(processor)
      processor.connect(mute)
      mute.connect(context.destination)
      const current = { stream, context, source, processor, chunks: [] as Float32Array[], length: 0 }
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const pcm = downsample(input, context.sampleRate)
        current.chunks.push(pcm)
        current.length += pcm.length
        let energy = 0
        for (let index = 0; index < input.length; index += 1) energy += input[index] ** 2
        levelListener(Math.sqrt(energy / input.length))
      }
      capture = current
      window.dictation.captureStarted(id, null)
    } catch (error) {
      window.dictation.captureStarted(id, (error as Error).message || String(error))
    }
  })

  window.dictation.onCaptureStop(async ({ id, tailMs }) => {
    const current = capture
    if (!current) {
      window.dictation.captureStopped(id, null, "Dictation wasn't recording.")
      return
    }
    // Keep listening briefly so the last word isn't clipped when the key is released.
    await new Promise((resolve) => setTimeout(resolve, tailMs || 0))
    capture = null
    stopStream(current)
    const samples = new Float32Array(current.length)
    let offset = 0
    for (const chunk of current.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    levelListener(0)
    window.dictation.captureStopped(id, samples.buffer, null)
  })

  window.dictation.onCaptureCancel(() => {
    if (capture) stopStream(capture)
    capture = null
    levelListener(0)
  })
}
