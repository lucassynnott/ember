// Names the notes AI thinks speech recognition got wrong in a call ("Fonon" for Phonon), offered in
// Settings → Dictionary so the next call gets them right. Kept on this Mac; nothing is added until
// the user says so.
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_SUGGESTIONS = 30;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

// Only keeps spellings that really are in the transcript, so the AI can't suggest words nobody said.
function checkMisheard(items, transcript) {
  const text = String(transcript || "");
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const term = clean(item?.term);
    if (!term || term.split(" ").length > 4) continue;
    const heardAs = [...new Set((Array.isArray(item?.heardAs) ? item.heardAs : [item?.heardAs]).map(clean))].filter(
      (variant) => variant && variant.toLowerCase() !== term.toLowerCase() && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(variant)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text),
    );
    if (heardAs.length) result.push({ term, heardAs: heardAs.slice(0, 6) });
  }
  return result.slice(0, 5);
}

class DictionarySuggestions {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async #load() {
    if (this.data) return this.data;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.data = { suggestions: Array.isArray(data.suggestions) ? data.suggestions : [], dismissed: Array.isArray(data.dismissed) ? data.dismissed : [] };
    } catch {
      this.data = { suggestions: [], dismissed: [] };
    }
    return this.data;
  }

  #save() {
    this.queue = this.queue
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(`${this.filePath}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
        await fs.rename(`${this.filePath}.tmp`, this.filePath);
      })
      .catch(() => {});
    return this.queue;
  }

  // Adds a call's suggestions, skipping words already in the dictionary or dismissed before.
  async add(items, { meeting = "", dictionary = [] } = {}) {
    const data = await this.#load();
    const known = new Set(dictionary.map((entry) => entry.term.toLowerCase()));
    const dismissed = new Set(data.dismissed);
    let added = 0;
    for (const item of items) {
      const key = item.term.toLowerCase();
      if (known.has(key) || dismissed.has(key)) continue;
      const existing = data.suggestions.find((suggestion) => suggestion.term.toLowerCase() === key);
      if (existing) {
        existing.heardAs = [...new Set([...existing.heardAs, ...item.heardAs])].slice(0, 12);
        existing.calls = (existing.calls || 1) + 1;
        existing.meeting = meeting || existing.meeting;
      } else {
        data.suggestions.unshift({ term: item.term, heardAs: item.heardAs, meeting, calls: 1 });
      }
      added += 1;
    }
    data.suggestions = data.suggestions.slice(0, MAX_SUGGESTIONS);
    if (added) await this.#save();
    return added;
  }

  async list() {
    return (await this.#load()).suggestions;
  }

  // Removes it from the list; "dismiss" also stops it being suggested again.
  async take(term, { dismiss = false } = {}) {
    const data = await this.#load();
    const key = String(term || "").toLowerCase();
    const found = data.suggestions.find((suggestion) => suggestion.term.toLowerCase() === key) || null;
    data.suggestions = data.suggestions.filter((suggestion) => suggestion.term.toLowerCase() !== key);
    if (dismiss && key && !data.dismissed.includes(key)) data.dismissed = [...data.dismissed, key].slice(-500);
    await this.#save();
    return found;
  }
}

module.exports = { DictionarySuggestions, checkMisheard };
