// Action items out (Linear, Notion, Apple Reminders) and notes out (Google Docs in a Drive folder).
// Linear, Notion and Drive go through Composio (hosted relay or your own account); Reminders is native.
const fs = require("node:fs/promises");
const path = require("node:path");

const DESTINATIONS = {
  linear: { label: "Linear", toolkit: "linear" },
  notion: { label: "Notion", toolkit: "notion" },
  reminders: { label: "Reminders", toolkit: null },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (time) => {
  const date = new Date(time);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

/** The first URL in a tool's answer that points at the given host. */
function findUrl(data, host) {
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && /url$/i.test(key) && item.includes(host)) return item;
    }
    for (const item of Object.values(value)) {
      const found = walk(item);
      if (found) return found;
    }
    return null;
  };
  return walk(data);
}

/** First array of objects under the given keys (tools put lists under different names). */
function listIn(data, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((node, part) => node?.[part], data);
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Markdown notes as tidy plain text for a Google Doc. */
function notesAsText(markdown) {
  return String(markdown)
    .split("\n")
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) return `\n${heading[1].trim()}`;
      return line
        .replace(/^\s*[-*]\s+\[( |x|X)\]\s+/, (_, done) => (done.trim() ? "☑ " : "☐ "))
        .replace(/^(\s*)[-*]\s+/, "$1• ")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

class Integrations {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  async load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch {
      this.data = {};
    }
    this.data.mode = this.data.mode === "personal" ? "personal" : "hosted";
    this.data.connections ||= { hosted: {}, personal: {} };
    this.data.sent ||= {};
    this.data.docs ||= {};
    this.data.autoSend ||= "off";
    return this.data;
  }

  async save(change = {}) {
    const data = await this.load();
    Object.assign(data, change);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${this.filePath}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(`${this.filePath}.tmp`, this.filePath);
    return data;
  }
}

class ActionSender {
  constructor({ integrations, hosted, personal, calendar, library, speakerName = () => "" }) {
    Object.assign(this, { integrations, hosted, personal, calendar, library, speakerName });
  }

