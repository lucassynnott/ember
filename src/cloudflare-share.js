// Sharing recordings as links, from the user's own Cloudflare account.
//
// Setup goes through the Cloudflare connection in Composio (the relay, or the user's own Composio):
// Ember makes an R2 bucket, makes sure the account has a workers.dev subdomain, and publishes
// share-worker.js as the "ember-share" Worker with the bucket and a fresh upload secret bound to it.
// After that, videos upload straight to that Worker with the secret, never through Composio.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const WORKER_NAME = "ember-share";
const BUCKET_NAME = "ember-shares";
const WORKER_SOURCE = path.join(__dirname, "share-worker.js");
const PART_SIZE = 10 * 1024 * 1024;
const COMPATIBILITY_DATE = "2026-09-01";

class CloudflareError extends Error {
  constructor(message, { code = null, url = null } = {}) {
    super(message);
    this.code = code;
    this.url = url;
  }
}

function workerVersion(source) {
  return /const VERSION = "([^"]+)"/.exec(source)?.[1] || "0";
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** 12 characters from 57: about 70 bits, so links can't be guessed. */
function newShareId() {
  const bytes = crypto.randomBytes(24);
  let id = "";
  for (const byte of bytes) {
    if (byte >= 57 * 4) continue;
    id += ALPHABET[byte % 57];
    if (id.length === 12) return id;
  }
  return newShareId();
}

function vttTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = (total % 60).toFixed(3).padStart(6, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${rest}`;
}

/** Captions from the transcript's timed lines. */
function captionsFrom(transcript) {
  const cues = transcript
    .filter((line) => line.text && line.end > line.start)
    .map((line) => `${vttTime(line.start)} --> ${vttTime(line.end)}\n${line.text.replace(/-->/g, "→")}`);
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : null;
}

/** Times in the original, moved to where they land in an edit (dropping anything cut out). */
function retime(project, items) {
  // An edit is clips played back to back (or, in the first version, the recording with parts cut out).
  const segments = Array.isArray(project?.clips)
    ? project.clips.map((clip) => ({ start: clip.start, end: clip.end, speed: clip.speed, removed: false }))
    : Array.isArray(project?.segments)
      ? project.segments
      : null;
  if (!segments) return items;
  if (Array.isArray(project?.clips)) {
    // Clips can be in any order: each moment plays where its (first) clip is.
    const toEdited = (source) => {
      let elapsed = 0;
      for (const clip of segments) {
        if (source >= clip.start && source < clip.end) return elapsed + (source - clip.start) / (clip.speed || 1);
        elapsed += (clip.end - clip.start) / (clip.speed || 1);
      }
      return null;
    };
    return items
      .map((item) => {
        const start = toEdited(item.start);
        if (start === null) return null;
        const end = item.end === undefined ? undefined : (toEdited(item.end) ?? toEdited(Math.max(item.start, item.end - 0.01)) ?? start + 0.5);
        return { ...item, start: Math.round(start * 100) / 100, ...(end === undefined ? {} : { end: Math.round(end * 100) / 100 }) };
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start);
  }
  const toEdited = (source) => {
    let elapsed = 0;
    for (const segment of segments) {
      if (source >= segment.start && source < segment.end) return segment.removed ? null : elapsed + (source - segment.start) / (segment.speed || 1);
      if (!segment.removed) elapsed += (segment.end - segment.start) / (segment.speed || 1);
    }
    return null;
  };
  return items
    .map((item) => {
      const start = toEdited(item.start);
      if (start === null) return null;
      const end = item.end === undefined ? undefined : (toEdited(item.end) ?? toEdited(Math.max(item.start, item.end - 0.01)) ?? start + 0.5);
      return { ...item, start: Math.round(start * 100) / 100, ...(end === undefined ? {} : { end: Math.round(end * 100) / 100 }) };
    })
    .filter(Boolean);
}

function hashPassword(password, salt = crypto.randomBytes(12).toString("hex")) {
  return { salt, hash: crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex") };
}

/** The setup and the secret, kept in userData; the secret encrypted with the macOS keychain. */
class ShareStore {
  constructor({ filePath, encrypt, decrypt }) {
    Object.assign(this, { filePath, encrypt, decrypt });
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      this.data = {};
    }
    return this.data;
  }

  get config() {
    return this.load().config || null;
  }

  secret() {
    const stored = this.load().secret;
    if (!stored) return null;
    try {
      return this.decrypt(stored);
    } catch {
      return null;
    }
  }

  async save({ config, secret }) {
    const data = this.load();
    if (config !== undefined) data.config = config;
    if (secret !== undefined) data.secret = secret ? this.encrypt(secret) : null;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(`${this.filePath}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fsp.rename(`${this.filePath}.tmp`, this.filePath);
  }

  async clear() {
    this.data = {};
    await fsp.rm(this.filePath, { force: true });
  }
}

