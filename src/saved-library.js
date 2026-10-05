// Posts, articles and pages saved from across the web, kept on this Mac and sorted into boards.
// A link saved twice stays one item; saving it again just moves it to the top.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ITEMS = 5000;
const MAX_BOARDS = 200;
const KINDS = ["post", "article", "video", "link"];

function cleanTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag).toLowerCase().replace(/^#/, "").replace(/[^\p{L}\p{N} &+.-]/gu, "").trim().slice(0, 30)).filter(Boolean))].slice(0, 8);
}

class SavedLibrary {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.dir = dir;
    this.filePath = path.join(dir, "saved.json");
    this.imagesDir = path.join(dir, "images");
    this.now = now;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async #load() {
    if (this.data) return this.data;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.data = { items: Array.isArray(data.items) ? data.items : [], boards: Array.isArray(data.boards) ? data.boards : [] };
    } catch {
      this.data = { items: [], boards: [] };
    }
    return this.data;
  }

  #save() {
    this.queue = this.queue
      .then(async () => {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        await fs.writeFile(`${this.filePath}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
        await fs.rename(`${this.filePath}.tmp`, this.filePath);
      })
      .catch(() => {});
    return this.queue;
  }

  imagePath(item) {
    return item?.image ? path.join(this.imagesDir, path.basename(item.image)) : null;
  }

  // A new link starts as "reading" until its page has been read. Returns { item, existing }.
  async add(url, { board = null, source = "paste" } = {}) {
    const data = await this.#load();
    const existing = data.items.find((item) => item.url === url || item.canonicalUrl === url);
    if (existing) {
      existing.savedAt = this.now();
      if (board && data.boards.some((entry) => entry.id === board) && !existing.boards.includes(board)) existing.boards.push(board);
      data.items.splice(data.items.indexOf(existing), 1);
      data.items.unshift(existing);
      await this.#save();
      return { item: existing, existing: true };
    }
    const item = {
      id: crypto.randomUUID(),
      url,
      canonicalUrl: url,
      status: "reading",
      kind: "link",
      title: "",
      description: "",
      siteName: new URL(url).hostname.replace(/^www\./, ""),
      author: "",
      summary: "",
      tags: [],
      boards: board && data.boards.some((entry) => entry.id === board) ? [board] : [],
      source,
      savedAt: this.now(),
    };
    data.items.unshift(item);
    if (data.items.length > MAX_ITEMS) {
      const dropped = data.items.splice(MAX_ITEMS);
      await Promise.all(dropped.map((entry) => this.#dropImage(entry)));
    }
    await this.#save();
    return { item, existing: false };
  }

  async #dropImage(item) {
    const file = this.imagePath(item);
    if (file) await fs.rm(file, { force: true });
  }

  // Fills in what was read from the page (and later the AI's summary and tags).
  async update(id, changes) {
    const data = await this.#load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return null;
    const allowed = ["status", "error", "kind", "title", "description", "siteName", "author", "text", "canonicalUrl", "publishedAt", "summary", "imageUrl"];
    for (const key of allowed) if (key in changes) item[key] = changes[key];
    if (item.kind && !KINDS.includes(item.kind)) item.kind = "link";
    if ("tags" in changes) item.tags = cleanTags(changes.tags);
    // The same page saved before under another link (a short link, say): keep the older item.
    const same = data.items.find((entry) => entry !== item && (entry.url === item.canonicalUrl || entry.canonicalUrl === item.canonicalUrl));
    if (same) {
      same.boards = [...new Set([...same.boards, ...item.boards])];
      same.savedAt = item.savedAt;
      data.items = data.items.filter((entry) => entry !== item);
      data.items.splice(data.items.indexOf(same), 1);
      data.items.unshift(same);
      await this.#save();
      return { ...same, mergedFrom: item.id };
    }
    await this.#save();
    return item;
  }

  async setImage(id, bytes, extension = "jpg") {
    const data = await this.#load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item || !bytes?.length) return null;
    await fs.mkdir(this.imagesDir, { recursive: true, mode: 0o700 });
    const name = `${item.id}.${extension}`;
    await fs.writeFile(path.join(this.imagesDir, name), bytes, { mode: 0o600 });
    item.image = name;
    await this.#save();
    return item;
  }

  async get(id) {
    return (await this.#load()).items.find((item) => item.id === id) || null;
  }

  // Newest first. Every word must appear in the title, text, summary, site, author or tags.
  async list({ query = "", board = "", tag = "", kind = "", limit = 500 } = {}) {
    const data = await this.#load();
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const items = data.items.filter((item) => {
      if (board === "unsorted" ? item.boards.length : board && !item.boards.includes(board)) return false;
      if (tag && !item.tags.includes(tag)) return false;
      if (kind && item.kind !== kind) return false;
      const haystack = `${item.title} ${item.description} ${item.summary} ${item.siteName} ${item.author} ${item.tags.join(" ")} ${item.url} ${(item.text || "").slice(0, 4000)}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    return { items: items.slice(0, limit), total: data.items.length };
  }

  // Tags in use, most used first, so the AI can reuse them.
  async tags() {
    const counts = new Map();
    for (const item of (await this.#load()).items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  }

  async remove(id) {
    const data = await this.#load();
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return;
    data.items = data.items.filter((entry) => entry !== item);
    await this.#dropImage(item);
    await this.#save();
  }

  async setTags(id, tags) {
    return this.update(id, { tags });
  }

  // Boards

  async boards() {
    const data = await this.#load();
    return data.boards.map((board) => ({ ...board, count: data.items.filter((item) => item.boards.includes(board.id)).length }));
  }

  async createBoard(name) {
    const data = await this.#load();
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!clean) throw new Error("Give the board a name.");
    if (data.boards.length >= MAX_BOARDS) throw new Error("That's the most boards you can have.");
    const existing = data.boards.find((board) => board.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const board = { id: crypto.randomUUID(), name: clean, createdAt: this.now() };
    data.boards.push(board);
    await this.#save();
    return board;
  }

  async renameBoard(id, name) {
    const data = await this.#load();
    const board = data.boards.find((entry) => entry.id === id);
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!board || !clean) return null;
    board.name = clean;
    await this.#save();
    return board;
  }

  // Deleting a board keeps its items; they just leave the board.
  async removeBoard(id) {
    const data = await this.#load();
    data.boards = data.boards.filter((board) => board.id !== id);
    for (const item of data.items) item.boards = item.boards.filter((board) => board !== id);
    await this.#save();
  }

  async setBoard(itemId, boardId, included) {
    const data = await this.#load();
    const item = data.items.find((entry) => entry.id === itemId);
    if (!item || !data.boards.some((board) => board.id === boardId)) return null;
    item.boards = included ? [...new Set([...item.boards, boardId])] : item.boards.filter((board) => board !== boardId);
    await this.#save();
    return item;
  }
}

module.exports = { SavedLibrary, cleanTags };
