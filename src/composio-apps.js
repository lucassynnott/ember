// Connects Linear, Notion and Google Drive through Composio, two ways:
// - hosted (default): through Meeting Notes' relay (server/composio-relay), so users don't need a
//   Composio account. Each install has a random secret; the relay derives the user from it.
// - personal: through the user's own Composio account, with the Composio CLI.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Set once the relay is deployed; MEETING_NOTES_RELAY_URL overrides it for testing.
const HOSTED_RELAY_URL = "https://meeting-notes-composio.lucassynnott.workers.dev";
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2500;

const TOOLKIT_LABELS = { linear: "Linear", notion: "Notion", googledrive: "Google Drive" };

/** The install's relay secret, created once and stored encrypted. */
class InstallSecret {
  constructor({ filePath, encrypt, decrypt }) {
    Object.assign(this, { filePath, encrypt, decrypt });
    this.value = null;
  }

  async get() {
    if (this.value) return this.value;
    try {
      this.value = this.decrypt(JSON.parse(await fs.readFile(this.filePath, "utf8")).secret);
    } catch {
      this.value = crypto.randomBytes(32).toString("hex");
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.filePath, JSON.stringify({ secret: this.encrypt(this.value) }), { mode: 0o600 });
    }
    return this.value;
  }
}

class HostedComposio {
  constructor({ baseUrl = process.env.MEETING_NOTES_RELAY_URL || HOSTED_RELAY_URL, secret, openExternal, fetchImpl = globalThis.fetch, pollMs = POLL_MS }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ""), secret, openExternal, fetch: fetchImpl, pollMs });
  }

  async #call(method, route, body) {
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      method,
      headers: { authorization: `Bearer ${await this.secret.get()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {}
    if (!response.ok) throw new Error(data.error || `Meeting Notes' connection service answered ${response.status}.`);
    return data;
  }

  async connections() {
    return (await this.#call("GET", "/v1/connections")).connections || [];
  }

  /** Opens the app's sign-in in the browser and waits until the connection is active. */
  async connect(toolkit, { signal, onWaiting = () => {} } = {}) {
    const { redirectUrl, connectionId } = await this.#call("POST", "/v1/connect", { toolkit });
    if (!/^https:\/\//.test(redirectUrl || "")) throw new Error("The sign-in link didn't look right.");
    await this.openExternal(redirectUrl);
    onWaiting(redirectUrl);
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      if (signal?.aborted) throw new Error("Cancelled.");
      const connection = (await this.connections().catch(() => [])).find((item) => item.id === connectionId);
      if (connection?.status === "ACTIVE") return { id: connection.id, toolkit };
      if (connection && /FAILED|EXPIRED/.test(connection.status)) throw new Error(`${TOOLKIT_LABELS[toolkit] || toolkit} didn't finish connecting. Try again.`);
    }
    throw new Error("The sign-in timed out. Try connecting again.");
  }

  async disconnect(id) {
    await this.#call("DELETE", `/v1/connections/${encodeURIComponent(id)}`);
  }

  async execute(tool, args, connectionId) {
    return this.#call("POST", "/v1/execute", { tool, arguments: args, connectionId });
  }
}

class PersonalComposio {
  constructor({ cli }) {
    this.cli = cli;
  }

  async connections() {
    const binary = await this.cli.binary();
    if (!binary) return [];
    const lists = await Promise.all(
      Object.keys(TOOLKIT_LABELS).map(async (toolkit) =>
        ((await this.cli.connections(binary, toolkit).catch(() => null)) || []).map((item) => ({ id: item.word_id || item.id, toolkit, status: item.status })),
      ),
    );
    return lists.flat();
  }

  async connect(toolkit, { job, progress = () => {} } = {}) {
    const work = job || { controller: new AbortController() };
    const binary = await this.cli.prepare(work, progress);
    const existing = ((await this.cli.connections(binary, toolkit)) || []).find((item) => item.status === "ACTIVE");
    const connection = existing || (await this.cli.link(binary, work, progress, toolkit, TOOLKIT_LABELS[toolkit] || toolkit));
    return { id: connection.word_id || connection.id, toolkit };
  }

  async disconnect() {
    // The connection stays in your Composio account; Meeting Notes just stops using it.
  }

  async execute(tool, args, connectionId) {
    const binary = await this.cli.binary();
    if (!binary) throw new Error("Connect your Composio account in Settings first.");
    return this.cli.execute(binary, tool, args, connectionId);
  }
}

module.exports = { HOSTED_RELAY_URL, HostedComposio, InstallSecret, PersonalComposio, TOOLKIT_LABELS };
