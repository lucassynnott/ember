const { supportDirectory } = require("./platform");
// Ember as an MCP server, so Claude, Cursor and other AI apps can search your calls and
// knowledge base. It runs as its own small process over stdio and only reads: nothing here
// changes a meeting, and nothing leaves this Mac except what the connected app asks for.
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/Ember.app/Contents/MacOS/Ember" \
//     "/Applications/Ember.app/Contents/Resources/app.asar/src/mcp-server.js"
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { MeetingLibrary } = require("./library");
const { KnowledgeBase } = require("./knowledge");
const { rankPassages } = require("./ask");

const SERVER_INFO = { name: "meeting-notes", version: require("../package.json").version };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TEXT = 60_000;

function dataDir() {
  return process.env.MEETING_NOTES_DATA || supportDirectory("local-meeting-notes");
}

function readSettings(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

const day = (time) => new Date(time).toISOString().slice(0, 10);
const when = (time) => {
  const date = new Date(time);
  return `${day(time)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
const name = (meeting) => meeting.title || `Call at ${when(meeting.startedAt).slice(11)}`;
const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[Cut short: ask for less, or one meeting at a time.]` : text);

function headline(meeting, folderNames = new Map()) {
  const extras = [meeting.duration ? `${Math.round(meeting.duration / 60)} min` : "", folderNames.get(meeting.folderId) || "", (meeting.tags || []).map((tag) => `#${tag}`).join(" ")];
  return `${name(meeting)} (id: ${meeting.id}) | ${when(meeting.startedAt)}${extras.filter(Boolean).map((part) => ` | ${part}`).join("")}`;
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59" : "00:00:00"}` : value);
  if (Number.isNaN(time)) throw new Error(`“${value}” isn't a date. Use YYYY-MM-DD.`);
  return time;
}

const TOOLS = [
  {
    name: "search_meetings",
    description:
      "Search the user's recorded meetings (titles, summaries, decisions, action items and full transcripts). Returns the best-matching calls with the passages that matched. Use get_meeting for a whole call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'Acme pricing objections'" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "How many calls to return (default 6)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_meetings",
    description: "List the user's meetings, newest first, optionally between two dates or in a folder or tag.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Earliest date, YYYY-MM-DD" },
        to: { type: "string", description: "Latest date, YYYY-MM-DD" },
        folder: { type: "string", description: "Only calls in this folder" },
        tag: { type: "string", description: "Only calls with this tag" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 30" },
      },
    },
  },
  {
    name: "get_meeting",
    description: "Get one meeting by id: summary, decisions, action items, the user's own notes and, by default, the full transcript.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Meeting id from search_meetings or list_meetings, e.g. 2026-10-01-1605" },
        include_transcript: { type: "boolean", description: "Default true" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_action_items",
    description: "Action items from the user's meetings, newest call first. Filter by owner, dates, or open only.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Only items for this person (part of the name is enough)" },
        from: { type: "string", description: "Earliest date, YYYY-MM-DD" },
        to: { type: "string", description: "Latest date, YYYY-MM-DD" },
        open_only: { type: "boolean", description: "Leave out items ticked off (default true)" },
      },
    },
  },
  {
    name: "search_knowledge",
    description: "Search the user's knowledge base: their own folders of documents (playbooks, guides, product notes) added in Ember.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 6" },
      },
      required: ["query"],
    },
  },
];

class MeetingNotesTools {
  constructor({ folder = dataDir() } = {}) {
    const settings = readSettings(folder);
    this.library = new MeetingLibrary({
      metadataPath: path.join(folder, "library.json"),
      copiesDir: path.join(folder, "library"),
      getNotesDir: () => settings.notesDir || path.join(os.homedir(), "MeetingNotes"),
      notionLedgerPath: path.join(folder, "notion-sync.json"),
      trashItem: async () => {
        throw new Error("Read only.");
      },
    });
    this.folderNames = new Map();
    this.knowledge = new KnowledgeBase({ indexPath: path.join(folder, "knowledge", "index.json") });
  }

