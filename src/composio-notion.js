const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SUPPORT_DIR, downloadVerified } = require("./model-manager");
const { CancelledError, runText } = require("./cli-run");

// Pinned official Composio CLI release from GitHub, checked against its published SHA-256.
const COMPOSIO_RELEASE = {
  version: "0.4.2",
  url: "https://github.com/ComposioHQ/composio/releases/download/%40composio/cli%400.4.2/composio-darwin-aarch64.zip",
  sha256: "e1541acd9cf883f1e530f39c501f31319161d1699ed43b0f16b299f6e7d4a729",
  size: 114269358,
};
const NOTION_VERSION = "2026-03-11";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LINK_POLL_MS = 2500;
const QUIET_ENV = { COMPOSIO_DISABLE_TELEMETRY: "true", DO_NOT_TRACK: "1", NO_COLOR: "1" };
const UNREACHABLE = /ECONN|ENOTFOUND|EAI_AGAIN|network|timed out|timeout|fetch failed|\b5\d\d\b/i;

function composioCandidates(supportDir) {
  return [
    process.env.COMPOSIO_BIN,
    path.join(os.homedir(), ".composio", "composio"),
    path.join(os.homedir(), ".local", "bin", "composio"),
    "/opt/homebrew/bin/composio",
    "/usr/local/bin/composio",
    path.join(supportDir, "composio", "composio"),
  ].filter(Boolean);
}

