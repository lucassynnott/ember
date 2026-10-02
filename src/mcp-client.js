// A small MCP client, so your own MCP servers (a docs search, a CRM, a wiki) can act as knowledge
// sources for Ask, live help and prep. Two transports: a local command over stdio, or a remote
// server over Streamable HTTP. Only tools/list and tools/call are used.
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "meeting-notes", version: require("../package.json").version };

// Apps started from the Dock get a bare PATH; add the usual places for npx, uvx and friends.
function commandPath(current = process.env.PATH || "") {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME}/.local/bin`, `${process.env.HOME}/.bun/bin`, `${process.env.HOME}/.cargo/bin`];
  return [...new Set([...current.split(":").filter(Boolean), ...extra])].join(":");
}

/** Splits a command line like a shell would for simple quoting: npx -y "@acme/docs mcp". */
function splitCommand(line) {
  const parts = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of String(line || "").trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
    }
  }
  if (quote) throw new Error("A quote in the command isn't closed.");
  if (started || current) parts.push(current);
  return parts;
}

class StdioTransport extends EventEmitter {
  constructor({ command, args = [], env = {} }) {
    super();
    this.child = spawn(command, args, { env: { ...process.env, PATH: commandPath(), ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = "";
    this.stderr = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          this.emit("message", JSON.parse(line));
        } catch {
          // Servers sometimes log to stdout; ignore anything that isn't JSON.
        }
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2000);
    });
    this.child.on("error", (error) => this.emit("close", error.code === "ENOENT" ? new Error(`Couldn't find “${command}”. Check the command, or use its full path.`) : error));
    this.child.on("exit", (code) => this.emit("close", new Error(`The server stopped${code ? ` (exit ${code})` : ""}.${this.stderr.trim() ? ` ${this.stderr.trim().split("\n").pop()}` : ""}`)));
  }

  async send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

// Reads JSON-RPC messages from a server-sent events body.
function parseEventStream(text) {
  const messages = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Not a JSON message.
    }
  }
  return messages;
}

class HttpTransport extends EventEmitter {
  constructor({ url, headers = {}, fetchImpl = globalThis.fetch }) {
    super();
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("The URL should start with https://");
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
      throw new Error("Use https:// for servers that aren't on this Mac.");
    }
    this.url = parsed.href;
    this.headers = headers;
    this.fetch = fetchImpl;
    this.session = null;
  }

  async send(message, { signal } = {}) {
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
        ...this.headers,
      },
      body: JSON.stringify(message),
      signal,
    });
    this.session = response.headers.get("mcp-session-id") || this.session;
    if (response.status === 401 || response.status === 403) throw new Error("The server turned down the request. Check the access token.");
    if (!response.ok && response.status !== 202) throw new Error(`The server answered ${response.status}.`);
    if (response.status === 202 || message.id === undefined) return;
    const type = response.headers.get("content-type") || "";
    const body = await response.text();
    const messages = type.includes("text/event-stream") ? parseEventStream(body) : [JSON.parse(body)].flat();
    for (const reply of messages) this.emit("message", reply);
  }

  close() {
    if (!this.session) return;
    void this.fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.session, ...this.headers } }).catch(() => {});
  }
}

class McpClient {
  constructor(transport, { timeoutMs = 15_000 } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = null;
    transport.on("message", (message) => {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message || "The server reported an error."));
      else waiting.resolve(message.result);
    });
    transport.on("close", (error) => {
      this.closed = error;
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    });
  }

  static open(source, options) {
    const transport = source.url ? new HttpTransport({ url: source.url, headers: source.headers, fetchImpl: options?.fetchImpl }) : new StdioTransport(source);
    return new McpClient(transport, options);
  }

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The server took too long to answer."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((error) => this.pending.get(id)?.reject(error));
    });
  }

  async initialize() {
    const result = await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    this.serverInfo = result?.serverInfo || null;
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  /** Calls a tool and returns its text. */
  async callTool(name, args, options) {
    const result = await this.request("tools/call", { name, arguments: args }, options);
    const text = (result?.content || [])
      .map((part) => (part.type === "text" ? part.text : part.type === "resource" && part.resource?.text ? part.resource.text : ""))
      .filter(Boolean)
      .join("\n\n");
    if (result?.isError) throw new Error(text.slice(0, 300) || "The tool reported an error.");
    return text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : "");
  }

  close() {
    this.transport.close();
  }
}

/** The tool most likely to be a search, and the argument that takes the question. */
function pickSearchTool(tools) {
  const queryArg = (tool) => {
    const properties = tool.inputSchema?.properties || {};
    const strings = Object.keys(properties).filter((key) => properties[key]?.type === "string");
    const named = strings.find((key) => /^(query|q|question|search|text|prompt|keywords?|term)$/i.test(key));
    const required = (tool.inputSchema?.required || []).filter((key) => properties[key]?.type === "string");
    return named || (required.length === 1 ? required[0] : strings[0]) || null;
  };
  const scored = tools
    .map((tool) => {
      const arg = queryArg(tool);
      const otherRequired = (tool.inputSchema?.required || []).filter((key) => key !== arg);
      let score = arg ? 1 : -10;
      if (/search|query|find|lookup|retriev|ask/i.test(tool.name)) score += 4;
      if (/search|find|look up|retriev/i.test(tool.description || "")) score += 1;
      if (/create|update|delete|write|send|post|remove/i.test(tool.name)) score -= 6;
      score -= otherRequired.length * 3;
      return { tool, arg, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score > 0 ? { tool: best.tool.name, queryArg: best.arg } : null;
}

module.exports = { HttpTransport, McpClient, StdioTransport, commandPath, parseEventStream, pickSearchTool, splitCommand };
