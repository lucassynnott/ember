const CAPTURE_PREFERENCES = Object.freeze({
  microphoneLabel: "Microphone",
  systemAudioMode: "Electron macOS loopback",
  mappedSystemOutputLabel: "System Audio",
  ignoredInputLabels: Object.freeze(["Music"]),
});

function normalizeLabel(label) {
  return String(label || "")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim()
    .toLocaleLowerCase();
}

function pickPreferredMicrophone(devices, preferredLabel = CAPTURE_PREFERENCES.microphoneLabel) {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const wanted = normalizeLabel(preferredLabel);
  const exact = inputs.find((device) => normalizeLabel(device.label) === wanted);

  if (exact) return exact;

  const available = inputs.map((device) => device.label || "unlabeled input").join(", ");
  throw new Error(
    `Microphone “${preferredLabel}” was not found. Available inputs: ${available || "none"}`,
  );
}

module.exports = {
  CAPTURE_PREFERENCES,
  pickPreferredMicrophone,
};
