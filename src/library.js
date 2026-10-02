const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Every call is named by its file stem, e.g. 2026-09-30-2155 or 2026-09-30-2155-2.
const STEM = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(\d+))?$/;
const NONE = /^none captured\.?$/i;
const MAX_TAGS = 12;

function startedAtFromStem(stem) {
  const match = STEM.exec(stem);
  if (!match) return null;
  const [, year, month, day, hours, minutes] = match.map(Number);
  return new Date(year, month - 1, day, hours, minutes).getTime();
}

function durationSeconds(value) {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function bulletItems(lines) {
  return lines
    .map((line) => /^\s*-\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter((item) => item && !NONE.test(item));
}

// Reads the Markdown the app writes (see note.js) back into its parts.
function parseNote(markdown) {
  const lines = String(markdown || "").split("\n");
  const heading = /^#\s+(.*)$/.exec(lines.find((line) => line.startsWith("# ")) || "")?.[1] || "";
  const dash = heading.lastIndexOf(" — ");
  const headingTitle = (dash === -1 ? heading : heading.slice(0, dash)).trim();
  const meta = {};
  const sections = {};
  let current = null;

  for (const line of lines) {
    const section = /^##\s+(.*)$/.exec(line);
    if (section) {
      current = section[1].trim().toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current) {
      sections[current].push(line);
      continue;
    }
    const field = /^-\s+\*\*([^*]+):\*\*\s*(.*)$/.exec(line);
    if (field) meta[field[1].trim().toLowerCase()] = field[2].trim();
  }

  const actionItems = bulletItems(sections["action items"] || []).map((item) => {
    const match = /^\[( |x)\]\s+(?:\*\*(.+?)\*\*\s+[—-]\s+)?(.*)$/i.exec(item);
    return match
      ? { owner: match[2] || "Unassigned", task: match[3].trim(), done: match[1].toLowerCase() === "x" }
      : { owner: "Unassigned", task: item, done: false };
  });

  const transcriptText = (sections["full transcript"] || []).join("\n").trim();
  const transcript = /^_no speech was transcribed\._$/i.test(transcriptText)
    ? []
    : transcriptText
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = /^([^:]{1,40}):\s+(.*)$/.exec(line);
          return match ? { speaker: match[1].trim(), text: match[2] } : { speaker: null, text: line };
        });

  return {
    title: headingTitle && headingTitle !== "Meeting Notes" ? headingTitle : null,
    duration: durationSeconds(meta.duration),
    transcription: meta.transcription || null,
    summaryModel: meta["summary model"] || null,
    summary: bulletItems(sections.summary || []),
    decisions: bulletItems(sections["decisions made"] || []),
    actionItems,
    transcript,
  };
}

function cleanTags(tags) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 32);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
  }
  return result.slice(0, MAX_TAGS);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