  async #client() {
    return (await this.integrations.load()).mode === "personal" ? this.personal : this.hosted;
  }

  async #connectionId(toolkit) {
    const data = await this.integrations.load();
    const id = data.connections[data.mode]?.[toolkit];
    if (!id) throw new Error(`Connect ${DESTINATIONS[toolkit]?.label || (toolkit === "googledrive" ? "Google Drive" : toolkit)} in Settings → Connections first.`);
    return id;
  }

  async #run(toolkit, tool, args) {
    const result = await (await this.#client()).execute(tool, args, await this.#connectionId(toolkit));
    if (!result?.successful) {
      const detail = typeof result?.error === "string" ? result.error : JSON.stringify(result?.error || "").slice(0, 200);
      throw new Error(detail || "The app didn't accept it.");
    }
    return result.data;
  }

  /** What Settings shows: mode, which apps are connected, and the chosen team, database, list and folder. */
  async state() {
    const data = await this.integrations.load();
    return {
      mode: data.mode,
      connected: Object.fromEntries(["linear", "notion", "googledrive"].map((toolkit) => [toolkit, Boolean(data.connections[data.mode]?.[toolkit])])),
      linearTeam: data.linearTeam || null,
      notionDatabase: data.notionDatabase || null,
      remindersList: data.remindersList || null,
      driveFolder: data.driveFolder || null,
      autoSend: data.autoSend,
      autoSendTo: data.autoSendTo || "",
    };
  }

  async setMode(mode) {
    await this.integrations.save({ mode: mode === "personal" ? "personal" : "hosted" });
    return this.state();
  }

  async connect(toolkit, options) {
    const client = await this.#client();
    const connection = await client.connect(toolkit, options);
    const data = await this.integrations.load();
    data.connections[data.mode] = { ...data.connections[data.mode], [toolkit]: connection.id };
    await this.integrations.save();
    return this.state();
  }

  async disconnect(toolkit) {
    const data = await this.integrations.load();
    const id = data.connections[data.mode]?.[toolkit];
    if (id) await (await this.#client()).disconnect(id).catch(() => {});
    delete data.connections[data.mode]?.[toolkit];
    await this.integrations.save();
    return this.state();
  }

  /** Choices for a picker: Linear teams, Notion databases, Reminders lists or Drive folders. */
  async options(kind, query = "") {
    if (kind === "linear") {
      const data = await this.#run("linear", "LINEAR_LIST_LINEAR_TEAMS", { first: 100 });
      return listIn(data, ["teams", "items", "data.teams", "nodes"]).map((team) => ({ id: team.id, name: team.key ? `${team.name} (${team.key})` : team.name }));
    }
    if (kind === "notion") {
      const data = await this.#run("notion", "NOTION_SEARCH_NOTION_PAGE", { query, filter_property: "object", filter_value: "database", page_size: 50 });
      return listIn(data, ["results", "response_data.results"]).map((database) => ({
        id: database.id,
        name: (database.title || []).map((part) => part.plain_text || part.text?.content || "").join("") || "Untitled database",
      }));
    }
    if (kind === "googledrive") {
      const data = await this.#run("googledrive", "GOOGLEDRIVE_FIND_FOLDER", { page_size: 50, ...(query ? { name_contains: query } : {}) });
      return listIn(data, ["files", "folders"]).map((folder) => ({ id: folder.id, name: folder.name }));
    }
    if (kind === "reminders") {
      let status = await this.calendar.remindersStatus();
      if (status === "not-determined") status = await this.calendar.requestReminders();
      if (status !== "granted") throw new Error("Reminders access is off. Turn it on in System Settings → Privacy & Security → Reminders.");
      return (await this.calendar.reminderLists()).lists.map((list) => ({ id: list.id, name: list.title }));
    }
    throw new Error("Unknown destination.");
  }

  /** Remembers the chosen team, database, list or folder (for Notion, also its title column). */
  async choose(kind, choice) {
    if (kind === "notion" && choice) {
      const data = await this.#run("notion", "NOTION_FETCH_DATABASE", { database_id: choice.id });
      const properties = data?.properties || data?.response_data?.properties || {};
      const title = Object.entries(properties).find(([, value]) => value?.type === "title")?.[0];
      if (!title) throw new Error("That Notion database has no title column.");
      choice = { ...choice, titleProperty: title };
    }
    const key = { linear: "linearTeam", notion: "notionDatabase", reminders: "remindersList", googledrive: "driveFolder" }[kind];
    if (!key) throw new Error("Unknown destination.");
    await this.integrations.save({ [key]: choice ? { id: String(choice.id), name: String(choice.name || ""), ...(choice.titleProperty ? { titleProperty: choice.titleProperty } : {}) } : null });
    return this.state();
  }

  async setAutoSend({ autoSend, autoSendTo }) {
    await this.integrations.save({
      autoSend: ["off", "mine", "all"].includes(autoSend) ? autoSend : "off",
      autoSendTo: Object.keys(DESTINATIONS).includes(autoSendTo) ? autoSendTo : "",
    });
    return this.state();
  }

  async sent() {
    return (await this.integrations.load()).sent;
  }

  /** Sends one action item; returns { destination, url } and remembers it. */
  async send(meetingId, index, destination) {
    if (!DESTINATIONS[destination]) throw new Error("Unknown destination.");
    const meeting = await this.library.get(meetingId);
    const item = meeting.actionItems[index];
    if (!item) throw new Error("That action item is gone.");
    const key = `${meetingId}#${index}`;
    const data = await this.integrations.load();
    if (data.sent[key]?.destination === destination) return data.sent[key];
    const context = `From “${meeting.title || "a call"}” on ${dayLabel(meeting.startedAt)}.${item.owner && item.owner !== "Unassigned" ? ` Owner: ${item.owner}.` : ""}`;
    let url = null;
    // Connected comes before choosing a team or database.
    if (DESTINATIONS[destination].toolkit) await this.#connectionId(DESTINATIONS[destination].toolkit);
    if (destination === "linear") {
      if (!data.linearTeam) throw new Error("Pick a Linear team in Settings → Connections.");
      const created = await this.#run("linear", "LINEAR_CREATE_LINEAR_ISSUE", { team_id: data.linearTeam.id, title: item.task.slice(0, 250), description: context });
      url = findUrl(created, "linear.app");
    } else if (destination === "notion") {
      if (!data.notionDatabase) throw new Error("Pick a Notion database in Settings → Connections.");
      const created = await this.#run("notion", "NOTION_INSERT_ROW_DATABASE", {
        database_id: data.notionDatabase.id,
        properties: [{ name: data.notionDatabase.titleProperty || "Name", type: "title", value: item.task.slice(0, 1900) }],
      });
      url = findUrl(created, "notion.so");
    } else {
      await this.calendar.addReminder({ list: data.remindersList?.id || "", title: item.task, notes: context });
    }
    data.sent[key] = { destination, url, at: Date.now() };
    await this.integrations.save();
    return data.sent[key];
  }

  /** After a call: sends its action items to the chosen destination, if auto-send is on. */
  async autoSend(meetingId) {
    const data = await this.integrations.load();
    if (data.autoSend === "off" || !data.autoSendTo) return [];
    const meeting = await this.library.get(meetingId);
    const me = String(this.speakerName() || "").toLowerCase();
    const results = [];
    for (const [index, item] of meeting.actionItems.entries()) {
      if (item.done) continue;
      const owner = String(item.owner || "").toLowerCase();
      if (data.autoSend === "mine" && !(owner === me || (me && owner === me.split(/\s+/)[0]) || owner === "you")) continue;
      results.push(await this.send(meetingId, index, data.autoSendTo).catch((error) => ({ error: error.message })));
    }
    return results;
  }

  /** After a call: saves its notes as a Google Doc in the chosen Drive folder. */
  async saveNotesToDrive(meetingId, markdown, title) {
    const data = await this.integrations.load();
    if (!data.driveFolder || data.docs[meetingId]) return data.docs[meetingId] || null;
    const created = await this.#run("googledrive", "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", {
      file_name: title.slice(0, 200),
      text_content: notesAsText(markdown),
      mime_type: "application/vnd.google-apps.document",
      parent_id: data.driveFolder.id,
    });
    const url = findUrl(created, "google.com") || (created?.id ? `https://docs.google.com/document/d/${created.id}/edit` : null);
    data.docs[meetingId] = { url, at: Date.now() };
    await this.integrations.save();
    return data.docs[meetingId];
  }
}

module.exports = { ActionSender, DESTINATIONS, Integrations, findUrl, notesAsText };
