// Records the mapped microphone and macOS system audio, streams the mixed WebM to the main
// process, and sends 16 kHz PCM segments from each source for live transcription.
// Ported unchanged in behaviour from the original recorder renderer.

type Source = "microphone" | "system"

interface LiveCapture {
  flush(): void
  disconnect(): void
}

interface Session {
  audioContext: AudioContext
  microphoneStream: MediaStream
  systemStream: MediaStream
  destination: MediaStreamAudioDestinationNode
  recorder: MediaRecorder
  chunkQueue: Promise<unknown>
  transcriptQueue: Promise<unknown>
  livePcm: LiveCapture[]
}

let activeSession: Session | null = null
let onStatus: (message: string) => void = () => {}

export function setEngineStatusHandler(handler: (message: string) => void) {
  onStatus = handler
}

function normalizeLabel(label: string | undefined) {
  return String(label || "")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim()
    .toLocaleLowerCase()
}

function selectMicrophone(devices: MediaDeviceInfo[], preferredLabel: string) {
  const inputs = devices.filter((device) => device.kind === "audioinput")
  const selected = inputs.find((device) => normalizeLabel(device.label) === normalizeLabel(preferredLabel))
  if (selected) return selected
  const available = inputs.map((device) => device.label || "unlabeled input").join(", ")
  throw new Error(`Microphone “${preferredLabel}” was not found. Available inputs: ${available || "none"}`)
}

function selectMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || ""
}

async function openPreferredMicrophone(preferredLabel: string) {
  const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  permissionStream.getTracks().forEach((track) => track.stop())
  const devices = await navigator.mediaDevices.enumerateDevices()
  const microphone = selectMicrophone(devices, preferredLabel)
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: microphone.deviceId },
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
    },
  })
}

function downsample(samples: Float32Array, inputRate: number, outputRate = 16000) {
  if (inputRate === outputRate) return new Float32Array(samples)
  const ratio = inputRate / outputRate
  const output = new Float32Array(Math.round(samples.length / ratio))
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let source = start; source < end; source += 1) sum += samples[source]
    output[index] = sum / Math.max(1, end - start)
  }
  return output
}

function createLivePcmCapture(
  audioContext: AudioContext,
  sourceNode: AudioNode,
  source: Source,
  session: Pick<Session, "transcriptQueue">,
): LiveCapture {
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  const silence = audioContext.createGain()
  silence.gain.value = 0
  sourceNode.connect(processor)
  processor.connect(silence)
  silence.connect(audioContext.destination)

  let active = false
  let buffered: Float32Array[] = []
  let sampleCount = 0
  let silentSamples = 0
  let segmentStartedAt: number | null = null

  function reset() {
    active = false
    buffered = []
    sampleCount = 0
    silentSamples = 0
    segmentStartedAt = null
  }

  function submit() {
    if (sampleCount < 16000 * 0.7) {
      reset()
      return
    }
    const segment = new Float32Array(sampleCount)
    let offset = 0
    for (const chunk of buffered) {
      segment.set(chunk, offset)
      offset += chunk.length
    }
    const capturedStartedAt = segmentStartedAt
    const capturedEndedAt = Date.now() - (silentSamples / 16000) * 1000
    session.transcriptQueue = session.transcriptQueue.then(() =>
      window.meetingRecorder.appendLivePcm({
        source,
        samples: segment.buffer,
        startedAt: capturedStartedAt,
        endedAt: capturedEndedAt,
      }),
    )
    reset()
  }

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    let energy = 0
    for (let index = 0; index < input.length; index += 1) energy += input[index] ** 2
    const rms = Math.sqrt(energy / input.length)
    const pcm = downsample(input, audioContext.sampleRate)

    if (rms >= 0.009 && !active) {
      active = true
      segmentStartedAt = Date.now()
    }
    if (!active) return
    buffered.push(pcm)
    sampleCount += pcm.length
    silentSamples = rms < 0.006 ? silentSamples + pcm.length : 0

    if (silentSamples >= 16000 * 0.55 || sampleCount >= 16000 * 6) submit()
  }

  return {
    flush: submit,
    disconnect: () => {
      processor.onaudioprocess = null
      processor.disconnect()
      silence.disconnect()
    },
  }
}

