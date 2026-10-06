const { supportDirectory, venvExecutable } = require("./platform");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const net = require("node:net");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const SAMPLE_RATE = 16000;

function phononVenvDirectory() {
  return path.join(supportDirectory(), "phonon-venv");
}

function phononCandidates() {
  return [
    process.env.FERMION_BIN,
    venvExecutable(phononVenvDirectory(), "fermion"),
  ].filter(Boolean);
}

async function findFermionBinary() {
  for (const candidate of phononCandidates()) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const dataBytes = samples.length * 4;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]);
}

function multipartBody(fields, file) {
  const boundary = `----meeting-notes-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { boundary, body: Buffer.concat(parts) };
}

function socketRequest(socketPath, { method = "GET", pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ ...(typeof socketPath === "string" ? { socketPath } : socketPath), method, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode >= 400) {
          reject(new Error(`Phonon server returned ${response.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        resolve(text);
      });
    });
    request.setTimeout(pathname === "/health" ? 3000 : 120000, () => request.destroy(new Error("Phonon request timed out.")));
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

class LivePhononTranscriber {
  constructor({ binaryPath, platform = process.platform, spawnProcess = spawn }) {
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.apiKey = crypto.randomBytes(32).toString("hex");
    this.binaryPath = binaryPath;
    this.socketPath = path.join(os.tmpdir(), `meeting-notes-phonon-${process.pid}.sock`);
    this.child = null;
    this.stderr = "";
    this.exitError = null;
    this.stopping = false;
    this.startPromise = null;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.child) return Promise.resolve();
    const pending = this.#start();
    this.startPromise = pending;
    const clear = () => { if (this.startPromise === pending) this.startPromise = null; };
    pending.then(clear, clear);
    return pending;
  }

  async #start() {
    this.stopping = false;
    this.stderr = "";
    this.apiKey = crypto.randomBytes(32).toString("hex");
    let binary = this.binaryPath;
    let args = ["serve", "phonon-2", "--unix-socket", this.socketPath];
    if (this.platform === "win32") {
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const port = server.address().port;
      await new Promise(resolve => server.close(resolve));
      this.transport = { host: "127.0.0.1", port };
      args = ["serve", "phonon-2", "--host", "127.0.0.1", "--port", String(port), "--api-key", this.apiKey];
    } else {
      await fs.rm(this.socketPath, { force: true });
      this.transport = this.socketPath;
    }
    if (this.platform === "win32") {
      // Launch the venv interpreter directly: stopping a console-script launcher alone can
      // leave its Python server child alive on Windows.
      const python = path.join(path.dirname(this.binaryPath), "python.exe");
      if (await fs.access(python).then(() => true).catch(() => false)) {
        binary = python;
        args = ["-c", "from fermion.cli import main; main()", ...args];
      }
    }
    if (this.stopping) throw new Error("Phonon startup cancelled.");
    const child = this.spawnProcess(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.exitError = null;
    const capture = (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-12000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      this.exitError = error;
    });
    child.once("close", (code) => {
      if (!this.stopping) this.exitError = new Error(`Phonon server exited with code ${code}: ${this.stderr || "no details"}`);
      this.child = null;
    });

    // The first run downloads and unpacks the model and compiles MLX shaders.
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error("Phonon startup cancelled.");
      if (this.exitError) throw this.exitError;
      try {
        const health = JSON.parse(await this.request({ pathname: "/health" }));
        if (health.status === "ok" && !this.stopping) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await this.stop();
    throw new Error("Phonon-2 model loading timed out.");
  }

  request(options) {
    const headers = { ...options.headers, ...(this.platform === "win32" ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
    return socketRequest(this.transport, { ...options, headers });
  }

  async transcribe(samples) {
    if (!this.child) throw this.exitError || new Error("Phonon server is not running.");
    const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const { boundary, body } = multipartBody(
      { model: "phonon-2", response_format: "json" },
      { name: "segment.wav", type: "audio/wav", data: encodeWav(pcm) },
    );
    const text = await this.request({
      method: "POST",
      pathname: "/v1/audio/transcriptions",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      body,
    });
    return JSON.parse(text).text || "";
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    if (child) {
      const exited = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      if (process.platform === "win32" && child.pid) {
        await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }).catch(() => child.kill("SIGKILL"));
      } else child.kill("SIGTERM");
      await exited;
    }
    this.child = null;
    if (this.platform !== "win32") await fs.rm(this.socketPath, { force: true });
  }
}

module.exports = { LivePhononTranscriber, encodeWav, findFermionBinary, phononVenvDirectory };
