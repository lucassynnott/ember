// The knowledge base: folders of your own documents (sales playbooks, tutorials, product notes) that
// Ask, prep cards and live help can draw on. Text is extracted and indexed on this Mac; only the
// passages that match a question are sent to the AI with it.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { terms } = require("./ask");

const TEXT_TYPES = new Set([".md", ".markdown", ".txt", ".text", ".csv", ".json", ".vtt", ".srt", ".yaml", ".yml", ".org", ".rst"]);
const CONVERTED_TYPES = new Set([".docx", ".doc", ".rtf", ".rtfd", ".html", ".htm", ".odt", ".webarchive", ".pages"]);
const PDF_TYPES = new Set([".pdf"]);
const SKIP_FOLDERS = new Set(["node_modules", ".git", ".obsidian", ".trash", "Library"]);
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const CHUNK_CHARS = 1100;

// Light stemming so "close", "closing" and "closed" match, and "objections" finds "objection".
function stem(word) {
  return word.length > 4 ? word.replace(/(ings|ing|ed|es|e|s|ly)$/, "") : word;
}

function stems(text) {
  return terms(text).map(stem);
}

function supported(name) {
  const extension = path.extname(name).toLowerCase();
  return TEXT_TYPES.has(extension) || CONVERTED_TYPES.has(extension) || PDF_TYPES.has(extension);
}

function run(binary, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

// Subtitles keep only the spoken lines.
function cleanSubtitles(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !/-->/.test(line) && !/^WEBVTT/.test(line))
    .join("\n");
}