async function startRecording({
  microphoneLabel = "Microphone",
  mappedSystemOutputLabel = "System Audio",
}: {
  microphoneLabel?: string
  mappedSystemOutputLabel?: string
}) {
  if (activeSession) throw new Error("A recording is already active.")
  onStatus("Opening microphone and system audio…")
  let microphoneStream: MediaStream | undefined
  let systemStream: MediaStream | undefined
  let audioContext: AudioContext | undefined

  try {
    microphoneStream = await openPreferredMicrophone(microphoneLabel)
    systemStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    const systemAudioTracks = systemStream.getAudioTracks()
    if (systemAudioTracks.length === 0) {
      throw new Error(
        `macOS loopback capture returned no system audio track. Confirm Screen & System Audio Recording permission and that “${mappedSystemOutputLabel}” is the active output.`,
      )
    }
    systemStream.getVideoTracks().forEach((track) => track.stop())

    audioContext = new AudioContext({ latencyHint: "interactive" })
    await audioContext.resume()
    const mix = audioContext.createGain()
    const destination = audioContext.createMediaStreamDestination()
    const microphoneSource = audioContext.createMediaStreamSource(microphoneStream)
    const systemSource = audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks))
    microphoneSource.connect(mix)
    systemSource.connect(mix)
    mix.connect(destination)

    const mimeType = selectMimeType()
    const recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined)
    const session: Session = {
      audioContext,
      microphoneStream,
      systemStream,
      destination,
      recorder,
      chunkQueue: Promise.resolve(),
      transcriptQueue: Promise.resolve(),
      livePcm: [],
    }
    session.livePcm = [
      createLivePcmCapture(audioContext, microphoneSource, "microphone", session),
      createLivePcmCapture(audioContext, systemSource, "system", session),
    ]

    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size === 0) return
      session.chunkQueue = session.chunkQueue.then(async () => {
        await window.meetingRecorder.appendChunk(await event.data.arrayBuffer())
      })
    })
    recorder.start(1000)
    activeSession = session
    onStatus(`Recording ${microphoneLabel} + ${mappedSystemOutputLabel}`)
    return {
      mimeType: recorder.mimeType,
      microphoneLabel,
      systemAudioTracks: systemAudioTracks.map((track) => track.label || "System audio"),
    }
  } catch (error) {
    microphoneStream?.getTracks().forEach((track) => track.stop())
    systemStream?.getTracks().forEach((track) => track.stop())
    if (audioContext && audioContext.state !== "closed") await audioContext.close()
    onStatus(`Recorder error: ${(error as Error).message}`)
    throw error
  }
}

async function requestScreenPermission({ mappedSystemOutputLabel = "System Audio" }) {
  onStatus("Requesting Screen Recording permission…")
  let stream: MediaStream | undefined
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    if (stream.getVideoTracks().length === 0) throw new Error("macOS did not grant Screen Recording access.")
    if (stream.getAudioTracks().length === 0) {
      throw new Error(`macOS did not grant System Audio access for “${mappedSystemOutputLabel}”.`)
    }
    return {
      videoTracks: stream.getVideoTracks().map((track) => track.label || "Screen"),
      audioTracks: stream.getAudioTracks().map((track) => track.label || "System audio"),
    }
  } finally {
    stream?.getTracks().forEach((track) => track.stop())
  }
}

async function stopRecording() {
  const session = activeSession
  if (!session) throw new Error("No recording is active.")
  onStatus("Finishing live transcript…")
  for (const capture of session.livePcm) capture.flush()
  await session.transcriptQueue
  for (const capture of session.livePcm) capture.disconnect()

  await new Promise<void>((resolve, reject) => {
    session.recorder.addEventListener("stop", () => resolve(), { once: true })
    session.recorder.addEventListener(
      "error",
      (event) => reject((event as unknown as { error?: Error }).error || new Error("MediaRecorder failed.")),
      { once: true },
    )
    session.recorder.stop()
  })
  await session.chunkQueue
  session.microphoneStream.getTracks().forEach((track) => track.stop())
  session.systemStream.getTracks().forEach((track) => track.stop())
  session.destination.stream.getTracks().forEach((track) => track.stop())
  await session.audioContext.close()
  activeSession = null
  onStatus("Preparing final notes…")
  return { stopped: true }
}

let installed = false

// Answers start/stop commands from the main process. Installed once per window.
export function installRecorderEngine() {
  if (installed) return
  installed = true
  window.meetingRecorder.onCommand(async ({ id, action, payload }) => {
    try {
      let result: unknown
      if (action === "start") result = await startRecording(payload)
      else if (action === "stop") result = await stopRecording()
      else if (action === "request-screen-permission") result = await requestScreenPermission(payload)
      else throw new Error(`Unknown recorder command: ${action}`)
      window.meetingRecorder.completeCommand(id, result)
    } catch (error) {
      window.meetingRecorder.failCommand(id, error)
    }
  })
}
