// Everything you copy, kept on this Mac so you can paste it again from the clipboard picker or the
// Clipboard page. Copies password managers mark as secret are never passed in. Pinned items stay
// until you remove them; the rest are kept for the chosen number of days.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ENTRIES = 1000;
const MAX_IMAGES = 150;
const MAX_TEXT = 100000;
const URL_PATTERN = /^(https?:\/\/|www\.)[^\s]+$/i;
const KINDS = ["text", "link", "image", "file", "qr", "barcode"];

function kindOf(text) {
  return URL_PATTERN.test(String(text || "").trim()) ? "link" : "text";
}

class ClipboardHistory {
  constructor(filePath, { imagesDir, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.imagesDir = imagesDir || path.join(path.dirname(filePath), "clipboard-images");
    this.now = now;
    this.entries = null;
    this.queue = Promise.resolve();
  }

  async #load() {
    if (this.entries) return this.entries;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.entries = Array.isArray(data.entries) ? data.entries : [];
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  #save() {
    this.queue = this.queue
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(`${this.filePath}.tmp`, JSON.stringify({ entries: this.entries }), { mode: 0o600 });
        await fs.rename(`${this.filePath}.tmp`, this.filePath);
      })
      .catch(() => {});
    return this.queue;
  }

  imagePath(entry) {
    return entry?.image ? path.join(this.imagesDir, path.basename(entry.image)) : null;
  }

  async #dropImages(entries) {
    await Promise.all(entries.filter((entry) => entry.image).map((entry) => fs.rm(this.imagePath(entry), { force: true })));
  }

  // Text, a link, a file path or a QR code's contents. The same text copied again moves to the top.
  async add({ text, kind, app = "", bundleId = "", source = "copy" }) {
    const clean = String(text || "").replace(/\r\n/g, "\n");
    if (!clean.trim()) return null;
    const entries = await this.#load();
    const value = clean.slice(0, MAX_TEXT);
    const existing = entries.find((entry) => entry.text === value && entry.kind !== "image");
    const entry = existing || { id: crypto.randomUUID(), kind: KINDS.includes(kind) ? kind : kindOf(value), text: value };
    Object.assign(entry, { at: this.now(), app: String(app || ""), bundleId: String(bundleId || ""), source });
    if (existing) entries.splice(entries.indexOf(existing), 1);
    entries.unshift(entry);
    await this.#trim();
    await this.#save();
    return entry;
  }

  // An image as PNG bytes; the same image copied again moves to the top.
  async addImage({ png, width = 0, height = 0, app = "", bundleId = "", text = "" }) {
    if (!png?.length) return null;
    const entries = await this.#load();
    const hash = crypto.createHash("sha256").update(png).digest("hex").slice(0, 32);
    const existing = entries.find((entry) => entry.kind === "image" && entry.hash === hash);
    if (existing) {
      Object.assign(existing, { at: this.now(), app: String(app || ""), bundleId: String(bundleId || "") });
      entries.splice(entries.indexOf(existing), 1);
      entries.unshift(existing);
      await this.#save();
      return existing;
    }
    await fs.mkdir(this.imagesDir, { recursive: true, mode: 0o700 });
    const image = `${hash}.png`;
    await fs.writeFile(path.join(this.imagesDir, image), png, { mode: 0o600 });
    const entry = { id: crypto.randomUUID(), kind: "image", text: String(text || "").slice(0, MAX_TEXT), image, hash, width, height, at: this.now(), app: String(app || ""), bundleId: String(bundleId || ""), source: "copy" };
    entries.unshift(entry);
    await this.#trim();
    await this.#save();
    return entry;
  }

  async #trim() {
    const entries = await this.#load();
    const keep = [];
    const drop = [];
    let images = 0;
    for (const entry of entries) {
      const tooMany = keep.length >= MAX_ENTRIES || (entry.kind === "image" && images >= MAX_IMAGES);
      if (tooMany && !entry.pinned) drop.push(entry);
      else {
        keep.push(entry);
        if (entry.kind === "image") images += 1;
      }
    }
    this.entries = keep;
    await this.#dropImages(drop);
  }

  // Forgets unpinned items older than the given number of days (0 keeps everything).
  async prune(days) {
    if (!days) return 0;
    const entries = await this.#load();
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const drop = entries.filter((entry) => !entry.pinned && entry.at < cutoff);
    if (!drop.length) return 0;
    this.entries = entries.filter((entry) => !drop.includes(entry));
    await this.#dropImages(drop);
    await this.#save();
    return drop.length;
  }

  // Pinned first, then newest. Every word in the query must appear in the text or the app's name.
  async list({ query = "", kind = "", limit = 300 } = {}) {
    const entries = await this.#load();
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const matches = entries.filter((entry) => {
      if (kind === "pinned" ? !entry.pinned : kind && entry.kind !== kind && !(kind === "text" && ["qr", "barcode"].includes(entry.kind))) return false;
      const haystack = `${entry.text} ${entry.app}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    const ordered = [...matches.filter((entry) => entry.pinned), ...matches.filter((entry) => !entry.pinned)];
    return { entries: ordered.slice(0, limit), total: entries.length };
  }

  async get(id) {
    return (await this.#load()).find((entry) => entry.id === id) || null;
  }

  // Moves an item to the top after it's pasted again.
  async touch(id) {
    const entries = await this.#load();
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return null;
    entry.at = this.now();
    entries.splice(entries.indexOf(entry), 1);
    entries.unshift(entry);
    await this.#save();
    return entry;
  }

  async pin(id, pinned) {
    const entry = await this.get(id);
    if (!entry) return null;
    if (pinned) entry.pinned = true;
    else delete entry.pinned;
    await this.#save();
    return entry;
  }

  async remove(id) {
    const entries = await this.#load();
    const drop = entries.filter((entry) => entry.id === id);
    this.entries = entries.filter((entry) => entry.id !== id);
    await this.#dropImages(drop);
    await this.#save();
  }

  // Clears everything except pinned items, unless everything is asked for.
  async clear({ includePinned = false } = {}) {
    const entries = await this.#load();
    const drop = entries.filter((entry) => includePinned || !entry.pinned);
    this.entries = entries.filter((entry) => !drop.includes(entry));
    await this.#dropImages(drop);
    await this.#save();
  }
}

module.exports = { ClipboardHistory, kindOf };