async function listDir(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * The meetings page. Notes come from the notes folder, plus the copies the app keeps for
 * calls that only went to Notion. Titles, folders and tags live in a sidecar file, so the
 * notes themselves are never rewritten.
 */
class MeetingLibrary {
  constructor({ metadataPath, copiesDir, getNotesDir, notionLedgerPath, trashItem }) {
    this.metadataPath = metadataPath;
    this.copiesDir = copiesDir;
    this.getNotesDir = getNotesDir;
    this.notionLedgerPath = notionLedgerPath;
    this.trashItem = trashItem;
    this.cache = new Map();
    this.queue = Promise.resolve();
  }

  // Serializes edits to the sidecar file.
  #edit(change) {
    const run = this.queue.then(async () => {
      const metadata = await this.#metadata();
      const result = await change(metadata);
      await writeJson(this.metadataPath, metadata);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async #metadata() {
    const metadata = await readJson(this.metadataPath, {});
    return { folders: Array.isArray(metadata.folders) ? metadata.folders : [], meetings: metadata.meetings || {} };
  }

  async #notionPages() {
    const ledger = await readJson(this.notionLedgerPath, {});
    const pages = new Map();
    for (const [notePath, page] of Object.entries(ledger.synced || {})) {
      if (page?.url) pages.set(path.basename(notePath, ".md"), page.url);
    }
    return pages;
  }

  async #parsed(notePath) {
    const stat = await fs.stat(notePath);
    const cached = this.cache.get(notePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
    const markdown = await fs.readFile(notePath, "utf8");
    const entry = { mtimeMs: stat.mtimeMs, note: parseNote(markdown), text: markdown.toLowerCase() };
    this.cache.set(notePath, entry);
    return entry;
  }

  // Finds every call on disk: stem → where its note and audio are.
  async #files() {
    const notesDir = this.getNotesDir();
    const found = new Map();
    const take = (directory, name) => {
      const extension = path.extname(name);
      const stem = path.basename(name, extension);
      if (!STEM.test(stem) || ![".md", ".webm"].includes(extension)) return;
      const entry = found.get(stem) || { stem, notePath: null, audioPath: null };
      if (extension === ".md" && !entry.notePath) entry.notePath = path.join(directory, name);
      if (extension === ".webm" && !entry.audioPath) entry.audioPath = path.join(directory, name);
      found.set(stem, entry);
    };
    for (const name of await listDir(notesDir)) take(notesDir, name);
    for (const name of await listDir(this.copiesDir)) take(this.copiesDir, name);
    return found;
  }

  async #entries() {
    const [files, metadata, notion] = await Promise.all([this.#files(), this.#metadata(), this.#notionPages()]);
    const entries = [];
    for (const file of files.values()) {
      const parsed = file.notePath ? await this.#parsed(file.notePath).catch(() => null) : null;
      entries.push({ file, parsed, meta: metadata.meetings[file.stem] || {}, notionUrl: notion.get(file.stem) || null });
    }
    return { entries, metadata };
  }

  #summary({ file, parsed, meta, notionUrl }) {
    const note = parsed?.note;
    return {
      id: file.stem,
      title: meta.title || note?.title || null,
      startedAt: startedAtFromStem(file.stem),
      duration: note?.duration ?? null,
      preview: note?.summary[0] || null,
      folderId: meta.folderId || null,
      tags: meta.tags || [],
      hasNote: Boolean(file.notePath),
      hasAudio: Boolean(file.audioPath),
      notionUrl,
      actionItemCount: note?.actionItems.length || 0,
    };
  }

  async list() {
    const { entries, metadata } = await this.#entries();
    const meetings = entries.map((entry) => this.#summary(entry)).sort((a, b) => b.id.localeCompare(a.id));
    const tags = cleanTags(meetings.flatMap((meeting) => meeting.tags)).sort((a, b) => a.localeCompare(b));
    const folders = metadata.folders.filter((folder) => folder?.id && folder?.name);
    return { meetings, folders, tags };
  }

  // Full-text search over titles, tags and the whole note. Returns matching ids.
  async search(query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const { entries, metadata } = await this.#entries();
    const folderNames = new Map(metadata.folders.map((folder) => [folder.id, folder.name]));
    return entries
      .filter(({ file, parsed, meta }) => {
        const haystack = [
          meta.title || "",
          (meta.tags || []).join(" "),
          folderNames.get(meta.folderId) || "",
          parsed?.text || "",
        ]
          .join("\n")
          .toLowerCase();
        return words.every((word) => haystack.includes(word)) || file.stem.includes(words.join(" "));
      })
      .map(({ file }) => file.stem);
  }

  async get(id) {
    const { entries } = await this.#entries();
    const entry = entries.find(({ file }) => file.stem === String(id));
    if (!entry) throw new Error("That meeting is no longer on this Mac.");
    const note = entry.parsed?.note;
    return {
      ...this.#summary(entry),
      notePath: entry.file.notePath,
      audioPath: entry.file.audioPath,
      transcription: note?.transcription || null,
      summaryModel: note?.summaryModel || null,
      summary: note?.summary || [],
      decisions: note?.decisions || [],
      actionItems: note?.actionItems || [],
      transcript: note?.transcript || [],
    };
  }

  #requireId(id) {
    if (!STEM.test(String(id))) throw new Error("That isn't a meeting.");
    return String(id);
  }

  async update(id, changes = {}) {
    const stem = this.#requireId(id);
    return this.#edit((metadata) => {
      const meta = { ...(metadata.meetings[stem] || {}) };
      if (typeof changes.title === "string") {
        const title = changes.title.replace(/\s+/g, " ").trim().slice(0, 120);
        if (title) meta.title = title;
        else delete meta.title;
      }
      if (changes.folderId !== undefined) {
        if (changes.folderId && !metadata.folders.some((folder) => folder.id === changes.folderId)) {
          throw new Error("That folder no longer exists.");
        }
        if (changes.folderId) meta.folderId = changes.folderId;
        else delete meta.folderId;
      }
      if (changes.tags !== undefined) {
        const tags = cleanTags(changes.tags);
        if (tags.length) meta.tags = tags;
        else delete meta.tags;
      }
      if (Object.keys(meta).length) metadata.meetings[stem] = meta;
      else delete metadata.meetings[stem];
      return meta;
    });
  }

  // Moves the note, its copy and the audio to the Trash, so a mistake can be undone in Finder.
  async remove(id) {
    const stem = this.#requireId(id);
    const files = await this.#files();
    const notesDir = this.getNotesDir();
    const candidates = [
      path.join(notesDir, `${stem}.md`),
      path.join(notesDir, `${stem}.webm`),
      path.join(this.copiesDir, `${stem}.md`),
      path.join(this.copiesDir, `${stem}.webm`),
    ];
    if (!files.has(stem)) throw new Error("That meeting is no longer on this Mac.");
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
      } catch {
        continue;
      }
      await this.trashItem(candidate);
      this.cache.delete(candidate);
    }
    await this.#edit((metadata) => {
      delete metadata.meetings[stem];
    });
    return true;
  }

  async createFolder(name) {
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 48);
    if (!clean) throw new Error("Give the folder a name.");
    return this.#edit((metadata) => {
      if (metadata.folders.some((folder) => folder.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`There's already a folder called ${clean}.`);
      }
      const folder = { id: crypto.randomUUID(), name: clean };
      metadata.folders.push(folder);
      return folder;
    });
  }

  async renameFolder(id, name) {
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 48);
    if (!clean) throw new Error("Give the folder a name.");
    return this.#edit((metadata) => {
      const folder = metadata.folders.find((candidate) => candidate.id === id);
      if (!folder) throw new Error("That folder no longer exists.");
      if (metadata.folders.some((other) => other.id !== id && other.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`There's already a folder called ${clean}.`);
      }
      folder.name = clean;
      return folder;
    });
  }

  // Deleting a folder keeps its meetings; they move back to All meetings.
  async deleteFolder(id) {
    return this.#edit((metadata) => {
      metadata.folders = metadata.folders.filter((folder) => folder.id !== id);
      for (const meta of Object.values(metadata.meetings)) {
        if (meta.folderId === id) delete meta.folderId;
      }
      return true;
    });
  }

  // Keeps a copy of a call that only went to Notion, so it still shows up here.
  async saveCopy(stem, markdown) {
    await fs.mkdir(this.copiesDir, { recursive: true, mode: 0o700 });
    const notePath = path.join(this.copiesDir, `${this.#requireId(stem)}.md`);
    const temporaryPath = `${notePath}.tmp`;
    await fs.writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, notePath);
    return notePath;
  }

  // The note or audio file for a meeting, for "Show in Finder".
  async filePath(id, kind) {
    const { entries } = await this.#entries();
    const entry = entries.find(({ file }) => file.stem === String(id));
    const filePath = kind === "audio" ? entry?.file.audioPath : entry?.file.notePath;
    if (!filePath) throw new Error(kind === "audio" ? "There's no audio for that meeting." : "There's no note for that meeting.");
    return filePath;
  }
}

module.exports = { MeetingLibrary, cleanTags, parseNote, startedAtFromStem };
