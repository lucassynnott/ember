let state;
let models = [];
let selectedModelId = "";
let clearOpenRouterKey = false;

function renderOpenRouterModels() {
  const query = document.getElementById("model-search").value.trim().toLocaleLowerCase();
  const filtered = models.filter((model) =>
    [model.provider, model.name, model.id].some((value) =>
      String(value || "").toLocaleLowerCase().includes(query),
    ),
  );
  const select = document.getElementById("openrouter-models");
  select.replaceChildren();
  for (const model of filtered) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name}  ·  ${model.id}`;
    option.selected = model.id === selectedModelId;
    select.append(option);
  }
  document.getElementById("model-count").textContent =
    `${filtered.length.toLocaleString()} of ${models.length.toLocaleString()} models`;
}

async function load() {
  state = await window.meetingRecorder.getSettings();
  document.getElementById("notes-folder").value = state.notesDir;
  document.getElementById("speaker-name").value = state.speakerName;
  document.getElementById("auto-record-zoom").checked = state.autoRecordZoomMeetings;
  document.getElementById("notion-sync").checked = state.notionSyncEnabled;
  document.getElementById("notion-data-source").value = state.notionDataSourceId || "";
  selectedModelId = state.openRouterModel;
  document.getElementById("key-state").textContent = state.hasOpenRouterKey
    ? "A key is saved securely. Paste a new key only to replace it."
    : "No key saved. Keys are encrypted with macOS secure storage.";

  const transcriptionSelect = document.getElementById("transcription-model");
  transcriptionSelect.replaceChildren();
  for (const model of state.transcriptionModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.label} — ${model.detail}`;
    option.selected = model.id === state.transcriptionModelId;
    transcriptionSelect.append(option);
  }
  if (!state.transcriptionModels.length) {
    const option = document.createElement("option");
    option.textContent = "No supported local transcription models found";
    option.disabled = true;
    transcriptionSelect.append(option);
  }

  try {
    models = await window.meetingRecorder.getOpenRouterModels();
    renderOpenRouterModels();
  } catch (error) {
    document.getElementById("model-count").textContent = error.message;
  }
}

document.getElementById("model-search").addEventListener("input", renderOpenRouterModels);
document.getElementById("openrouter-models").addEventListener("change", (event) => {
  selectedModelId = event.target.value;
});
document.getElementById("browse").addEventListener("click", async () => {
  const selected = await window.meetingRecorder.chooseNotesFolder();
  if (selected) document.getElementById("notes-folder").value = selected;
});
document.getElementById("clear-key").addEventListener("click", () => {
  clearOpenRouterKey = true;
  document.getElementById("openrouter-key").value = "";
  document.getElementById("key-state").textContent = "The saved key will be removed.";
});
document.getElementById("openrouter-key").addEventListener("input", () => {
  clearOpenRouterKey = false;
});
document.getElementById("save").addEventListener("click", async () => {
  const button = document.getElementById("save");
  const saveState = document.getElementById("save-state");
  button.disabled = true;
  saveState.textContent = "Saving…";
  try {
    state = await window.meetingRecorder.saveSettings({
      notesDir: document.getElementById("notes-folder").value,
      speakerName: document.getElementById("speaker-name").value,
      autoRecordZoomMeetings: document.getElementById("auto-record-zoom").checked,
      notionSyncEnabled: document.getElementById("notion-sync").checked,
      notionDataSourceId: document.getElementById("notion-data-source").value,
      transcriptionModelId: document.getElementById("transcription-model").value,
      openRouterModel: selectedModelId,
      openRouterKey: document.getElementById("openrouter-key").value,
      clearOpenRouterKey,
    });
    document.getElementById("openrouter-key").value = "";
    clearOpenRouterKey = false;
    document.getElementById("key-state").textContent = state.hasOpenRouterKey
      ? "A key is saved securely. Paste a new key only to replace it."
      : "No key saved. Keys are encrypted with macOS secure storage.";
    saveState.textContent = "Saved";
  } catch (error) {
    saveState.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

load();
