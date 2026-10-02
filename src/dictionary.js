// Your words: names and jargon that speech recognition gets wrong. Each entry can list what it's
// often heard as, and those are corrected on this Mac. The words are also given to the AI
// (dictation cleanup, meeting notes) so it spells them as written.

const MAX_ENTRIES = 300;

function cleanTerm(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function normalizeDictionary(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const term = cleanTerm(entry?.term);
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const heardAs = [...new Set((Array.isArray(entry.heardAs) ? entry.heardAs : String(entry.heardAs || "").split(","))
      .map(cleanTerm)
      .filter((variant) => variant && variant.toLowerCase() !== term.toLowerCase()))].slice(0, 12);
    result.push({ term, heardAs });
  }
  return result.slice(0, MAX_ENTRIES);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

// Whole words only, so "Al" never rewrites "also".
function wordPattern(phrase) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(phrase)}(?![\\p{L}\\p{N}])`, "giu");
}

/** Replaces misheard variants with the right word, and fixes the case of the word itself. */
function applyDictionary(text, entries = []) {
  let result = String(text || "");
  if (!result || !entries.length) return result;
  // Longer phrases first, so "harry mall" is fixed before "harry".
  const rules = entries
    .flatMap(({ term, heardAs = [] }) => [...heardAs.map((variant) => [variant, term]), [term, term]])
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of rules) result = result.replace(wordPattern(from), to);
  return result;
}

// A line for AI prompts: "Spell these names and terms exactly as written: …"
function vocabularyHint(terms = []) {
  const list = [...new Set(terms.map(cleanTerm).filter(Boolean))].slice(0, 150);
  return list.length ? `Spell these names and terms exactly as written: ${list.join(", ")}.` : "";
}

module.exports = { applyDictionary, normalizeDictionary, vocabularyHint };
