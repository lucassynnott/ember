// Everything you've dictated (and rewritten with Edit by voice), kept on this Mac so you can find
// and copy it again. Settings → Dictation can turn it off or clear it.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { wordCount } = require("./stats");

const MAX_ENTRIES = 1000;

class DictationHistory {
  constructor(filePath) {
    this.filePath = filePath;
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

  async add({ text, app = "", kind = "dictation", instruction = "", at = Date.now() }) {
    const clean = String(text || "").trim();
    if (!clean) return null;
    const entries = await this.#load();
    const entry = { id: crypto.randomUUID(), at, app: String(app || ""), kind, text: clean.slice(0, 20000), words: wordCount(clean) };
    if (instruction) entry.instruction = String(instruction).slice(0, 300);
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    await this.#save();
    return entry;
  }

  // Newest first; every word in the query must appear in the text, app or instruction.
  async list({ query = "", limit = 300 } = {}) {
    const entries = await this.#load();
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const matches = words.length
      ? entries.filter((entry) => {
          const haystack = `${entry.text} ${entry.app} ${entry.instruction || ""}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
      : entries;
    return { entries: matches.slice(0, limit), total: entries.length };
  }

  async get(id) {
    return (await this.#load()).find((entry) => entry.id === id) || null;
  }

  async remove(id) {
    this.entries = (await this.#load()).filter((entry) => entry.id !== id);
    await this.#save();
  }

  async clear() {
    this.entries = [];
    await this.#save();
  }
}

module.exports = { DictationHistory };
