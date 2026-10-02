// Your MCP servers as knowledge sources. Each one is asked the same question as the knowledge
// base, with a short time limit, and what comes back is added to the prompt as a cited passage.
// Tokens and environment values are encrypted with macOS secure storage.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { McpClient, pickSearchTool, splitCommand } = require("./mcp-client");
const { AuthRequiredError, expiring, refresh } = require("./mcp-oauth");

const SIGN_IN_AGAIN = "Signed out. Sign in again to keep using it.";

const SEARCH_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_SOURCE_CHARS = 3500;
const MAX_SOURCES = 12;

function parseEnv(text) {
  const env = {};
  for (const line of String(text || "").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    else if (line.trim()) throw new Error(`“${line.trim().slice(0, 40)}” should look like NAME=value.`);
  }
  return env;
}

class KnowledgeSources {
  // signIn(url, { resourceMetadata }) runs the browser sign-in for OAuth servers and returns the session.
  constructor({ filePath, encrypt, decrypt, signIn = null, open = (source, options) => McpClient.open(source, options), now = Date.now, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { filePath, encrypt, decrypt, signIn, open, now, fetchImpl });
    this.sources = null;
    this.clients = new Map();
    this.refreshing = new Map();
  }

  #session(source) {
    return source.oauth ? JSON.parse(this.decrypt(source.oauth)) : null;
  }

  #keepSession(source, session) {
    source.oauth = this.encrypt(JSON.stringify(session));
    void this.#save().catch(() => {});
  }

  // One refresh at a time per source, shared by everyone waiting for it.
  #refresh(source) {
    if (!this.refreshing.has(source.id)) {
      const run = (async () => {
        const session = await refresh(this.#session(source), { fetchImpl: this.fetchImpl });
        this.#keepSession(source, session);
        return session;
      })().finally(() => this.refreshing.delete(source.id));
      this.refreshing.set(source.id, run);
    }
    return this.refreshing.get(source.id);
  }

  #oauthAuth(source) {
    return {
      token: async () => {
        let session = this.#session(source);
        if (expiring(session)) session = await this.#refresh(source);
        return session.accessToken;
      },
      renew: async () => {
        await this.#refresh(source);
      },
    };
  }

  async load() {
    if (this.sources) return this.sources;
    try {
      this.sources = JSON.parse(await fs.readFile(this.filePath, "utf8")).sources || [];
    } catch {
      this.sources = [];
    }
    return this.sources;
  }

  // Saves one at a time: a token refresh and an edit can both want to write at once.
  #save() {
    const run = (this.saving || Promise.resolve()).catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(`${this.filePath}.tmp`, JSON.stringify({ sources: this.sources }, null, 2), { mode: 0o600 });
      await fs.rename(`${this.filePath}.tmp`, this.filePath);
    });
    this.saving = run;
    return run;
  }

  /** What the settings page sees: no tokens or values. */
  async list() {
    return (await this.load()).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      target: source.kind === "url" ? source.url : [source.command, ...source.args].join(" "),
      tool: source.tool,
      queryArg: source.queryArg,
      tools: source.tools || [],
      enabled: source.enabled !== false,
      hasToken: Boolean(source.token),
      signedIn: Boolean(source.oauth),
      needsSignIn: source.lastError === SIGN_IN_AGAIN,
      envKeys: Object.keys(source.env || {}),
      lastError: source.lastError || null,
    }));
  }

  // The source as the client needs it, secrets decrypted.
  #connection(source) {
    if (source.kind === "url") {
      if (source.oauth) return { url: source.url, headers: {}, auth: this.#oauthAuth(source) };
      const token = source.token ? this.decrypt(source.token) : "";
      return { url: source.url, headers: token ? { authorization: /^\S+\s/.test(token) ? token : `Bearer ${token}` } : {} };
    }
    const env = Object.fromEntries(Object.entries(source.env || {}).map(([key, value]) => [key, this.decrypt(value)]));
    return { command: source.command, args: source.args, env };
  }

  // One running connection per source, shared; connecting carries on in the background even if a
  // search stops waiting for it.
  #client(source) {
    const cached = this.clients.get(source.id);
    if (cached && !cached.client.closed) {
      cached.usedAt = this.now();
      return cached.ready;
    }
    const client = this.open(this.#connection(source), { timeoutMs: CONNECT_TIMEOUT_MS });
    const ready = client.initialize().then(
      () => client,
      (error) => {
        if (this.clients.get(source.id)?.client === client) this.clients.delete(source.id);
        client.close();
        throw error;
      },
    );
    ready.catch(() => {});
    this.clients.set(source.id, { client, ready, usedAt: this.now() });
    return ready;
  }

  /** Starts every enabled source, so the first question doesn't wait for npx and friends. */
  async warm() {
    for (const source of await this.load()) if (source.enabled !== false && source.tool) this.#client(source).catch(() => {});
  }

  #drop(id) {
    this.clients.get(id)?.client.close();
    this.clients.delete(id);
  }

  /** Adds a server after checking it answers, and picks its search tool. */
  async add({ name, kind, command, url, token, env }) {
    const sources = await this.load();
    if (sources.length >= MAX_SOURCES) throw new Error(`You can connect up to ${MAX_SOURCES} sources.`);
    const source = { id: crypto.randomUUID(), name: String(name || "").trim().slice(0, 60), kind: kind === "url" ? "url" : "command", enabled: true };
    if (source.kind === "url") {
      source.url = new URL(String(url || "").trim()).href;
      if (token?.trim()) source.token = this.encrypt(token.trim());
    } else {
      const [binary, ...args] = splitCommand(command);
      if (!binary) throw new Error("Enter the command that starts the server, e.g. npx -y @acme/docs-mcp");
      source.command = binary;
      source.args = args;
      source.env = Object.fromEntries(Object.entries(parseEnv(env)).map(([key, value]) => [key, this.encrypt(value)]));
    }
    let client = this.open(this.#connection(source), { timeoutMs: CONNECT_TIMEOUT_MS });
    let info;
    try {
      info = await client.initialize();
    } catch (error) {
      client.close();
      // The server uses OAuth: sign in in the browser, then connect again.
      if (!(error instanceof AuthRequiredError) || source.kind !== "url" || source.token) throw error;
      if (!this.signIn) throw new Error("This server needs you to sign in, which isn't available here.");
      this.#keepSession(source, await this.signIn(source.url, { resourceMetadata: error.resourceMetadata }));
      client = this.open(this.#connection(source), { timeoutMs: CONNECT_TIMEOUT_MS });
      info = await client.initialize();
    }
    try {
      const tools = await client.listTools();
      const pick = pickSearchTool(tools);
      if (!pick) throw new Error("That server has no tool that takes a search question.");
      source.name ||= info?.serverInfo?.name || "MCP server";
      source.tools = tools.map((tool) => ({ name: tool.name, description: String(tool.description || "").slice(0, 200), args: Object.keys(tool.inputSchema?.properties || {}) }));
      Object.assign(source, pick);
    } finally {
      client.close();
    }
    sources.push(source);
    await this.#save();
    return this.list();
  }

  /** Runs the browser sign-in again for a source whose sign-in has run out. */
  async signInAgain(id) {
    const source = (await this.load()).find((candidate) => candidate.id === id);
    if (!source || source.kind !== "url") throw new Error("That source is gone.");
    if (!this.signIn) throw new Error("Sign-in isn't available here.");
    this.#drop(id);
    this.#keepSession(source, await this.signIn(source.url, {}));
    delete source.lastError;
    await this.#save();
    void this.warm();
    return this.list();
  }

  async update(id, changes) {
    const source = (await this.load()).find((candidate) => candidate.id === id);
    if (!source) throw new Error("That source is gone.");
    if (typeof changes.enabled === "boolean") source.enabled = changes.enabled;
    if (changes.tool) {
      const tool = (source.tools || []).find((candidate) => candidate.name === changes.tool);
      if (!tool) throw new Error("That server doesn't have that tool.");
      source.tool = tool.name;
      source.queryArg = changes.queryArg && tool.args.includes(changes.queryArg) ? changes.queryArg : tool.args[0];
    }
    delete source.lastError;
    await this.#save();
    return this.list();
  }

  async remove(id) {
    this.#drop(id);
    this.sources = (await this.load()).filter((source) => source.id !== id);
    await this.#save();
    return this.list();
  }

  /** Asks every enabled source; slow or failing ones are skipped, not waited on. */
  async search(query, { timeoutMs = SEARCH_TIMEOUT_MS, maxChars = MAX_SOURCE_CHARS } = {}) {
    const question = String(query || "").trim().slice(0, 1000);
    const sources = (await this.load()).filter((source) => source.enabled !== false && source.tool);
    if (!question || !sources.length) return [];
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          let timer;
          const client = await Promise.race([
            this.#client(source),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), timeoutMs);
            }),
          ]).finally(() => clearTimeout(timer));
          // Still starting up: skip it this time.
          if (!client) return null;
          const text = await client.callTool(source.tool, { [source.queryArg]: question }, { timeoutMs });
          if (source.lastError) {
            delete source.lastError;
            void this.#save().catch(() => {});
          }
          const clean = text.trim();
          if (!clean) return null;
          return { file: `mcp:${source.id}`, name: source.name, text: clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean };
        } catch (error) {
          this.#drop(source.id);
          source.lastError = error instanceof AuthRequiredError ? SIGN_IN_AGAIN : String(error.message || error).slice(0, 200);
          void this.#save().catch(() => {});
          return null;
        }
      }),
    );
    this.sweep();
    return results.filter(Boolean);
  }

  /** Stops local servers nobody has asked for a while. */
  sweep() {
    for (const [id, entry] of this.clients) if (this.now() - entry.usedAt > IDLE_MS) this.#drop(id);
  }

  closeAll() {
    for (const id of [...this.clients.keys()]) this.#drop(id);
  }
}

module.exports = { KnowledgeSources, parseEnv };
