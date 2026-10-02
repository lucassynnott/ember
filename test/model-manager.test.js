const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CATALOG, ModelManager } = require("../src/model-manager");
const { detectTranscriptionModels } = require("../src/transcription-models");

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function fakeHub(files, { chunkDelayMs = 0 } = {}) {
  const requests = [];
  const fetchImpl = async (url, { headers = {}, signal } = {}) => {
    requests.push({ url, range: headers.Range });
    const name = url.split("/").pop();
    const body = files[name];
    if (!body) return new Response("missing", { status: 404 });
    const start = headers.Range ? Number(headers.Range.match(/bytes=(\d+)-/)[1]) : 0;
    const slice = body.subarray(start);
    const stream = new ReadableStream({
      async start(controller) {
        for (let offset = 0; offset < slice.length; offset += 1024) {
          if (signal?.aborted) return controller.error(new DOMException("aborted", "AbortError"));
          controller.enqueue(slice.subarray(offset, offset + 1024));
          if (chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: start ? 206 : 200 });
  };
  return { fetchImpl, requests };
}

function entry(files, overrides = {}) {
  return {
    id: "test-model",
    type: "parakeet",
    label: "Test model",
    realtime: true,
    install: {
      kind: "huggingface",
      repo: "example/test",
      revision: "abc123",
      target: "test-model-int8",
      files: Object.entries(files).map(([name, body]) => ({ name, size: body.length, sha256: sha256(body) })),
      ...overrides,
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "model-manager-test-"));
}

test("catalog pins every Hugging Face download to a revision and checksum", () => {
  for (const model of CATALOG.filter((candidate) => candidate.install.kind === "huggingface")) {
    assert.match(model.install.revision, /^[0-9a-f]{40}$/, model.id);
    for (const file of model.install.files.filter((candidate) => candidate.size > 1_000_000)) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${model.id}/${file.name}`);
    }
  }
});

test("downloads and verifies a model, reporting progress, then installs it atomically", async () => {
  const modelsDir = tempDir();
  const files = { "encoder.onnx": crypto.randomBytes(300_000), "vocab.txt": Buffer.from("a\nb\n") };
  const hub = fakeHub(files);
  const manager = new ModelManager({ catalog: [entry(files)], modelsDir, fetchImpl: hub.fetchImpl });
  const events = [];
  manager.on("progress", (progress) => events.push(progress));

  await manager.install("test-model");

  const target = path.join(modelsDir, "test-model-int8");
  assert.deepEqual(fs.readFileSync(path.join(target, "encoder.onnx")), files["encoder.onnx"]);
  assert.equal(fs.existsSync(`${target}.partial`), false);
  assert.ok(events.some((event) => event.state === "downloading" && event.total === 300_004));
  assert.equal(events.at(-1).state, "installed");
  assert.match(hub.requests[0].url, /^https:\/\/huggingface\.co\/example\/test\/resolve\/abc123\/encoder\.onnx$/);
  assert.equal(manager.isBusy("test-model"), false);
});

test("rejects a download whose checksum does not match", async () => {
  const modelsDir = tempDir();
  const files = { "encoder.onnx": crypto.randomBytes(50_000) };
  const catalogEntry = entry(files);
  catalogEntry.install.files[0].sha256 = "0".repeat(64);
  const manager = new ModelManager({ catalog: [catalogEntry], modelsDir, fetchImpl: fakeHub(files).fetchImpl });

  await assert.rejects(manager.install("test-model"), /failed its checksum/);
  assert.equal(fs.existsSync(path.join(modelsDir, "test-model-int8")), false);
});

test("resumes an interrupted download with a Range request", async () => {
  const modelsDir = tempDir();
  const files = { "encoder.onnx": crypto.randomBytes(200_000) };
  const partialDir = path.join(modelsDir, "test-model-int8.partial");
  fs.mkdirSync(partialDir, { recursive: true });
  fs.writeFileSync(path.join(partialDir, "encoder.onnx"), files["encoder.onnx"].subarray(0, 120_000));
  const hub = fakeHub(files);
  const manager = new ModelManager({ catalog: [entry(files)], modelsDir, fetchImpl: hub.fetchImpl });

  await manager.install("test-model");

  assert.equal(hub.requests[0].range, "bytes=120000-");
  assert.deepEqual(fs.readFileSync(path.join(modelsDir, "test-model-int8", "encoder.onnx")), files["encoder.onnx"]);
});

test("cancels a download, keeps the partial file for resuming, and can remove a model", async () => {
  const modelsDir = tempDir();
  const files = { "encoder.onnx": crypto.randomBytes(400_000) };
  const manager = new ModelManager({
    catalog: [entry(files)],
    modelsDir,
    fetchImpl: fakeHub(files, { chunkDelayMs: 2 }).fetchImpl,
  });
  const states = [];
  manager.on("progress", (progress) => states.push(progress.state));

  const install = manager.install("test-model");
  // Cancel once some of the file has arrived, however busy the machine is.
  const partial = path.join(modelsDir, "test-model-int8.partial", "encoder.onnx");
  for (let waited = 0; waited < 3000 && !(fs.existsSync(partial) && fs.statSync(partial).size > 0); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(manager.cancel("test-model"), true);
  await install;

  assert.equal(states.at(-1), "cancelled");
  assert.equal(fs.existsSync(path.join(modelsDir, "test-model-int8")), false);
  assert.ok(fs.statSync(path.join(modelsDir, "test-model-int8.partial", "encoder.onnx")).size > 0);

  await manager.remove("test-model");
  assert.equal(fs.existsSync(path.join(modelsDir, "test-model-int8.partial")), false);
});

test("detects a downloaded Whisper model and ignores unfinished downloads", async () => {
  const models = await detectTranscriptionModels([], { isInstalling: () => true });
  assert.ok(models.every((model) => model.type !== "phonon"));
  assert.ok(models.every((model) => !model.path.endsWith(".partial")));
});