  async #all() {
    const { meetings, folders } = await this.library.list();
    this.folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
    const details = [];
    for (const meeting of meetings) {
      const detail = await this.library.get(meeting.id).catch(() => null);
      if (detail) details.push(detail);
    }
    return details;
  }

  async search_meetings({ query, limit = 6 }) {
    if (!String(query || "").trim()) throw new Error("Say what to search for.");
    const meetings = await this.#all();
    const byId = new Map(meetings.map((meeting) => [meeting.id, meeting]));
    // Notes first (title, summary, decisions, actions), then transcript passages.
    const scored = new Map();
    for (const passage of rankPassages(
      meetings.map((meeting) => ({
        ...meeting,
        transcript: [
          { speaker: null, text: [meeting.title || "", ...meeting.summary, ...meeting.decisions, ...meeting.actionItems.map((item) => `${item.owner}: ${item.task}`), ...(meeting.tags || [])].join("\n") },
          ...meeting.transcript,
        ],
      })),
      query,
    )) {
      const entry = scored.get(passage.id) || { score: 0, passages: [] };
      entry.score += passage.score;
      if (entry.passages.length < 2) entry.passages.push(passage.text);
      scored.set(passage.id, entry);
    }
    const top = [...scored.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, Math.min(20, limit));
    if (!top.length) return `No meetings mention “${query}”.`;
    return clip(
      top
        .map(([id, { passages }]) => {
          const meeting = byId.get(id);
          const summary = meeting.summary.length ? `Summary: ${meeting.summary.join(" ")}\n` : "";
          return `## ${headline(meeting, this.folderNames)}\n${summary}Matched:\n${passages.map((text) => `> ${text.trim().replace(/\n/g, "\n> ")}`).join("\n\n")}`;
        })
        .join("\n\n"),
    );
  }

  async list_meetings({ from, to, folder, tag, limit = 30 }) {
    const start = parseDate(from);
    const end = parseDate(to, true);
    const { meetings, folders } = await this.library.list();
    this.folderNames = new Map(folders.map((candidate) => [candidate.id, candidate.name]));
    const folderId = folder ? folders.find((candidate) => candidate.name.toLowerCase() === String(folder).toLowerCase())?.id : null;
    if (folder && !folderId) return `There's no folder called “${folder}”. Folders: ${folders.map((candidate) => candidate.name).join(", ") || "none"}.`;
    const matches = meetings.filter(
      (meeting) =>
        (!start || meeting.startedAt >= start) &&
        (!end || meeting.startedAt <= end) &&
        (!folderId || meeting.folderId === folderId) &&
        (!tag || (meeting.tags || []).some((candidate) => candidate.toLowerCase() === String(tag).toLowerCase())),
    );
    if (!matches.length) return "No meetings match.";
    return matches
      .slice(0, Math.min(200, limit))
      .map((meeting) => `- ${headline(meeting, this.folderNames)}${meeting.preview ? `\n  ${meeting.preview}` : ""}`)
      .join("\n");
  }

  async get_meeting({ id, include_transcript = true }) {
    const meeting = await this.library.get(String(id || ""));
    this.folderNames = new Map((await this.library.list()).folders.map((folder) => [folder.id, folder.name]));
    const section = (title, lines) => (lines.length ? `\n## ${title}\n${lines.join("\n")}\n` : "");
    return clip(
      [
        `# ${headline(meeting, this.folderNames)}`,
        meeting.attendees.length ? `Attendees: ${meeting.attendees.join(", ")}` : "",
        section("Summary", meeting.summary),
        section("Decisions", meeting.decisions.map((line) => `- ${line}`)),
        section("Action items", meeting.actionItems.map((item) => `- [${item.done ? "x" : " "}] ${item.owner}: ${item.task}`)),
        section("Their own notes", meeting.yourNotes.map((item) => `- ${item.note}${item.detail ? `: ${item.detail}` : ""}`)),
        section("Shared on screen", meeting.slides.map((slide) => `- ${slide.time}: ${slide.caption}`)),
        include_transcript ? section("Transcript", meeting.transcript.map((line) => (line.speaker ? `${line.speaker}: ${line.text}` : line.text))) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async get_action_items({ owner, from, to, open_only = true }) {
    const start = parseDate(from);
    const end = parseDate(to, true);
    const who = String(owner || "").toLowerCase();
    const lines = [];
    for (const meeting of await this.#all()) {
      if ((start && meeting.startedAt < start) || (end && meeting.startedAt > end)) continue;
      const items = meeting.actionItems.filter((item) => (!open_only || !item.done) && (!who || item.owner.toLowerCase().includes(who)));
      if (items.length) lines.push(`## ${headline(meeting, this.folderNames)}`, ...items.map((item) => `- [${item.done ? "x" : " "}] ${item.owner}: ${item.task}`), "");
    }
    return lines.length ? clip(lines.join("\n")) : "No action items match.";
  }

  async search_knowledge({ query, limit = 6 }) {
    await this.knowledge.load();
    const passages = this.knowledge.search(String(query || ""), { limit: Math.min(20, limit), maxChars: 24_000 });
    if (!passages.length) return this.knowledge.status().files ? `Nothing in the knowledge base matches “${query}”.` : "The knowledge base is empty. Add folders in Ember → Settings → Knowledge base.";
    return passages.map((passage) => `## ${passage.name}\n(${passage.file})\n${passage.text}`).join("\n\n");
  }
}

/** Answers one JSON-RPC message; returns the reply, or null for notifications. */
async function handleMessage(message, tools) {
  const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code, message: text } });
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(-32600, "Invalid request");
  const isNotification = message.id === undefined;
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "The user's recorded meetings and knowledge base from the Ember app. Search first, then open a meeting by id. Cite meetings by title and date.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const { name: tool, arguments: args = {} } = message.params || {};
      if (!TOOLS.some((candidate) => candidate.name === tool)) return fail(-32602, `Unknown tool: ${tool}`);
      try {
        const text = await tools[tool](args || {});
        return reply({ content: [{ type: "text", text }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: error.message }], isError: true });
      }
    }
    default:
      return isNotification ? null : fail(-32601, `Method not found: ${message.method}`);
  }
}

function serve({ input = process.stdin, output = process.stdout, tools = new MeetingNotesTools() } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (value) => output.write(`${JSON.stringify(value)}\n`);
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const response = await handleMessage(message, tools).catch((error) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: error.message } }));
    if (response && message.id !== undefined) write(response);
  });
  return lines;
}

if (require.main === module) {
  // Anything logged must not land on stdout, which carries the protocol.
  console.log = console.error;
  serve();
}

module.exports = { MeetingNotesTools, TOOLS, handleMessage, serve };