/** Splits text into passages of whole paragraphs, each led by the nearest heading above it. */
function chunkText(text, maxChars = CHUNK_CHARS) {
  const chunks = [];
  let heading = "";
  let current = [];
  let size = 0;
  const flush = () => {
    const body = current.join("\n\n").trim();
    if (body) chunks.push(heading && !/^#{1,4}\s/.test(body) ? `${heading}\n${body}` : body);
    current = [];
    size = 0;
  };
  for (const raw of String(text).split(/\n\s*\n/)) {
    const paragraph = raw.replace(/[ \t]+/g, " ").trim();
    if (!paragraph) continue;
    const headingMatch = /^#{1,4}\s+(.+)$/.exec(paragraph.split("\n")[0]);
    if (headingMatch) {
      flush();
      heading = headingMatch[1].trim();
    }
    if (size + paragraph.length > maxChars && current.length) flush();
    // A single very long paragraph is cut at sentence ends.
    if (paragraph.length > maxChars) {
      for (const piece of paragraph.match(new RegExp(`[\\s\\S]{1,${maxChars}}(?:[.!?](?=\\s)|$)`, "g")) || [paragraph]) {
        current.push(piece.trim());
        flush();
      }
      continue;
    }
    current.push(paragraph);
    size += paragraph.length;
  }
  flush();
  return chunks;
}

class KnowledgeBase {
  constructor({ indexPath, pdfHelper = null, readPdf = null, convert = (file) => run("/usr/bin/textutil", ["-convert", "txt", "-stdout", file]) }) {
    this.indexPath = indexPath;
    this.pdfHelper = pdfHelper;
    this.readPdf = readPdf;
    this.convert = convert;
    this.data = { files: {}, indexedAt: null, errors: [] };
    this.loaded = false;
    this.stats = null;
    this.indexing = null;
  }

  async load() {
    if (this.loaded) return this;
    try {
      this.data = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
      this.data.files ||= {};
      this.data.errors ||= [];
    } catch {
      // No index yet.
    }
    this.loaded = true;
    this.stats = null;
    return this;
  }

  async #extract(file) {
    const extension = path.extname(file).toLowerCase();
    if (PDF_TYPES.has(extension)) {
      if (this.readPdf) return this.readPdf(file);
      if (!this.pdfHelper) throw new Error("PDF reading isn't available.");
      return run(this.pdfHelper, [file], 60_000);
    }
    if (CONVERTED_TYPES.has(extension)) return this.convert(file);
    const text = await fs.readFile(file, "utf8");
    return extension === ".vtt" || extension === ".srt" ? cleanSubtitles(text) : text;
  }

  async #walk(folder, found) {
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_FOLDERS.has(entry.name) && !entry.name.endsWith(".app")) await this.#walk(full, found);
      } else if (entry.isFile() && supported(entry.name)) {
        found.push(full);
      }
    }
  }

  /** Re-reads the folders, extracting only files that changed since last time. */
  index(folders, { onProgress = () => {} } = {}) {
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      await this.load();
      const files = [];
      for (const folder of folders) await this.#walk(folder, files);
      const next = {};
      const errors = [];
      let done = 0;
      for (const file of files) {
        done += 1;
        if (done % 10 === 0) onProgress({ done, total: files.length });
        try {
          const stat = await fs.stat(file);
          if (stat.size > MAX_FILE_BYTES) continue;
          const cached = this.data.files[file];
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            next[file] = cached;
            continue;
          }
          const text = (await this.#extract(file)).slice(0, MAX_TEXT_CHARS);
          const chunks = chunkText(text);
          if (chunks.length) next[file] = { mtimeMs: stat.mtimeMs, size: stat.size, chunks };
        } catch (error) {
          errors.push({ file, error: String(error.message || error).split("\n")[0].slice(0, 200) });
        }
      }
      this.data = { files: next, indexedAt: Date.now(), errors: errors.slice(0, 50), folders };
      this.stats = null;
      await fs.mkdir(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(`${this.indexPath}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
      await fs.rename(`${this.indexPath}.tmp`, this.indexPath);
      onProgress({ done: files.length, total: files.length });
      return { ...this.status(), indexing: false };
    })().finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }

  status() {
    const files = Object.values(this.data.files);
    return {
      files: files.length,
      passages: files.reduce((sum, file) => sum + file.chunks.length, 0),
      indexedAt: this.data.indexedAt,
      errors: this.data.errors || [],
      indexing: Boolean(this.indexing),
    };
  }

  // Term statistics for ranking, rebuilt after each index.
  #statistics() {
    if (this.stats) return this.stats;
    const passages = [];
    const documentFrequency = new Map();
    for (const [file, entry] of Object.entries(this.data.files)) {
      entry.chunks.forEach((text, index) => {
        const set = new Set(stems(text));
        for (const term of set) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
        passages.push({ file, index, text, terms: set });
      });
    }
    this.stats = { passages, documentFrequency };
    return this.stats;
  }

  /** The passages that best match a question, for an AI prompt. */
  search(query, { limit = 8, maxChars = 9000 } = {}) {
    const wanted = [...new Set(stems(query))];
    if (!wanted.length) return [];
    const { passages, documentFrequency } = this.#statistics();
    const total = passages.length || 1;
    const ranked = passages
      .map((passage) => {
        let score = 0;
        for (const term of wanted) {
          if (passage.terms.has(term)) score += Math.log(1 + total / (documentFrequency.get(term) || 1));
        }
        // File names are a strong hint: "objection-handling.md" for an objection question.
        const name = path.basename(passage.file).toLowerCase();
        for (const term of wanted) if (name.includes(term)) score += 1.5;
        return { ...passage, score };
      })
      .filter((passage) => passage.score > 0)
      .sort((a, b) => b.score - a.score);
    const results = [];
    let chars = 0;
    for (const passage of ranked) {
      if (results.length >= limit || chars + passage.text.length > maxChars) break;
      results.push({ file: passage.file, name: path.basename(passage.file), text: passage.text });
      chars += passage.text.length;
    }
    return results;
  }
}

/** Numbers passages as [[kb:1]], [[kb:2]]… for a prompt, and returns the map for the app. */
function knowledgeBlock(passages) {
  if (!passages.length) return { text: "", sources: {} };
  const sources = {};
  const blocks = passages.map((passage, index) => {
    const id = `kb:${index + 1}`;
    sources[id] = { file: passage.file, name: passage.name };
    return `[[${id}]] from "${passage.name}"\n${passage.text}`;
  });
  return { text: `<knowledge_base>\n${blocks.join("\n\n")}\n</knowledge_base>`, sources };
}

module.exports = { KnowledgeBase, chunkText, knowledgeBlock, supported };
