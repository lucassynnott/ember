// Ember Drive: your cloud storage as a drive in Finder (it replaces Ghost). The drive itself is an FSKit extension
// inside the "Ember Drive" helper app (native/drive). Ember opens the helper as its own app (macOS only lets the
// helper itself into its shared settings folder) and talks to it over a local socket, one JSON object per line. The
// helper also hosts the Finder right-click actions, offline files, trash clean-up and search, and keeps running
// when Ember quits.
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const DRIVE_BUCKET = "ember-drive";
// macOS 26 (Darwin 25) is where FSKit can mount network-style drives.
const MIN_DARWIN = 25;
const SOCKET = path.join(os.homedir(), "Library", "Application Support", "Ember Drive", "ember.sock");

function run(file, args) {
  return new Promise((resolve) => execFile(file, args, { timeout: 30_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || "") })));
}

class DriveService {
  /**
   * @param helperApp path to "Ember Drive.app"
   * @param onStatus (status) => void, whenever the drive's state changes
   * @param onEvent (name, data) => void, for the helper's other news (search requests, shares from Finder, test progress)
   */
  /**
   * @param bundle the zip of "Ember Drive.app" that Ember ships ({ zip, version }), installed to helperApp when its
   *   version changes. Without it (development), helperApp is used where it is.
   */
  constructor({ helperApp, bundle = null, onStatus = () => {}, onEvent = () => {}, cleanStrays = false }) {
    Object.assign(this, { helperApp, bundle, onStatus, onEvent, cleanStrays });
    this.socket = null;
    this.stopped = false;
    this.next = 0;
    this.waiting = new Map();
    this.status = { supported: DriveService.supported(bundle?.zip || helperApp), configured: false, mounted: false };
  }

  static supported(helperApp) {
    return process.platform === "darwin" && Number.parseInt(os.release(), 10) >= MIN_DARWIN && fs.existsSync(helperApp);
  }

  get binary() {
    return path.join(this.helperApp, "Contents", "MacOS", "Ember Drive");
  }

  /** Registers the helper and its extension with macOS (only this copy), opens it, and connects. */
  async start() {
    if (!this.status.supported || this.socket) return;
    this.stopped = false;
    await this.#install();
    await this.#register();
    await this.#open();
    // An older helper (from before Ember updated) is asked to quit and the new one opened in its place.
    const identity = await this.request("identity").catch(() => null);
    const binaryTime = Math.floor(fs.statSync(this.binary).mtimeMs / 1000);
    if (identity && (path.resolve(identity.path) !== path.resolve(this.helperApp) || Math.floor(identity.modified) !== binaryTime)) {
      await this.request("quit").catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await this.#open();
    }
  }

