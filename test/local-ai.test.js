const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { LocalAI } = require("../src/local-ai");
const { aiTarget } = require("../src/summary");
const { ModelManager, AI_CATALOG } = require("../src/model-manager");

// Stands in for `python -m mlx_lm server`: answers /v1/models and echoes chat requests.
function fakeSpawn(record) {
  return (command, args) => {
    const port = Number(args[args.indexOf("--port") + 1]);
    record.spawns.push({ command, args });
    const child = new EventEmitter();
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.url === "/v1/models") return response.end("{}");
      record.requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: '{"text":"ok"}' } }] }));
    });
    server.listen(port, "127.0.0.1");
    child.kill = () => {
      server.closeAllConnections();
      server.close();
      record.kills += 1;
      child.emit("exit", 0);
    };
    child.stderr = new EventEmitter();
    return child;
  };
}

test("the relay needs its token, starts the model once, strips cloud options and frees memory when idle", async () => {
  const record = { spawns: [], requests: [], kills: 0 };
  const ai = new LocalAI({ getPython: async () => "/fake/python", getModelPath: async () => "/models/gemma", idleMs: 150, spawnImpl: fakeSpawn(record), log: {} });
  const endpoint = await ai.endpoint();
  const post = (token, body) =>
    fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await post("wrong", {})).status, 401);
  assert.equal(record.spawns.length, 0, "nothing starts for a rejected request");

  const reply = await post(ai.token, { model: "openai/gpt", messages: [{ role: "user", content: "hi" }], provider: { sort: "latency" }, reasoning: { enabled: false }, max_tokens: 99999 });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).choices[0].message.content, '{"text":"ok"}');
  await post(ai.token, { messages: [] });
  assert.equal(record.spawns.length, 1, "one model server for both requests");
  assert.ok(record.spawns[0].args.includes("--chat-template-args"));
  const [first] = record.requests;
  assert.equal(first.model, "/models/gemma");
  assert.equal(first.provider, undefined);
  assert.equal(first.reasoning, undefined);
  assert.equal(first.max_tokens, 3000);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(record.kills, 1, "stopped after going idle");
  assert.equal(ai.running, false);
  ai.close();
});

test("with no model installed the relay says so instead of starting anything", async () => {
  const record = { spawns: [], requests: [], kills: 0 };
  const ai = new LocalAI({ getPython: async () => "/fake/python", getModelPath: async () => null, spawnImpl: fakeSpawn(record), log: {} });
  const reply = await fetch(await ai.endpoint(), { method: "POST", headers: { authorization: `Bearer ${ai.token}` }, body: "{}" });
  assert.equal(reply.status, 503);
  assert.match((await reply.json()).error.message, /No on-device model/);
  assert.equal(record.spawns.length, 0);
  ai.close();
});

test("offline mode never falls back to OpenRouter", () => {
  const cloud = aiTarget({ openRouterKey: "sk-or-1", openRouterModel: "openai/gpt" });
  assert.equal(cloud.endpoint, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(cloud.key, "sk-or-1");
  const waiting = aiTarget({ aiLocal: true, aiEndpoint: null, aiKey: "x", openRouterKey: "sk-or-1" });
  assert.equal(waiting.key, "", "no model yet: AI is off, not sent to the cloud");
  const ready = aiTarget({ aiLocal: true, aiEndpoint: "http://127.0.0.1:5/v1/chat/completions", aiKey: "token", openRouterKey: "sk-or-1" });
  assert.equal(ready.endpoint, "http://127.0.0.1:5/v1/chat/completions");
  assert.equal(ready.key, "token");
});

test("the MLX runtime is found in Phonon's runtime when it can run Gemma 4, else the AI runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlx-"));
  const venv = async (name, withGemma) => {
    const dir = path.join(root, name);
    await fs.mkdir(path.join(dir, "bin"), { recursive: true });
    await fs.writeFile(path.join(dir, "bin", "python"), "");
    const models = path.join(dir, "lib", "python3.13", "site-packages", "mlx_lm", "models");
    await fs.mkdir(models, { recursive: true });
    if (withGemma) await fs.writeFile(path.join(models, "gemma4_text.py"), "");
    return dir;
  };
  const phonon = await venv("phonon-venv", false);
  const ai = await venv("ai-venv", true);
  const manager = new ModelManager({ catalog: AI_CATALOG, phononVenv: phonon, aiVenv: ai, supportDir: root, modelsDir: root });
  assert.equal(await manager.mlxPython(), path.join(ai, "bin", "python"), "Phonon's MLX is too old for Gemma 4");
  await fs.writeFile(path.join(phonon, "lib", "python3.13", "site-packages", "mlx_lm", "models", "gemma4_text.py"), "");
  assert.equal(await manager.mlxPython(), path.join(phonon, "bin", "python"));
  assert.ok(AI_CATALOG.every((entry) => entry.install.files.some((file) => file.name === "model.safetensors" && /^[0-9a-f]{64}$/.test(file.sha256))));
  await fs.rm(root, { recursive: true, force: true });
});
