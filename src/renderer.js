let activeSession = null;
let currentAppPhase = "idle";
let currentPermissionState = { microphone: "unknown", screen: "unknown", accessibility: "unknown" };
let transcriptSegments = [];

function setStatus(message) {
  document.getElementById("status").textContent = message;
}

function permissionsGranted() {
  return (
    currentPermissionState.microphone === "granted" &&
    currentPermissionState.screen === "granted"
  );
}

function updatePermissionLabel(id, status) {
  const element = document.getElementById(id);
  const labels = {
    granted: "Granted",
    denied: "Denied",
    restricted: "Restricted",
    "not-determined": "Request required",
    "not-granted": "Access needed",
    "system-audio-unavailable": "System audio unavailable",
    unknown: "Not checked",
  };
  element.textContent = labels[status] || status;
  element.classList.toggle("granted", status === "granted");
  element.classList.toggle("missing", status !== "granted" && status !== "unknown");
}

function renderPermissionState(state) {
  currentPermissionState = state;
  updatePermissionLabel("microphone-permission", state.microphone);
  updatePermissionLabel("screen-permission", state.screen);
  updatePermissionLabel("accessibility-permission", state.accessibility);
  document.getElementById("start").disabled =
    currentAppPhase !== "idle" || !permissionsGranted();
  document.getElementById("permissions").textContent = !permissionsGranted()
    ? "Request access"
    : state.accessibility === "granted"
      ? "Recheck access"
      : "Enable Zoom names";
}

function renderZoomState(state) {
  const element = document.getElementById("zoom-status");
  const activeSpeakers = state.activeSpeakers || [];
  if (state.accessibility !== "granted") element.textContent = "Access needed";
  else if (!state.meetingOpen) element.textContent = "No meeting";
  else if (activeSpeakers.length) element.textContent = activeSpeakers.join(", ");
  else element.textContent = `${state.participants?.length || 0} people`;
  element.classList.toggle("granted", state.accessibility === "granted" && state.meetingOpen);
  element.classList.toggle("missing", state.accessibility !== "granted");
}
function renderZoomAutoRecordingState(state) {
  const element = document.getElementById("zoom-auto-status");
  if (!state.enabled) element.textContent = "Off";
  else if (state.suppressed) element.textContent = "Paused until meeting ends";
  else if (state.pending === "start") element.textContent = "Starting shortly";
  else if (state.pending === "stop") element.textContent = "Ending grace period";
  else if (state.recordingOrigin === "zoom-auto") element.textContent = "Automatic";
  else element.textContent = "On";
  element.classList.toggle("granted", state.enabled && !state.suppressed);
  element.classList.toggle("missing", state.suppressed);
}

function renderAppState({ phase, message }) {
  currentAppPhase = phase;
  setStatus(message);
  document.getElementById("start").disabled = phase !== "idle" || !permissionsGranted();
  document.getElementById("stop").disabled = phase !== "recording";
  document.getElementById("status-dot").classList.toggle("recording", phase === "recording");
  document.body.dataset.phase = phase;
}

function resetMeeting() {
  transcriptSegments = [];
  document.getElementById("transcript").innerHTML =
    '<p class="empty">Your live transcript will appear here as people speak.</p>';
  renderAnalysis({ summary: [], decisions: [], actionItems: [] });
}

function appendTranscript({ text, timestamp, speaker, source }) {
  if (!text?.trim()) return;
  const container = document.getElementById("transcript");
  container.querySelector(".empty")?.remove();
  transcriptSegments.push(text.trim());
  const segment = document.createElement("div");
  segment.className = `transcript-segment ${source || ""}`.trim();
  const metadata = document.createElement("div");
  metadata.className = "segment-meta";
  const time = document.createElement("time");
  time.textContent = timestamp || "Now";
  const speakerLabel = document.createElement("span");
  speakerLabel.className = "speaker";
  speakerLabel.textContent = speaker || "Unknown";
  metadata.append(time, speakerLabel);
  const copy = document.createElement("p");
  copy.textContent = text.trim();
  segment.append(metadata, copy);
  container.append(segment);
  container.scrollTop = container.scrollHeight;
  document.getElementById("transcript-count").textContent =
    `${transcriptSegments.join(" ").split(/\s+/).filter(Boolean).length} words`;
}

function renderList(id, items, emptyLabel) {
  const element = document.getElementById(id);
  element.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement("li");
    empty.className = "empty-item";
    empty.textContent = emptyLabel;
    element.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = item;
    element.append(row);
  }
}

