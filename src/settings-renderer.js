let state;
let modelState = { catalog: [], installed: [], selectedId: "" };
const progressById = new Map();

function formatBytes(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await onClick();
    } catch (error) {
      document.getElementById("save-state").textContent = error.message;
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

function modelCard({ title, meta, detail, live, selected, actions, progress }) {
  const card = element("div", `model-card${selected ? " selected" : ""}`);
  const main = element("div", "model-main");
  const heading = element("div", "model-title", title);
  heading.append(element("span", `badge${live ? " live" : ""}`, live ? "Live" : "After recording"));
  if (selected) heading.append(element("span", "badge in-use", "In use"));
  main.append(heading, element("div", "model-meta", meta));
  if (detail) main.append(element("div", "model-detail", detail));

  if (progress && ["starting", "downloading", "installing", "finishing"].includes(progress.state)) {
    const indeterminate = progress.state !== "downloading";
    const bar = element("div", `progress${indeterminate ? " indeterminate" : ""}`);
    const fill = element("div", "bar");
    fill.style.width = `${Math.round((progress.fraction || 0) * 100)}%`;
    bar.append(fill);
    const text =
      progress.state === "downloading" && progress.total
        ? `${Math.floor((progress.received / progress.total) * 100)}% · ${formatBytes(progress.received)} of ${formatBytes(progress.total)}`
        : progress.message;
    main.append(bar, element("div", "progress-text", text));
  } else if (progress?.state === "failed") {
    main.append(element("div", "progress-text error", progress.message));
  }

  const actionRow = element("div", "model-actions");
  actionRow.append(...actions);
  card.append(main, actionRow);
  return card;
}

function renderModels(nextState = modelState) {
  modelState = nextState;
  const list = document.getElementById("model-list");
  list.replaceChildren();
  for (const entry of modelState.catalog) {
    const progress = progressById.get(entry.id) || entry.progress;
    const busy = progress && ["starting", "downloading", "installing", "finishing"].includes(progress.state);
    const installedId = entry.installedModelId;
    const selected = Boolean(installedId) && installedId === modelState.selectedId;
    const actions = [];
    if (busy) {
      actions.push(button("Cancel", "quiet", () => window.meetingRecorder.cancelModelInstall(entry.id)));
    } else if (installedId) {
      if (!selected) actions.push(button("Use", "primary", async () => renderModels(await window.meetingRecorder.selectModel(installedId))));
      actions.push(
        button("Remove", "quiet", async () => {
          if (!confirm(`Remove ${entry.label}? It will need to be downloaded again to use it.`)) return;
          renderModels(await window.meetingRecorder.removeModel(entry.id));
        }),
      );
    } else {
      actions.push(
        button(progress?.state === "failed" ? "Retry" : "Download", "primary", async () => {
          progressById.set(entry.id, { id: entry.id, state: "starting", message: "Starting…" });
          renderModels();
          await window.meetingRecorder.installModel(entry.id);
        }),
      );
    }
    list.append(
      modelCard({
        title: entry.label,
        meta: `${entry.source} · ${entry.languages} · ${entry.sizeLabel}`,
        detail: entry.detail,
        live: entry.realtime,
        selected,
        actions,
        progress,
      }),
    );
  }

  const others = modelState.installed.filter((model) => !model.catalogId);
  const otherContainer = document.getElementById("other-models");
  otherContainer.replaceChildren();
  if (others.length) {
    otherContainer.append(element("div", "subhead", "Also found on this Mac"));
    const otherList = element("div", "model-list");
    for (const model of others) {
      const selected = model.id === modelState.selectedId;
      otherList.append(
        modelCard({
          title: model.label,
          meta: model.path,
          detail: model.detail,
          live: model.realtime,
          selected,
          actions: selected
            ? []
            : [button("Use", "primary", async () => renderModels(await window.meetingRecorder.selectModel(model.id)))],
        }),
      );
    }
    otherContainer.append(otherList);
  }
}

let renderScheduled = false;
window.meetingRecorder.onModelProgress((progress) => {
  progressById.set(progress.id, progress);
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderModels();
  });
});
window.meetingRecorder.onModelsChanged((nextState) => {
  for (const entry of nextState.catalog) {
    const progress = progressById.get(entry.id);
    if (progress && !["failed", "cancelled"].includes(progress.state) && !entry.progress) progressById.delete(entry.id);
  }
  renderModels(nextState);
});
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

  renderModels(await window.meetingRecorder.listModels());

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
