const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { SUPPORT_DIR, downloadVerified } = require("./model-manager");
const { findNtnBinary, runNtn } = require("./notion-sync");

// Pinned official Notion CLI release, downloaded from Notion and checked before use.
const NTN_RELEASE = {
  version: "0.23.13",
  url: "https://ntn.dev/releases/v0.23.13/ntn-aarch64-apple-darwin.tar.gz",
  sha256: "de5649154a8589cad4ea932e8bbb8b173ecbe50e726155e3a7aefffa0665c572",
  size: 5393031,
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

class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.cancelled = true;
  }
}

// Runs ntn with stdin closed (it waits on an open pipe) and returns its text output.
function runText(binary, args, { timeoutMs = 60000, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error((stderr || stdout).trim().split("\n")[0] || `ntn exited with ${code ?? signal}`);
        error.code = code;
        error.signal = signal;
        reject(error);
      }
    });
  });
}

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

// Notion's own error text (HTTP codes, HTML pages) isn't for people; say what happened and what to do.
function friendly(error) {
  if (error?.cancelled) return error;
  const message = String(error?.message || error);
  if (NOTION_DOWN.test(message)) {
    const down = new Error("Notion isn't responding right now. Try again in a few minutes.");
    down.unavailable = true;
    return down;
  }
  if (/object_not_found|restricted_resource|unauthori[sz]ed/i.test(message)) {
    return new Error("Notion couldn't find that page. Share it with the Notion CLI in Notion, then try again.");
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
  constructor({ openExternal, supportDir = SUPPORT_DIR, fetchImpl = fetch, release = NTN_RELEASE, findBinary = findNtnBinary }) {
    super();
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

  async status(dataSourceId, savedName = "") {
    const binary = await this.binary();
    let account = null;
    let unavailable = false;
    try {
      account = binary ? await this.account() : null;
    } catch (error) {
      if (!error.unavailable) throw error;
      unavailable = true;
    }
    let database = null;
    if (account && dataSourceId && savedName) {
      database = { id: dataSourceId, name: savedName, url: null };
    } else if (account && dataSourceId) {
      try {
        const source = await runNtn(binary, ["api", `v1/data_sources/${dataSourceId}`], "", 20000);
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
    return { installed: Boolean(binary), account, unavailable, database, busy: Boolean(this.job), progress: this.job ? this.progress : null };
  }

  cancel() {
    if (!this.job) return false;
    this.job.controller.abort();
    this.job.child?.kill("SIGTERM");
    return true;
  }

  // Installs the Notion CLI if needed, then signs in through the browser. Resolves with the account.
  connect() {
    if (this.job) return this.job.promise;
    const job = { controller: new AbortController(), child: null };
    this.job = job;
    job.promise = (async () => {
      try {
        let binary = await this.binary();
        if (!binary) binary = await this.#install(job);
        let account = await this.account();
        if (!account) account = await this.#login(binary, job);
        this.#progress({ state: "connected", message: `Connected as ${account.name || account.email}` });
        return account;
      } catch (caught) {
        const error = friendly(caught);
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

  // Pages the connection can see (to create the database in) and existing databases (to reuse).
  async search(query = "") {
    const binary = await this.binary();
    if (!binary) throw new Error("Connect Notion first.");
    const request = (object) =>
      runNtn(
        binary,
        ["api", "v1/search", "-X", "POST", "-d", "@-"],
        JSON.stringify({
          query,
          page_size: 50,
          filter: { property: "object", value: object },
          sort: { direction: "descending", timestamp: "last_edited_time" },
        }),
        30000,
      );
    // Notion's search API can fail intermittently; retry briefly before reporting it.
    let pages;
    let sources;
    for (let attempt = 0; ; attempt += 1) {
      try {
        [pages, sources] = await Promise.all([request("page"), request("data_source")]);
        break;
      } catch (error) {
        const reported = friendly(error);
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
    const binary = await this.binary();
    if (!binary) throw new Error("Connect Notion first.");
    const database = await runNtn(
      binary,
      ["api", "v1/databases", "-X", "POST", "-d", "@-"],
      JSON.stringify({
        parent: { type: "page_id", page_id: parentPageId },
        icon: { type: "emoji", emoji: "🎙️" },
        title: [{ type: "text", text: { content: "Call Transcripts" } }],
        description: [{ type: "text", text: { content: "Saved automatically by the Meeting Notes app after each recorded call." } }],
        initial_data_source: { properties: DATABASE_PROPERTIES },
      }),
      60000,
    ).catch((error) => {
      throw friendly(error);
    });
    const source = database.data_sources?.[0];
    if (!source?.id) throw new Error("Notion created the database but didn't return its data source.");
    return { id: source.id, name: "Call Transcripts", url: database.url };
  }
}

module.exports = { NTN_RELEASE, NotionConnect, friendly, parseLoginPrompt, parseWhoami };
