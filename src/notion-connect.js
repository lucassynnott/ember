const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { SUPPORT_DIR, downloadVerified } = require("./model-manager");
const { findNtnBinary, runNtn } = require("./notion-sync");
const { CancelledError, runText } = require("./cli-run");
const { ComposioNotion } = require("./composio-notion");

// Pinned official Notion CLI release, downloaded from Notion and checked before use.
const NTN_RELEASE = {
  version: "0.23.14",
  url: "https://ntn.dev/releases/v0.23.14/ntn-aarch64-apple-darwin.tar.gz",
  sha256: "e17fed08437bac6b07ca853bbe9307615c0924e1d14666359e1a90a6b1e77864",
  size: 5511018,
};
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const SIGNED_OUT = /no workspace selected|not logged in|log in first|run `ntn login`|unauthori[sz]ed|401|invalid token|expired/i;

const DATABASE_PROPERTIES = {
  Name: { title: {} },
  Date: { date: {} },
  "Duration (min)": { number: { format: "number" } },
  Source: {
    select: {
      options: [
        { name: "Manual", color: "gray" },
        { name: "Zoom auto", color: "blue" },
      ],
    },
  },
  "Action items": { number: { format: "number" } },
  Transcription: { select: {} },
  "Summary model": { rich_text: {} },
  "Local note": { rich_text: {} },
};

function parseWhoami(text) {
  const line = text.trim().split("\n").find((candidate) => candidate.includes("\t"));
  if (!line) return null;
  const fields = line.split("\t");
  return { email: fields[3] || "", workspace: fields[5] || "", name: fields[7] || "" };
}

function parseLoginPrompt(text) {
  const url = text.match(/https:\/\/\S+cli-login\S*/)?.[0];
  const code = text.match(/verificationCode=([A-Z0-9-]+)/)?.[1] || text.match(/^\s+([A-Z0-9]{3}-[A-Z0-9]{3,})\s*$/m)?.[1];
  return url ? { url, code: code || "" } : null;
}

const NOTION_DOWN = /\b5\d\d\b|gateway|internal_server_error|service_unavailable|timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|network|rate_limited/i;

const INTEGRATION_NAME = { cli: "the Notion CLI", composio: "Composio" };

// Notion's own error text (HTTP codes, HTML pages) isn't for people; say what happened and what to do.
function friendly(error, method = "cli") {
  if (error?.cancelled) return error;
  const message = String(error?.message || error);
  if (NOTION_DOWN.test(message)) {
    const down = new Error("Notion isn't responding right now. Try again in a few minutes.");
    down.unavailable = true;
    return down;
  }
  if (/object_not_found|restricted_resource|unauthori[sz]ed/i.test(message)) {
    return new Error(`Notion couldn't find that page. Share it with ${INTEGRATION_NAME[method] || INTEGRATION_NAME.cli} in Notion, then try again.`);
  }
  return new Error(message.replace(/^Notion( CLI exited with code \d+)?:\s*(error:\s*)?/i, "").split("\n")[0]);
}

function titleOf(object) {
  if (Array.isArray(object.title)) return object.title.map((part) => part.plain_text || "").join("");
  for (const property of Object.values(object.properties || {})) {
    if (property?.type === "title") return property.title.map((part) => part.plain_text || "").join("");
  }
  return "";
}

class NotionConnect extends EventEmitter {
  constructor({
    openExternal,
    supportDir = SUPPORT_DIR,
    fetchImpl = fetch,
    release = NTN_RELEASE,
    findBinary = findNtnBinary,
    composio,
    getAuth = () => ({ method: "cli", composioAccount: "" }),
  }) {
    super();
    this.composio = composio || new ComposioNotion({ openExternal, supportDir, fetchImpl });
    this.getAuth = getAuth;
    this.openExternal = openExternal;
    this.binDir = path.join(supportDir, "bin");
    this.fetch = fetchImpl;
    this.release = release;
    this.findBinary = findBinary;
    this.job = null;
  }

