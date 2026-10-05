// Offline mode: the app's AI features talk to a model on this Mac instead of OpenRouter.
// A small relay on 127.0.0.1 takes the same OpenAI-style requests the app already makes, starts
// MLX's model server the first time it's needed, and stops it after a while idle to free memory.
// Requests must carry a random per-launch token, so other apps can't use it.
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");

const IDLE_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 3000;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class LocalAI {
  constructor({ getPython, getModelPath, idleMs = IDLE_MS, spawnImpl = spawn, log = console }) {
    Object.assign(this, { getPython, getModelPath, idleMs, spawnImpl, log });
    this.token = crypto.randomBytes(24).toString("hex");
    this.relay = null;
    this.relayPort = null;
    this.child = null;
    this.childPort = null;
    this.childModel = null;
    this.starting = null;
    this.idleTimer = null;
    this.active = 0;
  }

  /** Where the app sends chat requests while offline mode is on. */
  async endpoint() {
    if (!this.relay) {
      this.relay = http.createServer((request, response) => void this.#handle(request, response));
      await new Promise((resolve) => this.relay.listen(0, "127.0.0.1", resolve));
      this.relayPort = this.relay.address().port;
    }
    return `http://127.0.0.1:${this.relayPort}/v1/chat/completions`;
  }

  get running() {
    return Boolean(this.child);
  }

  async #handle(request, response) {
    const fail = (status, message) => {
      if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message } }));
    };
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return fail(404, "Not found.");
    const auth = request.headers.authorization || "";
    const given = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(this.token);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return fail(401, "Not allowed.");

    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 4_000_000) return fail(413, "That request is too large.");
    }
    this.active += 1;
    clearTimeout(this.idleTimer);
    try {
      const port = await this.#ensure();
      const body = JSON.parse(raw || "{}");
      // OpenRouter-only options mean nothing to the local server.
      delete body.provider;
      delete body.reasoning;
      body.model = this.childModel;
      body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
      const payload = JSON.stringify(body);
      await new Promise((resolve) => {
        const upstream = http.request(
          { host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
          (reply) => {
            response.writeHead(reply.statusCode || 502, { "content-type": reply.headers["content-type"] || "application/json" });
            reply.pipe(response);
            reply.on("end", resolve);
            reply.on("error", resolve);
          },
        );
        upstream.on("error", (error) => {
          fail(502, `The on-device model stopped: ${error.message}`);
          resolve();
        });
        // If the app gives up on a request, stop generating for it.
        response.on("close", () => upstream.destroy());
        upstream.end(payload);
      });
    } catch (error) {
      fail(503, error.message);
    } finally {
      this.active -= 1;
      this.#scheduleIdle();
    }
  }

  #scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.active > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  async #ensure() {
    const model = await this.getModelPath();
    if (!model) throw new Error("No on-device model is installed. Download one in Settings → AI notes.");
    if (this.child && this.childModel === model) return this.childPort;
    if (this.child) this.stop();
    if (!this.starting) {
      this.starting = this.#start(model).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async #start(model) {
    const python = await this.getPython();
    if (!python) throw new Error("The on-device AI runtime isn't installed. Download a model in Settings → AI notes.");
    const port = await freePort();
    const child = this.spawnImpl(
      python,
      ["-m", "mlx_lm", "server", "--model", model, "--host", "127.0.0.1", "--port", String(port), "--max-tokens", String(MAX_TOKENS), "--chat-template-args", JSON.stringify({ enable_thinking: false })],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.childPort = null;
        this.childModel = null;
      }
    });
    this.child = child;
    this.childPort = port;
    this.childModel = model;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child !== child) throw new Error(`The on-device model couldn't start. ${stderr.trim().split("\n").pop() || ""}`.trim());
      const ready = await new Promise((resolve) => {
        const probe = http.get({ host: "127.0.0.1", port, path: "/v1/models", timeout: 1000 }, (reply) => {
          reply.resume();
          resolve(reply.statusCode === 200);
        });
        probe.on("error", () => resolve(false));
        probe.on("timeout", () => {
          probe.destroy();
          resolve(false);
        });
      });
      if (ready) {
        this.log.log?.(`On-device AI ready: ${model}`);
        return port;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.stop();
    throw new Error("The on-device model took too long to start.");
  }

  /** Loads the model ahead of use (dictation starting, a call starting), so the first answer isn't slow. */
  warm() {
    clearTimeout(this.idleTimer);
    return this.#ensure()
      .then(() => this.#scheduleIdle())
      .catch(() => {});
  }

  /** Frees the model's memory; it starts again on the next request. */
  stop() {
    clearTimeout(this.idleTimer);
    if (this.child) this.child.kill("SIGTERM");
    this.child = null;
    this.childPort = null;
    this.childModel = null;
  }

  close() {
    this.stop();
    this.relay?.close();
    this.relay = null;
  }
}

module.exports = { LocalAI };
