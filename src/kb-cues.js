// Instant cues from your knowledge base: when the other side mentions pricing, a competitor, an objection, security
// or timing, the matching passage from your own playbooks shows straight away, worked out on this Mac without the AI.
// Only strong matches show, and each passage at most once every few minutes.
const { terms } = require("./ask");

const TRIGGERS = [
  { id: "pricing", label: "Pricing", pattern: /\b(pric(e|es|ing|ed)|cost(s|ly)?|expensive|cheaper|discount|quote|per seat|per user|budget|afford)\b/i, query: "pricing price cost discount" },
  { id: "timing", label: "Timing objection", pattern: /\b(not (the )?right time|next (quarter|year)|too busy|revisit (this|it)? ?later|circle back|not a priority|on hold)\b/i, query: "objection timing not right time priority" },
  { id: "status-quo", label: "Already have something", pattern: /\b(already (use|have|using)|happy with (what|our)|current (tool|vendor|provider|solution)|built (it|our own) in.?house)\b/i, query: "objection already use current solution switching" },
  { id: "think", label: "Stalling", pattern: /\b(think (it|this) over|need to think|send me (some|more)? ?(info|information|something|details)|let me get back to you)\b/i, query: "objection think about it send information stall" },
  { id: "authority", label: "Someone else decides", pattern: /\b(talk to|check with|run it by|loop in) (my|our|the) (boss|manager|team|cfo|ceo|cto|founder|partner|legal|procurement)\b/i, query: "objection decision maker approval stakeholder" },
  { id: "security", label: "Security", pattern: /\b(security|secure|soc ?2|gdpr|hipaa|iso ?27001|compliance|privacy|data (protection|residency)|encrypt(ed|ion)?)\b/i, query: "security compliance privacy data" },
  { id: "contract", label: "Contract terms", pattern: /\b(contract|cancel(lation)?|lock.?in|annual (commitment|plan)|refund|trial|pilot)\b/i, query: "contract terms trial pilot cancellation" },
];

// A passage has to be about the thing, not merely mention a word of it.
const MIN_COVERAGE = 0.34;
const PASSAGE_COOLDOWN_MS = 6 * 60_000;
const TRIGGER_COOLDOWN_MS = 3 * 60_000;
const COMPETITOR_FILES = /(competitor|competition|battle.?card|\bvs\b|versus|alternatives?)/i;

function sentences(text) {
  return String(text)
    .replace(/^#{1,4}\s+/gm, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 3);
}

/** The heading and the two sentences of a passage most about what was said, for a glanceable card. */
function excerpt(text, query, maxChars = 280) {
  const lines = sentences(text);
  if (!lines.length) return "";
  const wanted = new Set(terms(query));
  const heading = /^#{1,4}\s/.test(String(text).trim()) || !/[.!?]$/.test(lines[0]) ? lines[0] : null;
  const body = heading ? lines.slice(1) : lines;
  const best = body
    .map((line, index) => ({ line, index, score: terms(line).filter((term) => wanted.has(term)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.line)
    .join(" ");
  const out = best || lines.join(" ");
  return out.length > maxChars ? `${out.slice(0, maxChars - 1).replace(/\s+\S*$/, "")}…` : out;
}

class KnowledgeCues {
  /**
   * @param search the knowledge base's search ((query, options) => passages with score and coverage)
   * @param competitors names to watch for: your own list plus headings from competitor and battlecard files
   */
  /** @param only the trigger ids this coach mode uses ("competitor" for names), or all when not given */
  constructor({ search, competitors = [], now = Date.now, only = null }) {
    this.only = only ? new Set(only) : null;
    this.search = search;
    this.now = now;
    this.competitors = [...new Set(competitors.map((name) => String(name).trim()).filter((name) => name.length >= 2))];
    this.shown = new Map();
    this.fired = new Map();
  }

  /** Competitor names from the base's file names and headings (from files about competitors) plus your list. */
  static competitorsFrom(topics, own = []) {
    const names = [...own];
    for (const [topic, file] of topics || []) {
      if (!COMPETITOR_FILES.test(file)) continue;
      // "Gong" or "Us vs Gong" → "Gong"; skip generic headings.
      const name = String(topic).replace(/^.*\b(vs\.?|versus)\s+/i, "").replace(/[-_]/g, " ").trim();
      if (name && name.split(/\s+/).length <= 3 && !COMPETITOR_FILES.test(name) && !/^(overview|summary|pricing|intro(duction)?|notes?)$/i.test(name)) names.push(name);
    }
    return names;
  }

  /** What in their latest turn is worth a cue: competitor names first, then the trigger topics. */
  triggers(text) {
    const found = [];
    const on = (id) => !this.only || this.only.has(id);
    for (const name of on("competitor") ? this.competitors : []) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) found.push({ id: `competitor:${name.toLowerCase()}`, label: name, query: `${name} competitor comparison` });
    }
    for (const trigger of TRIGGERS) if (on(trigger.id) && trigger.pattern.test(text)) found.push(trigger);
    return found;
  }

  /**
   * A cue for the other side's latest turn, or null. Returns the passage's file for the card's source link.
   * @returns {{ id: string, title: string, text: string, file: string, name: string } | null}
   */
  check(text) {
    const time = this.now();
    for (const trigger of this.triggers(String(text || ""))) {
      if (time - (this.fired.get(trigger.id) ?? -Infinity) < TRIGGER_COOLDOWN_MS) continue;
      const results = this.search(`${trigger.query} ${String(text).slice(-400)}`, { limit: 3, maxChars: 4000, prefer: ["playbook", "objection", "battlecard", "pricing", "competitor", "faq", "security"] });
      const passage = results.find((result) => {
        const key = `${result.file}|${result.text.slice(0, 80)}`;
        const named = trigger.id.startsWith("competitor:") && result.text.toLowerCase().includes(trigger.label.toLowerCase());
        return (named || (result.coverage ?? 0) >= MIN_COVERAGE) && time - (this.shown.get(key) ?? -Infinity) >= PASSAGE_COOLDOWN_MS;
      });
      if (!passage) continue;
      this.fired.set(trigger.id, time);
      this.shown.set(`${passage.file}|${passage.text.slice(0, 80)}`, time);
      return { id: trigger.id, title: trigger.label, text: excerpt(passage.text, `${trigger.query} ${text}`), file: passage.file, name: passage.name };
    }
    return null;
  }
}

module.exports = { KnowledgeCues, TRIGGERS, excerpt };
