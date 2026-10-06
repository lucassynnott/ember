const { executableName } = require("./platform");
const path = require("node:path");
const { spawn } = require("node:child_process");

function workerPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", executableName("meeting-notes-parakeet-worker"))
    : path.join(
        app.getAppPath(),
        "native",
        "parakeet-worker",
        "target",
        "release",
        executableName("meeting-notes-parakeet-worker"),
      );
}

class LiveParakeetTranscriber {
  constructor({ app, modelPath }) {
    this.binaryPath = workerPath(app);
    this.modelPath = modelPath;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.stdoutBuffer = "";
  }

  async start() {
    if (this.child) return;
    const child = spawn(this.binaryPath, [this.modelPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-12000);
    });
    child.stdout.on("data", (chunk) => this.#handleOutput(chunk));
    child.once("error", (error) => this.#fail(error));
    child.once("close", (code) => {
      if (code !== 0) {
        this.#fail(
          new Error(`Parakeet worker exited with code ${code}: ${this.stderr || "no details"}`),
        );
      }
      this.child = null;
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Parakeet model loading timed out.")), 90000);
      this.pending.set(0, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  #handleOutput(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      const id = message.ready ? 0 : message.id;
      const waiter = this.pending.get(id);
      if (!waiter) continue;
      this.pending.delete(id);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.text || "");
    }
  }

  #fail(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async transcribe(samples) {
    if (!this.child?.stdin?.writable) throw new Error("Parakeet worker is not running.");
    const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const id = this.nextId++;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(id, 0);
    header.writeUInt32LE(pcm.length, 4);
    const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await new Promise((resolve, reject) => {
      this.child.stdin.write(header);
      this.child.stdin.write(body, (error) => (error ? reject(error) : resolve()));
    });
    return result;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.child = null;
  }
}

module.exports = { LiveParakeetTranscriber, workerPath };