  #progress(update) {
    this.progress = { ...update };
    this.emit("progress", this.progress);
  }

  async binary() {
    return this.findBinary();
  }

  // The signed-in account, or null when signed out. Throws when Notion can't be reached,
  // so an outage is never mistaken for being signed out.
  async account() {
    const binary = await this.binary();
    if (!binary) return null;
    try {
      return parseWhoami((await runText(binary, ["whoami"], { timeoutMs: 20000 })).stdout);
    } catch (error) {
      if (SIGNED_OUT.test(error.message)) return null;
      const unavailable = new Error("Notion isn't responding right now. Try again in a few minutes.");
      unavailable.unavailable = true;
      throw unavailable;
    }
  }

  method() {
    return this.getAuth().method === "composio" ? "composio" : "cli";
  }

  async status(dataSourceId, savedName = "") {
    const method = this.method();
    const binary = method === "composio" ? await this.composio.binary() : await this.binary();
    let account = null;
    let unavailable = false;
    try {
      account = !binary ? null : method === "composio" ? await this.composio.account(this.getAuth().composioAccount) : await this.account();
    } catch (error) {
      if (!error.unavailable) throw error;
      unavailable = true;
    }
    let database = null;
    if (account && dataSourceId && savedName) {
      database = { id: dataSourceId, name: savedName, url: null };
    } else if (account && dataSourceId) {
      try {
        const source = await this.request("GET", `v1/data_sources/${dataSourceId}`, undefined, 30000);
        const databaseId = source.parent?.database_id || source.database_parent?.database_id || "";
        database = {
          id: dataSourceId,
          name: titleOf(source) || "Untitled database",
          url: databaseId ? `https://app.notion.com/p/${databaseId.replace(/-/g, "")}` : null,
        };
      } catch (error) {
        database = { id: dataSourceId, name: null, error: "Notion isn't responding right now." };
        console.error("Notion database lookup failed:", error.message);
      }
    }
    return {
      method,
      installed: Boolean(binary),
      account,
      unavailable,
      database,
      busy: Boolean(this.job),
      progress: this.job ? this.progress : null,
    };
  }

  cancel() {
    if (!this.job) return false;
    this.job.controller.abort();
    this.job.child?.kill("SIGTERM");
    return true;
  }

  // Installs the chosen CLI if needed, then signs in through the browser. Resolves with the account.
  connect(method = "cli") {
    if (this.job) return this.job.promise;
    const job = { controller: new AbortController(), child: null, method };
    this.job = job;
    job.promise = (async () => {
      try {
        let account;
        if (method === "composio") {
          account = await this.composio.connect(job, (update) => this.#progress(update), this.getAuth().composioAccount);
        } else {
          let binary = await this.binary();
          if (!binary) binary = await this.#install(job);
          account = await this.account();
          if (!account) account = await this.#login(binary, job);
        }
        this.#progress({ state: "connected", message: `Connected as ${account.name || account.email}` });
        return account;
      } catch (caught) {
        const error = friendly(caught, method);
        const cancelled = error.cancelled || job.controller.signal.aborted;
        this.#progress({ state: cancelled ? "cancelled" : "failed", message: cancelled ? "Cancelled" : error.message });
        if (cancelled) return null;
        throw error;
      } finally {
        this.job = null;
        this.emit("changed");
      }
    })();
    return job.promise;
  }

  async #install(job) {
    await fsp.mkdir(this.binDir, { recursive: true });
    const archive = path.join(this.binDir, "ntn.tar.gz");
    this.#progress({ state: "downloading", received: 0, total: this.release.size, fraction: 0, message: "Downloading the Notion CLI…" });
    try {
      let lastEmit = 0;
      await downloadVerified({
        url: this.release.url,
        destination: archive,
        expectedSize: this.release.size,
        sha256: this.release.sha256,
        signal: job.controller.signal,
        fetchImpl: this.fetch,
        onBytes: (received) => {
          const now = Date.now();
          if (now - lastEmit < 100 && received < this.release.size) return;
          lastEmit = now;
          this.#progress({
            state: "downloading",
            received,
            total: this.release.size,
            fraction: Math.min(received / this.release.size, 1),
            message: "Downloading the Notion CLI…",
          });
        },
      });
    } catch (error) {
      if (error.name === "AbortError" || job.controller.signal.aborted) throw new CancelledError();
      throw error;
    }
    this.#progress({ state: "installing", fraction: 1, message: "Installing…" });
    const staging = path.join(this.binDir, "ntn-staging");
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    await runText("/usr/bin/tar", ["-xzf", archive, "-C", staging, "--strip-components", "1"]);
    const target = path.join(this.binDir, "ntn");
    await fsp.rename(path.join(staging, "ntn"), target);
    await fsp.chmod(target, 0o755);
    await Promise.all([fsp.rm(staging, { recursive: true, force: true }), fsp.rm(archive, { force: true })]);
    return target;
  }

  async #login(binary, job) {
    this.#progress({ state: "starting-login", message: "Opening Notion in your browser…" });
    // Without a terminal, ntn prints a login URL and code and exits; `ntn login poll` then waits.
    const { stdout, stderr } = await runText(binary, ["login"], { timeoutMs: 30000, onChild: (child) => (job.child = child) });
    const prompt = parseLoginPrompt(`${stdout}\n${stderr}`);
    if (!prompt) throw new Error("Notion didn't return a login link. Try again in a moment.");
    if (job.controller.signal.aborted) throw new CancelledError();
    await this.openExternal(prompt.url);
    this.#progress({ state: "waiting", url: prompt.url, code: prompt.code, message: "Finish signing in in your browser." });
    try {
      await runText(binary, ["login", "poll"], { timeoutMs: LOGIN_TIMEOUT_MS, onChild: (child) => (job.child = child) });
    } catch (error) {
      if (job.controller.signal.aborted) throw new CancelledError();
      if (error.signal === "SIGKILL") throw new Error("The sign-in timed out. Try connecting again.");
      throw error;
    }
    const account = await this.account();
    if (!account) throw new Error("Signed in, but Notion didn't confirm the account. Try again.");
    return account;
  }

  // Calls the Notion API with whichever sign-in is in use: the Notion CLI or Composio's proxy.
  async request(method, apiPath, body, timeoutMs = 180000) {
    if (this.method() === "composio") {
      const binary = await this.composio.binary();
      if (!binary) throw new Error("Connect Notion first.");
      return this.composio.request(binary, this.getAuth().composioAccount, method, apiPath, body, timeoutMs);
    }
    const binary = await this.binary();
    if (!binary) throw new Error("Connect Notion first.");
    const args = ["api", apiPath];
    if (method !== "GET") args.push("-X", method);
    if (body !== undefined) args.push("-d", "@-");
    return runNtn(binary, args, body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), timeoutMs);
  }

  // Uploads an image for a page (slides shared during a call). Composio's proxy only sends JSON,
  // so with a Composio sign-in the slides stay as text.
  async uploadImage(file) {
    if (this.method() === "composio") return null;
    const binary = await this.binary();
    if (!binary) return null;
    const bytes = await require("node:fs/promises").readFile(file);
    const upload = await runNtn(
      binary,
      ["files", "create", "--filename", require("node:path").basename(file), "--content-type", "image/jpeg", "--json"],
      bytes,
      120000,
    );
    return upload?.status === "uploaded" ? upload.id : null;
  }

  // Pages the connection can see (to create the database in) and existing databases (to reuse).
  async search(query = "") {
    const request = (object) =>
      this.request(
        "POST",
        "v1/search",
        {
          query,
          page_size: 50,
          filter: { property: "object", value: object },
          sort: { direction: "descending", timestamp: "last_edited_time" },
        },
        60000,
      );
    // Notion's search API can fail intermittently; retry briefly before reporting it.
    let pages;
    let sources;
    for (let attempt = 0; ; attempt += 1) {
      try {
        [pages, sources] = await Promise.all([request("page"), request("data_source")]);
        break;
      } catch (error) {
        const reported = friendly(error, this.method());
        if (!reported.unavailable || attempt >= 2) throw reported;
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
    return {
      pages: (pages.results || [])
        .filter((page) => !["data_source_id", "database_id"].includes(page.parent?.type) && !page.in_trash && !page.archived)
        .map((page) => ({ id: page.id, title: titleOf(page) || "Untitled", url: page.url })),
      databases: (sources.results || [])
        .filter((source) => !source.in_trash && !source.archived)
        .map((source) => ({ id: source.id, title: titleOf(source) || "Untitled database" })),
    };
  }

  async createDatabase(parentPageId) {
    const database = await this.request(
      "POST",
      "v1/databases",
      {
        parent: { type: "page_id", page_id: parentPageId },
        icon: { type: "emoji", emoji: "🎙️" },
        title: [{ type: "text", text: { content: "Call Transcripts" } }],
        description: [{ type: "text", text: { content: "Saved automatically by the Ember app after each recorded call." } }],
        initial_data_source: { properties: DATABASE_PROPERTIES },
      },
      60000,
    ).catch((error) => {
      throw friendly(error, this.method());
    });
    const source = database.data_sources?.[0];
    if (!source?.id) throw new Error("Notion created the database but didn't return its data source.");
    return { id: source.id, name: "Call Transcripts", url: database.url };
  }
}

module.exports = { NTN_RELEASE, NotionConnect, friendly, parseLoginPrompt, parseWhoami };