function renderAnalysis(analysis) {
  renderList("summary-list", analysis.summary, "Live notes will update during the call.");
  renderList("decisions-list", analysis.decisions, "No decisions captured yet.");
  renderList(
    "actions-list",
    (analysis.actionItems || []).map(({ owner, task }) => `${owner || "Unassigned"} — ${task}`),
    "No action items captured yet.",
  );
  document.getElementById("notes-state").textContent = analysis.provider
    ? `Updated with ${analysis.provider}`
    : "Waiting for enough conversation";
}

function normalizeLabel(label) {
  return String(label || "")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim()
    .toLocaleLowerCase();
}

function selectMicrophone(devices, preferredLabel) {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const selected = inputs.find(
    (device) => normalizeLabel(device.label) === normalizeLabel(preferredLabel),
  );
  if (selected) return selected;
  const available = inputs.map((device) => device.label || "unlabeled input").join(", ");
  throw new Error(
    `Microphone “${preferredLabel}” was not found. Available inputs: ${available || "none"}`,
  );
}

function selectMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

async function openPreferredMicrophone(preferredLabel) {
  const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  permissionStream.getTracks().forEach((track) => track.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphone = selectMicrophone(devices, preferredLabel);
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: microphone.deviceId },
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
    },
  });
}

function downsample(samples, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return new Float32Array(samples);
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.round(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += samples[source];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function createLivePcmCapture(audioContext, sourceNode, source, session) {
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silence = audioContext.createGain();
  silence.gain.value = 0;
  sourceNode.connect(processor);
  processor.connect(silence);
  silence.connect(audioContext.destination);

  let active = false;
  let buffered = [];
  let sampleCount = 0;
  let silentSamples = 0;
  let segmentStartedAt = null;

  function submit() {
    if (sampleCount < 16000 * 0.7) {
      active = false;
      buffered = [];
      sampleCount = 0;
      silentSamples = 0;
      segmentStartedAt = null;
      return;
    }
    const segment = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of buffered) {
      segment.set(chunk, offset);
      offset += chunk.length;
    }
    const capturedStartedAt = segmentStartedAt;
    const capturedEndedAt = Date.now() - (silentSamples / 16000) * 1000;
    session.transcriptQueue = session.transcriptQueue.then(() =>
      window.meetingRecorder.appendLivePcm({
        source,
        samples: segment.buffer,
        startedAt: capturedStartedAt,
        endedAt: capturedEndedAt,
      }),
    );
    active = false;
    buffered = [];
    sampleCount = 0;
    silentSamples = 0;
    segmentStartedAt = null;
  }

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    let energy = 0;
    for (let index = 0; index < input.length; index += 1) energy += input[index] ** 2;
    const rms = Math.sqrt(energy / input.length);
    const pcm = downsample(input, audioContext.sampleRate);

    if (rms >= 0.009 && !active) {
      active = true;
      segmentStartedAt = Date.now();
    }
    if (!active) return;
    buffered.push(pcm);
    sampleCount += pcm.length;
    silentSamples = rms < 0.006 ? silentSamples + pcm.length : 0;

    if (silentSamples >= 16000 * 0.55 || sampleCount >= 16000 * 6) submit();
  };

  return {
    processor,
    silence,
    flush: submit,
    disconnect: () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      silence.disconnect();
    },
  };
}