  async #open() {
    await run("/usr/bin/open", ["-g", "-j", this.helperApp]);
    for (let attempt = 0; attempt < 60 && !this.socket; attempt += 1) {
      await this.#connect().catch(() => new Promise((resolve) => setTimeout(resolve, 500)));
    }
    if (!this.socket) throw new Error("Ember Drive didn't start.");
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        this.socket = socket;
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            this.#receive(line);
          }
        });
        socket.on("error", () => {});
        socket.on("close", () => {
          if (this.socket === socket) this.socket = null;
          for (const waiter of this.waiting.values()) waiter.reject(new Error("Ember Drive stopped."));
          this.waiting.clear();
          // The helper restarted (or was updated): reconnect.
          if (!this.stopped) setTimeout(() => void this.#open().catch((error) => console.warn("Ember Drive:", error.message)), 2000);
        });
        resolve();
      });
    });
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.event === "status") {
      this.status = { ...message.data, supported: true };
      this.onStatus(this.status);
    } else if (message.event) this.onEvent(message.event, message.data);
    else {
      const waiter = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (waiter) message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error || "Ember Drive couldn't do that."));
    }
  }

  /** Ember is quitting: it lets go of the helper, which keeps the drive's Finder actions and offline files going. */
  stop() {
    this.stopped = true;
    this.socket?.end();
    this.socket = null;
  }

  /**
   * Puts the shipped helper in place when it's new or changed. It lives outside Ember.app because macOS switches a
   * drive off whenever the copy it knows is removed, which replacing Ember.app on every update would do.
   */
  async #install() {
    if (!this.bundle) return;
    const wanted = (await fsp.readFile(this.bundle.version, "utf8").catch(() => "")).trim();
    const versionFile = path.join(path.dirname(this.helperApp), "EmberDrive.version");
    const installed = (await fsp.readFile(versionFile, "utf8").catch(() => "")).trim();
    if (wanted && installed === wanted && fs.existsSync(this.binary)) return;
    // A running helper (an older one) is asked to quit first.
    await new Promise((resolve) => {
      const socket = net.createConnection(SOCKET);
      const done = () => (socket.destroy(), resolve());
      socket.once("error", done);
      socket.once("connect", () => socket.write(`${JSON.stringify({ id: 0, cmd: "quit" })}\n`, () => setTimeout(done, 1500)));
      setTimeout(done, 3000);
    });
    const staging = path.join(path.dirname(this.helperApp), `.install-${process.pid}`);
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    const unzip = await run("/usr/bin/ditto", ["-x", "-k", this.bundle.zip, staging]);
    if (!unzip.ok || !fs.existsSync(path.join(staging, "Ember Drive.app"))) throw new Error("Couldn't install Ember Drive.");
    await fsp.rm(this.helperApp, { recursive: true, force: true });
    await fsp.rename(path.join(staging, "Ember Drive.app"), this.helperApp);
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.writeFile(versionFile, wanted);
  }

  async #register() {
    await run(LSREGISTER, ["-f", "-R", "-trusted", this.helperApp]);
    await run("/usr/bin/pluginkit", ["-a", path.join(this.helperApp, "Contents", "Extensions", "EmberDriveFS.appex")]);
    // Unregistering another copy of the extension makes macOS switch Ember Drive off as a file system, so installed
    // apps leave other copies alone; only development runs clear out their own build copies.
    if (!this.cleanStrays) return;
    const dump = await run(LSREGISTER, ["-dump"]);
    const strays = new Set();
    for (const line of dump.stdout.split("\n")) {
      const match = /^path:\s+(.*(?:Ember Drive\.app|EmberDriveFS\.appex))(?: \(0x[0-9a-f]+\))?$/.exec(line);
      if (match && !match[1].startsWith(this.helperApp)) strays.add(match[1]);
    }
    for (const stray of strays) await run(LSREGISTER, ["-u", stray]);
  }

  request(cmd, args = {}, timeoutMs = 120_000) {
    if (!this.socket) return Promise.reject(new Error(this.status.supported ? "Ember Drive isn't running." : "Ember Drive needs macOS 26 or later."));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("Ember Drive didn't answer."));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.socket.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  /** Where the drive is mounted right now, or null. */
  get mountPath() {
    return this.status.mounted ? this.status.path : null;
  }

  /**
   * One click with the Cloudflare account Ember already shares through: an "ember-drive" R2 bucket and a key that
   * can only read and write its files, then the drive is tested, saved and mounted.
   * @param cloudflare (method, path, body) => Cloudflare's JSON answer, through Composio
   */
  async setUpWithCloudflare(cloudflare, onStep = () => {}, { dryRun = false } = {}) {
    const cf = async (method, apiPath, body) => {
      const answer = await cloudflare(method, apiPath, body);
      if (answer && answer.success === false) throw new Error(answer.errors?.[0]?.message || "Cloudflare refused that.");
      return answer?.result;
    };
    onStep("Finding your Cloudflare account…");
    const accounts = (await cf("GET", "/accounts")) || [];
    if (!accounts.length) throw new Error("This Cloudflare login has no accounts.");
    const account = accounts[0];
    onStep("Making storage for your drive…");
    const buckets = (await cf("GET", `/accounts/${account.id}/r2/buckets`))?.buckets || [];
    if (!buckets.some((bucket) => bucket.name === DRIVE_BUCKET)) await cf("POST", `/accounts/${account.id}/r2/buckets`, { name: DRIVE_BUCKET });
    onStep("Making a key that can only use that storage…");
    const groups = (await cf("GET", `/accounts/${account.id}/tokens/permission_groups`)) || [];
    const wanted = groups.filter((group) => ["Workers R2 Storage Bucket Item Write", "Workers R2 Storage Bucket Item Read"].includes(group.name));
    if (wanted.length < 2) throw new Error("Cloudflare didn't offer R2 storage keys for this account.");
    const token = await cf("POST", `/accounts/${account.id}/tokens`, {
      name: "ember-drive",
      policies: [
        {
          effect: "allow",
          resources: { [`com.cloudflare.edge.r2.bucket.${account.id}_default_${DRIVE_BUCKET}`]: "*" },
          permission_groups: wanted.map((group) => ({ id: group.id, name: group.name })),
        },
      ],
    });
    if (!token?.id || !token?.value) throw new Error("Cloudflare didn't return the storage key.");
    // R2's S3 keys are the token's ID and the SHA-256 of its value.
    const config = {
      provider: "r2",
      accountID: account.id,
      keyID: token.id,
      applicationKey: crypto.createHash("sha256").update(token.value).digest("hex"),
      bucketName: DRIVE_BUCKET,
    };
    onStep("Checking it works…");
    // A new key can take a few seconds to reach R2.
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 5000));
      ok = await this.request("test", { config }, 180_000).catch(() => false);
    }
    if (!ok) throw new Error("The storage was made, but the connection test didn't pass. Try again in a minute.");
    // A dry run checks everything works without switching the drive over.
    if (dryRun) return { bucket: DRIVE_BUCKET, account: account.name || "", tested: true };
    onStep("Mounting Ember Drive…");
    await this.request("save", { config });
    return { bucket: DRIVE_BUCKET, account: account.name || "" };
  }

  /* Ember on the drive: recordings and notes kept in an "Ember" folder. */

  /** Copies a file onto the drive (it uploads in the background, like any file put there). */
  async backUp(file, relative) {
    const root = this.mountPath;
    if (!root || !fs.existsSync(file)) return false;
    const target = path.join(root, "Ember", relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const [from, to] = await Promise.all([fsp.stat(file), fsp.stat(target).catch(() => null)]);
    if (to && to.size === from.size && to.mtimeMs >= from.mtimeMs) return false;
    await fsp.copyFile(file, target);
    return true;
  }
}

/** A name that works as a folder or file name on any drive. */
function safeName(text) {
  return (
    String(text || "Untitled")
      .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Untitled"
  );
}

module.exports = { DriveService, safeName, DRIVE_BUCKET };
