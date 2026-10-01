const SAMPLE_RATE = 16000;
let capture = null;
let cachedDeviceId = null;
let cachedLabel = null;

function normalizeLabel(label) {
  return String(label || "")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim()
    .toLocaleLowerCase();
}

function downsample(samples, inputRate) {
  if (inputRate === SAMPLE_RATE) return new Float32Array(samples);
  const ratio = inputRate / SAMPLE_RATE;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += samples[source];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

const constraints = (deviceId) => ({
  audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    autoGainControl: true,
    echoCancellation: false,
    noiseSuppression: true,
  },
});

// Opens the configured microphone, reusing the stream when the default device is already it.
async function openMicrophone(preferredLabel) {
  if (cachedDeviceId && cachedLabel === preferredLabel) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(cachedDeviceId));
    } catch {
      cachedDeviceId = null;
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints(null));
  const devices = await navigator.mediaDevices.enumerateDevices();
  const preferred = devices.find(
    (device) => device.kind === "audioinput" && normalizeLabel(device.label) === normalizeLabel(preferredLabel),
  );
  cachedLabel = preferredLabel;
  if (!preferred) return stream;
  cachedDeviceId = preferred.deviceId;
  if (stream.getAudioTracks()[0]?.getSettings().deviceId === preferred.deviceId) return stream;
  stream.getTracks().forEach((track) => track.stop());
  return navigator.mediaDevices.getUserMedia(constraints(preferred.deviceId));
}

navigator.mediaDevices.addEventListener("devicechange", () => {
  cachedDeviceId = null;
});

const bars = [...document.querySelectorAll("#bars span")];
function renderLevel(level) {
  const scaled = Math.min(1, Math.sqrt(level) * 3.2);
  bars.forEach((bar, index) => {
    const shape = 0.45 + 0.55 * Math.sin(((index + 1) / (bars.length + 1)) * Math.PI);
    const jitter = 0.75 + Math.random() * 0.5;
    bar.style.height = `${Math.max(4, Math.round(4 + 16 * scaled * shape * jitter))}px`;
  });
}

function stopStream(current) {
  current.processor.onaudioprocess = null;
  current.processor.disconnect();
  current.source.disconnect();
  current.stream.getTracks().forEach((track) => track.stop());
  void current.context.close();
}

window.dictation.onCaptureStart(async ({ id, microphoneLabel }) => {
  try {
    if (capture) stopStream(capture);
    const stream = await openMicrophone(microphoneLabel);
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    const current = { stream, context, source, processor, chunks: [], length: 0 };
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcm = downsample(input, context.sampleRate);
      current.chunks.push(pcm);
      current.length += pcm.length;
      let energy = 0;
      for (let index = 0; index < input.length; index += 1) energy += input[index] ** 2;
      renderLevel(Math.sqrt(energy / input.length));
    };
    capture = current;
    window.dictation.captureStarted(id, null);
  } catch (error) {
    window.dictation.captureStarted(id, error.message || String(error));
  }
});

window.dictation.onCaptureStop(async ({ id, tailMs }) => {
  const current = capture;
  if (!current) {
    window.dictation.captureStopped(id, null, "Dictation wasn't recording.");
    return;
  }
  // Keep listening briefly so the last word isn't clipped when the key is released.
  await new Promise((resolve) => setTimeout(resolve, tailMs || 0));
  capture = null;
  stopStream(current);
  const samples = new Float32Array(current.length);
  let offset = 0;
  for (const chunk of current.chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  window.dictation.captureStopped(id, samples.buffer, null);
});

window.dictation.onCaptureCancel(() => {
  if (capture) stopStream(capture);
  capture = null;
});

const ICONS = {
  listening: '<div class="dot"></div>',
  transcribing: '<div class="dots"><span></span><span></span><span></span></div>',
  pasted: '<div class="check">✓</div>',
  copied: '<div class="check">⧉</div>',
  empty: '<div class="muted">○</div>',
  cancelled: '<div class="muted">✕</div>',
  error: '<div class="warn">!</div>',
};
const LABELS = { listening: "Listening", transcribing: "Transcribing" };

window.dictation.onState(({ state, message }) => {
  if (state === "hidden") {
    document.body.classList.remove("visible");
    return;
  }
  document.getElementById("icon").innerHTML = ICONS[state] || "";
  document.getElementById("bars").hidden = state !== "listening";
  document.getElementById("label").textContent = message || LABELS[state] || "";
  if (state !== "listening") renderLevel(0);
  document.body.classList.add("visible");
});