async function startRecording({ microphoneLabel, mappedSystemOutputLabel }) {
  if (activeSession) throw new Error("A recording is already active.");
  setStatus("Opening microphone and system audio…");
  let microphoneStream;
  let systemStream;
  let audioContext;

  try {
    microphoneStream = await openPreferredMicrophone(microphoneLabel);
    systemStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    const systemAudioTracks = systemStream.getAudioTracks();
    if (systemAudioTracks.length === 0) {
      throw new Error(
        `macOS loopback capture returned no system audio track. Confirm Screen & System Audio Recording permission and that “${mappedSystemOutputLabel}” is the active output.`,
      );
    }
    systemStream.getVideoTracks().forEach((track) => track.stop());

    audioContext = new AudioContext({ latencyHint: "interactive" });
    await audioContext.resume();
    const mix = audioContext.createGain();
    const destination = audioContext.createMediaStreamDestination();
    const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
    const systemSource = audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks));
    microphoneSource.connect(mix);
    systemSource.connect(mix);
    mix.connect(destination);

    const mimeType = selectMimeType();
    const recorder = new MediaRecorder(
      destination.stream,
      mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined,
    );
    const session = {
      audioContext,
      microphoneStream,
      systemStream,
      destination,
      mix,
      recorder,
      chunkQueue: Promise.resolve(),
      transcriptQueue: Promise.resolve(),
    };
    session.livePcm = [
      createLivePcmCapture(audioContext, microphoneSource, "microphone", session),
      createLivePcmCapture(audioContext, systemSource, "system", session),
    ];

    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size === 0) return;
      session.chunkQueue = session.chunkQueue.then(async () => {
        await window.meetingRecorder.appendChunk(await event.data.arrayBuffer());
      });
    });
    recorder.start(1000);
    activeSession = session;
    setStatus(`Recording ${microphoneLabel} + ${mappedSystemOutputLabel}`);
    return {
      mimeType: recorder.mimeType,
      microphoneLabel,
      systemAudioTracks: systemAudioTracks.map((track) => track.label || "System audio"),
    };
  } catch (error) {
    microphoneStream?.getTracks().forEach((track) => track.stop());
    systemStream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
    setStatus(`Recorder error: ${error.message}`);
    throw error;
  }
}

async function requestScreenPermission({ mappedSystemOutputLabel }) {
  setStatus("Requesting Screen Recording permission…");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    if (stream.getVideoTracks().length === 0) {
      throw new Error("macOS did not grant Screen Recording access.");
    }
    if (stream.getAudioTracks().length === 0) {
      throw new Error(`macOS did not grant System Audio access for “${mappedSystemOutputLabel}”.`);
    }
    return {
      videoTracks: stream.getVideoTracks().map((track) => track.label || "Screen"),
      audioTracks: stream.getAudioTracks().map((track) => track.label || "System audio"),
    };
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

async function stopRecording() {
  const session = activeSession;
  if (!session) throw new Error("No recording is active.");
  setStatus("Finishing live transcript…");
  for (const capture of session.livePcm) capture.flush();
  await session.transcriptQueue;
  for (const capture of session.livePcm) capture.disconnect();

  await new Promise((resolve, reject) => {
    session.recorder.addEventListener("stop", resolve, { once: true });
    session.recorder.addEventListener(
      "error",
      (event) => reject(event.error || new Error("MediaRecorder failed.")),
      { once: true },
    );
    session.recorder.stop();
  });
  await session.chunkQueue;
  session.microphoneStream.getTracks().forEach((track) => track.stop());
  session.systemStream.getTracks().forEach((track) => track.stop());
  session.destination.stream.getTracks().forEach((track) => track.stop());
  await session.audioContext.close();
  activeSession = null;
  setStatus("Preparing final notes…");
  return { stopped: true };
}

window.meetingRecorder.onCommand(async ({ id, action, payload }) => {
  try {
    let result;
    if (action === "start") result = await startRecording(payload);
    else if (action === "stop") result = await stopRecording();
    else if (action === "request-screen-permission") result = await requestScreenPermission(payload);
    else throw new Error(`Unknown recorder command: ${action}`);
    window.meetingRecorder.completeCommand(id, result);
  } catch (error) {
    window.meetingRecorder.failCommand(id, error);
  }
});

document.getElementById("start").addEventListener("click", async () => {
  document.getElementById("start").disabled = true;
  await window.meetingRecorder.startAppRecording();
});
document.getElementById("stop").addEventListener("click", async () => {
  document.getElementById("stop").disabled = true;
  await window.meetingRecorder.stopAppRecording();
});
document.getElementById("permissions").addEventListener("click", async () => {
  const button = document.getElementById("permissions");
  button.disabled = true;
  try {
    renderPermissionState(await window.meetingRecorder.requestPermissions());
  } finally {
    button.disabled = false;
  }
});
document.getElementById("settings").addEventListener("click", () => {
  window.meetingRecorder.openSettings();
});
document.getElementById("folder").addEventListener("click", () => {
  window.meetingRecorder.openNotesFolder();
});

window.meetingRecorder.onPermissionState(renderPermissionState);
window.meetingRecorder.onZoomState(renderZoomState);
window.meetingRecorder.onZoomAutoRecordingState(renderZoomAutoRecordingState);
window.meetingRecorder.onState(renderAppState);
window.meetingRecorder.onMeetingReset(resetMeeting);
window.meetingRecorder.onTranscript(appendTranscript);
window.meetingRecorder.onAnalysis(renderAnalysis);
resetMeeting();