async function findComposioBinary(supportDir = SUPPORT_DIR) {
  for (const candidate of composioCandidates(supportDir)) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function parseJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function parseComposioLogin(text) {
  return text.match(/https:\/\/\S*composio\.dev\/\S*cliKey=[\w-]+/)?.[0] || null;
}

// Notion through Composio: Composio holds the Notion OAuth connection and proxies API calls with it.
class ComposioNotion {
  constructor({ openExternal, supportDir = SUPPORT_DIR, fetchImpl = fetch, release = COMPOSIO_RELEASE, findBinary, pollMs = LINK_POLL_MS }) {
    this.openExternal = openExternal;
    this.installDir = path.join(supportDir, "composio");
    this.fetch = fetchImpl;
    this.release = release;
    this.findBinary = findBinary || (() => findComposioBinary(supportDir));
    this.pollMs = pollMs;
    this.profiles = new Map();
  }

  binary() {
    return this.findBinary();
  }

  #run(binary, args, options = {}) {
    return runText(binary, args, { timeoutMs: 30000, ...options, env: QUIET_ENV });
  }

  // Composio's connected Notion accounts, or null when the CLI isn't signed in.
  async connections(binary) {
    let result;
    try {
      result = await this.#run(binary, ["link", "notion", "--list"]);
    } catch (error) {
      if (UNREACHABLE.test(`${error.message} ${error.stderr || ""}`)) {
        const unavailable = new Error("Composio isn't responding right now. Try again in a few minutes.");
        unavailable.unavailable = true;
        throw unavailable;
      }
      return null;
    }
    const list = parseJson(result.stdout);
    return list ? list.items || [] : null;
  }

  async signedIn(binary) {
    const { stdout } = await this.#run(binary, ["whoami"]).catch(() => ({ stdout: "" }));
    return parseJson(stdout)?.email ? parseJson(stdout) : null;
  }

  // Name and workspace of the Notion account behind a Composio connection (cached; it takes a few seconds).
  async profile(binary, accountId) {
    if (this.profiles.has(accountId)) return this.profiles.get(accountId);
    const me = await this.request(binary, accountId, "GET", "v1/users/me", undefined, 30000);
    const profile = {
      name: me.bot?.owner?.user?.name || me.name || "",
      email: me.bot?.owner?.user?.person?.email || "",
      workspace: me.bot?.workspace_name || "",
    };
    this.profiles.set(accountId, profile);
    return profile;
  }

  // The active connection to use: the saved one if it's still active, else the newest active one.
  async activeConnection(binary, preferredId) {
    const items = await this.connections(binary);
    if (!items) return null;
    const active = items.filter((item) => item.status === "ACTIVE" && !item.is_disabled);
    return active.find((item) => item.word_id === preferredId || item.id === preferredId) || active[0] || null;
  }

  async account(preferredId) {
    const binary = await this.binary();
    if (!binary) return null;
    const connection = await this.activeConnection(binary, preferredId);
    if (!connection) return null;
    const profile = await this.profile(binary, connection.word_id).catch(() => ({ name: "", email: "", workspace: "" }));
    return { ...profile, accountId: connection.word_id };
  }

  // Calls the Notion API through Composio's proxy with the connected account.
  async request(binary, accountId, method, apiPath, body, timeoutMs = 120000) {
    const args = ["proxy", `https://api.notion.com/${apiPath}`, "--toolkit", "notion", "-X", method, "-H", `Notion-Version: ${NOTION_VERSION}`];
    if (accountId) args.push("--account", accountId);
    if (body !== undefined) args.push("-H", "Content-Type: application/json", "-d", "-");
    const { stdout, stderr } = await this.#run(binary, args, {
      timeoutMs,
      input: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }).catch((error) => {
      throw new Error(`Notion: ${(error.stderr || error.message).replace(/\u001b\[[0-9;]*m/g, "").trim().split("\n").find(Boolean) || error.message}`);
    });
    const response = parseJson(stdout);
    if (!response) throw new Error(`Notion: ${(stderr || stdout).trim().slice(0, 300) || "no response from Composio"}`);
    if (response.object === "error") throw new Error(`Notion: ${response.code}: ${response.message}`);
    return response;
  }

  // Installs the Composio CLI if needed, signs in to Composio, then links Notion. Resolves with the account.
  async connect(job, progress, preferredId) {
    let binary = await this.binary();
    if (!binary) binary = await this.#install(job, progress);
    if (!(await this.signedIn(binary))) await this.#login(binary, job, progress);
    let connection = await this.activeConnection(binary, preferredId);
    if (!connection) connection = await this.#link(binary, job, progress);
    const account = await this.account(connection.word_id);
    if (!account) throw new Error("Composio linked Notion but didn't confirm the account. Try again.");
    return account;
  }

  async #install(job, progress) {
    const parent = path.dirname(this.installDir);
    await fsp.mkdir(parent, { recursive: true });
    const archive = path.join(parent, "composio.zip");
    const total = this.release.size;
    progress({ state: "downloading", received: 0, total, fraction: 0, message: "Downloading the Composio CLI…" });
    try {
      let lastEmit = 0;
      await downloadVerified({
        url: this.release.url,
        destination: archive,
        expectedSize: total,
        sha256: this.release.sha256,
        signal: job.controller.signal,
        fetchImpl: this.fetch,
        onBytes: (received) => {
          const now = Date.now();
          if (now - lastEmit < 100 && received < total) return;
          lastEmit = now;
          progress({ state: "downloading", received, total, fraction: Math.min(received / total, 1), message: "Downloading the Composio CLI…" });
        },
      });
    } catch (error) {
      if (error.name === "AbortError" || job.controller.signal.aborted) throw new CancelledError();
      throw error;
    }
    progress({ state: "installing", fraction: 1, message: "Installing…" });
    const staging = `${this.installDir}-staging`;
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    await runText("/usr/bin/ditto", ["-x", "-k", archive, staging], { timeoutMs: 120000 });
    // Releases unpack either into composio-<target>/ or straight into the folder.
    const nested = (await fsp.readdir(staging)).find((name) => name.startsWith("composio-"));
    const bundle = nested && fs.existsSync(path.join(staging, nested, "composio")) ? path.join(staging, nested) : staging;
    if (!fs.existsSync(path.join(bundle, "composio"))) throw new Error("The Composio download didn't contain the CLI.");
    await fsp.rm(this.installDir, { recursive: true, force: true });
    await fsp.rename(bundle, this.installDir);
    await fsp.chmod(path.join(this.installDir, "composio"), 0o755);
    await Promise.all([fsp.rm(staging, { recursive: true, force: true }), fsp.rm(archive, { force: true })]);
    return path.join(this.installDir, "composio");
  }

  async #login(binary, job, progress) {
    progress({ state: "starting-login", message: "Opening Composio in your browser…" });
    // --no-wait prints the sign-in link and exits; --poll then waits for the browser step to finish.
    const { stdout, stderr } = await this.#run(binary, ["login", "--no-wait", "--no-browser", "--no-skill-install", "-y"], {
      onChild: (child) => (job.child = child),
    });
    const url = parseComposioLogin(`${stdout}\n${stderr}`);
    if (!url) throw new Error("Composio didn't return a sign-in link. Try again in a moment.");
    if (job.controller.signal.aborted) throw new CancelledError();
    await this.openExternal(url);
    progress({ state: "waiting", step: "composio", url, message: "Sign in to Composio in your browser." });
    try {
      await this.#run(binary, ["login", "--poll", "--no-skill-install", "-y"], {
        timeoutMs: LOGIN_TIMEOUT_MS,
        onChild: (child) => (job.child = child),
      });
    } catch (error) {
      if (job.controller.signal.aborted) throw new CancelledError();
      if (error.signal === "SIGKILL") throw new Error("The sign-in timed out. Try connecting again.");
      throw error;
    }
    if (!(await this.signedIn(binary))) throw new Error("Composio didn't confirm the sign-in. Try again.");
  }

  async #link(binary, job, progress) {
    const before = new Set(((await this.connections(binary)) || []).filter((item) => item.status === "ACTIVE").map((item) => item.id));
    progress({ state: "starting-login", message: "Opening Notion in your browser…" });
    const { stdout } = await this.#run(binary, ["link", "notion", "--no-wait", "--no-browser"], {
      onChild: (child) => (job.child = child),
    });
    const link = parseJson(stdout);
    if (!link?.redirect_url) throw new Error("Composio didn't return a Notion link. Try again in a moment.");
    if (job.controller.signal.aborted) throw new CancelledError();
    await this.openExternal(link.redirect_url);
    progress({ state: "waiting", step: "notion", url: link.redirect_url, message: "Allow access to Notion in your browser." });
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      if (job.controller.signal.aborted) throw new CancelledError();
      const items = (await this.connections(binary).catch(() => null)) || [];
      const created = items.find((item) => item.id === link.connected_account_id);
      if (created?.status === "ACTIVE") return created;
      const fresh = items.find((item) => item.status === "ACTIVE" && !before.has(item.id));
      if (fresh) return fresh;
      if (created && /FAILED|EXPIRED/.test(created.status)) throw new Error("Notion didn't finish connecting. Try again.");
    }
    throw new Error("The sign-in timed out. Try connecting again.");
  }
}

module.exports = { COMPOSIO_RELEASE, NOTION_VERSION, ComposioNotion, findComposioBinary, parseComposioLogin };