class ShareService {
  /**
   * @param cloudflare (method, path, body) => Cloudflare's JSON answer, through Composio
   */
  constructor({ cloudflare, store, fetchImpl = globalThis.fetch, workerSource = null, healthTimeoutMs = 120_000, pollMs = 3000 }) {
    Object.assign(this, { cloudflare, store, fetch: fetchImpl, healthTimeoutMs, pollMs });
    this.source = workerSource ?? fs.readFileSync(WORKER_SOURCE, "utf8");
    this.version = workerVersion(this.source);
  }

  get config() {
    return this.store.config;
  }

  async #cf(method, apiPath, body) {
    const answer = await this.cloudflare(method, apiPath, body);
    if (answer && answer.success === false) {
      const error = answer.errors?.[0] || {};
      throw new CloudflareError(error.message || "Cloudflare refused that.", { code: error.code ?? null });
    }
    return answer?.result;
  }

  /** Sets everything up, or repairs it; safe to run again. Reports each step. */
  async setup(onStep = () => {}) {
    onStep({ step: "account", message: "Finding your Cloudflare account…" });
    const accounts = (await this.#cf("GET", "/accounts")) || [];
    if (!accounts.length) throw new CloudflareError("This Cloudflare login has no accounts.");
    const account = accounts.find((item) => item.id === this.config?.accountId) || accounts[0];

    onStep({ step: "storage", message: "Making storage for your videos…" });
    const r2 = `https://dash.cloudflare.com/${account.id}/r2/overview`;
    let buckets;
    try {
      buckets = (await this.#cf("GET", `/accounts/${account.id}/r2/buckets`))?.buckets || [];
    } catch (error) {
      if (error.code === 10042 || /enable R2|R2 is not enabled|purchase/i.test(error.message)) {
        throw new CloudflareError("Turn on R2 in Cloudflare first. It's free up to 10 GB. Then try again.", { code: "r2", url: r2 });
      }
      throw error;
    }
    if (!buckets.some((bucket) => bucket.name === BUCKET_NAME)) {
      try {
        await this.#cf("POST", `/accounts/${account.id}/r2/buckets`, { name: BUCKET_NAME });
      } catch (error) {
        if (error.code === 10042) throw new CloudflareError("Turn on R2 in Cloudflare first. It's free up to 10 GB. Then try again.", { code: "r2", url: r2 });
        if (error.code !== 10004) throw error;
      }
    }

    onStep({ step: "worker", message: "Publishing your share page…" });
    let subdomain = null;
    try {
      subdomain = (await this.#cf("GET", `/accounts/${account.id}/workers/subdomain`))?.subdomain || null;
    } catch {}
    if (!subdomain) {
      const wanted = `ember-${crypto.randomBytes(3).toString("hex")}`;
      subdomain = (await this.#cf("PUT", `/accounts/${account.id}/workers/subdomain`, { subdomain: wanted }))?.subdomain || wanted;
    }
    const workers = (await this.#cf("GET", `/accounts/${account.id}/workers/workers`)) || [];
    let worker = workers.find((item) => item.name === WORKER_NAME);
    if (!worker) {
      worker = await this.#cf("POST", `/accounts/${account.id}/workers/workers`, {
        name: WORKER_NAME,
        subdomain: { enabled: true, previews_enabled: false },
        observability: { enabled: false },
      });
    }
    const secret = this.store.secret() || crypto.randomBytes(32).toString("hex");
    await this.#deploy(account.id, worker.id, secret);
    const url = `https://${WORKER_NAME}.${subdomain}.workers.dev`;
    await this.store.save({
      secret,
      config: { accountId: account.id, accountName: account.name || "", workerId: worker.id, bucket: BUCKET_NAME, url, version: this.version, setUpAt: new Date().toISOString() },
    });

    onStep({ step: "check", message: "Checking it's live…" });
    await this.#waitUntilLive(url, secret);
    onStep({ step: "done", message: "Ready to share." });
    return this.config;
  }

  async #deploy(accountId, workerId, secret) {
    await this.#cf("POST", `/accounts/${accountId}/workers/workers/${workerId}/versions?deploy=true`, {
      compatibility_date: COMPATIBILITY_DATE,
      main_module: "worker.js",
      modules: [{ name: "worker.js", content_type: "application/javascript+module", content_base64: Buffer.from(this.source).toString("base64") }],
      bindings: [
        { type: "r2_bucket", name: "BUCKET", bucket_name: BUCKET_NAME },
        { type: "secret_text", name: "UPLOAD_SECRET", text: secret },
      ],
    });
  }

  // A new workers.dev name can take a minute to answer.
  async #waitUntilLive(url, secret) {
    const deadline = Date.now() + this.healthTimeoutMs;
    let last = null;
    let inARow = 0;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) });
        // Several answers in a row, so it's live everywhere and not just on one server.
        if (response.ok && ++inARow >= 3) return;
        if (!response.ok) {
          inARow = 0;
          last = `answered ${response.status}`;
        }
      } catch (error) {
        inARow = 0;
        last = error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, inARow ? 500 : this.pollMs));
    }
    throw new CloudflareError(`Your share page is published but isn't answering yet (${last}). Try again in a minute.`);
  }

  /** A newer share page ships with Ember: republish it before sharing. */
  async #current() {
    const config = this.config;
    const secret = this.store.secret();
    if (!config || !secret) throw new CloudflareError("Set up sharing in Settings → Screen recording first.", { code: "setup" });
    if (config.version !== this.version) {
      try {
        await this.#deploy(config.accountId, config.workerId, secret);
        await this.store.save({ config: { ...config, version: this.version } });
      } catch (error) {
        console.warn("Share: couldn't update the share page:", error.message);
      }
    }
    return { config: this.config, secret };
  }

  async #api(config, secret, method, route, { body, type, signal } = {}) {
    let response;
    // A new workers.dev address can still miss on some of Cloudflare's servers for a minute: those
    // answers aren't the Worker's (not JSON), so they're tried again.
    for (let attempt = 1; ; attempt += 1) {
      response = await this.fetch(`${config.url}/api${route}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, ...(type ? { "content-type": type } : {}) },
        body,
        signal: signal || AbortSignal.timeout(10 * 60_000),
      });
      const fromWorker = (response.headers.get("content-type") || "").includes("application/json");
      if (fromWorker || attempt >= 8 || response.status < 400) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    let data = {};
    try {
      data = await response.json();
    } catch {}
    if (!response.ok) throw new CloudflareError(data.error || `Your share page answered ${response.status}.`);
    return data;
  }

  /** Uploads a video and its page; the link works (saying "Uploading…") from the start. */
  async share({ shareId = null, video, thumb = null, details, onProgress = () => {}, signal } = {}) {
    const { config, secret } = await this.#current();
    const id = shareId || newShareId();
    const call = (method, route, options) => this.#api(config, secret, method, `/shares/${id}${route}`, { ...options, signal });
    const captions = details.transcript?.length ? captionsFrom(details.transcript) : null;
    const page = { ...details, hasThumb: Boolean(thumb), hasCaptions: Boolean(captions), version: 1 };
    await call("PUT", "/files/share.json", { body: JSON.stringify({ ...page, status: "uploading" }), type: "application/json" });
    if (thumb) await call("PUT", "/files/thumb.jpg", { body: await fsp.readFile(thumb), type: "image/jpeg" });
    if (captions) await call("PUT", "/files/captions.vtt", { body: captions, type: "text/vtt" });

    const size = (await fsp.stat(video)).size;
    const { uploadId } = await call("POST", "/uploads");
    const parts = [];
    const handle = await fsp.open(video, "r");
    try {
      let sent = 0;
      for (let number = 1; sent < size; number += 1) {
        const length = Math.min(PART_SIZE, size - sent);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, sent);
        let part = null;
        for (let attempt = 1; !part; attempt += 1) {
          try {
            part = await call("PUT", `/uploads/${encodeURIComponent(uploadId)}/${number}`, { body: chunk, type: "application/octet-stream" });
          } catch (error) {
            if (attempt >= 3 || signal?.aborted) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
          }
        }
        parts.push({ partNumber: part.partNumber, etag: part.etag });
        sent += length;
        onProgress(sent / size);
      }
      await call("POST", `/uploads/${encodeURIComponent(uploadId)}/complete`, { body: JSON.stringify({ parts }), type: "application/json" });
    } catch (error) {
      await call("DELETE", `/uploads/${encodeURIComponent(uploadId)}`).catch(() => {});
      throw error;
    } finally {
      await handle.close();
    }
    await call("PUT", "/files/share.json", { body: JSON.stringify({ ...page, status: "ready" }), type: "application/json" });
    return { id, url: `${config.url}/v/${id}` };
  }

  /** New details (password, expiry, download, title…) without uploading the video again. */
  async update(shareId, details) {
    const { config, secret } = await this.#current();
    const captions = details.transcript?.length ? captionsFrom(details.transcript) : null;
    if (captions) await this.#api(config, secret, "PUT", `/shares/${shareId}/files/captions.vtt`, { body: captions, type: "text/vtt" });
    await this.#api(config, secret, "PUT", `/shares/${shareId}/files/share.json`, {
      body: JSON.stringify({ ...details, hasCaptions: Boolean(captions), version: 1, status: "ready" }),
      type: "application/json",
    });
  }

  async remove(shareId) {
    const { config, secret } = await this.#current();
    await this.#api(config, secret, "DELETE", `/shares/${shareId}`);
  }
}

module.exports = { BUCKET_NAME, CloudflareError, ShareService, ShareStore, WORKER_NAME, captionsFrom, hashPassword, newShareId, retime, workerVersion };
