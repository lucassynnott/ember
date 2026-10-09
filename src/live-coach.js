// Live coaching on how you're coming across, worked out on this Mac from the call's transcript as it arrives:
// talking too long or too much, too fast, filler words, a question left hanging, going a long while without asking
// one, and the other side going quiet. No AI and nothing sent anywhere; a cue is a few words on the coach chip.

const FILLERS = /\b(um+|uh+|uhm|er+m?|ah+|you know|i mean|sort of|kind of|basically)\b/gi;
const MINUTE = 60;

/** The thresholds; your weekly focus makes the one it's about a little stricter. */
const RULES = {
  monologue: { seconds: 90 },
  talkShare: { share: 0.65, window: 5 * MINUTE, after: 3 * MINUTE },
  pace: { wpm: 185, window: 30 },
  fillers: { count: 5, window: MINUTE },
  unanswered: { seconds: 8 },
  noQuestions: { window: 10 * MINUTE, after: 8 * MINUTE },
  shortAnswers: { ratio: 0.4, recent: 3, earlier: 4 },
};
const FOCUS_RULES = {
  "talk-less": { monologue: { seconds: 60 }, talkShare: { share: 0.55 } },
  "slow-down": { pace: { wpm: 170 } },
  "fewer-fillers": { fillers: { count: 3 } },
  "ask-more": { noQuestions: { window: 6 * MINUTE, after: 5 * MINUTE } },
};

/** Each cue at most once in this long, and any cue at most this often. */
const COOLDOWN = 5 * MINUTE;
const GAP = 45;

const words = (text) => String(text || "").split(/\s+/).filter(Boolean);
const isQuestion = (text) => /\?\s*$/.test(String(text || "").trim()) || /\?["')\]]?\s*$/.test(String(text || "").trim());

function rulesFor(focus) {
  const extra = FOCUS_RULES[focus] || {};
  return Object.fromEntries(Object.entries(RULES).map(([key, rule]) => [key, { ...rule, ...(extra[key] || {}) }]));
}

class LiveCoach {
  /** @param focus your weekly focus ("talk-less", "slow-down", "fewer-fillers", "ask-more"), if any */
  /** @param cues the cue ids this coach mode uses (all of them when not given) */
  constructor({ focus = null, cues = null } = {}) {
    this.cues = cues ? new Set(cues) : null;
    this.rules = rulesFor(focus);
    this.focus = focus;
    this.lastCue = -Infinity;
    this.lastBy = new Map();
  }

  setFocus(focus) {
    this.focus = focus;
    this.rules = rulesFor(focus);
  }

  /**
   * The cue to show now, if any, from the call's segments ({ text, you, start, end } in seconds from its start) and
   * the time now (seconds from its start).
   * @returns {{ id: string, text: string, tone: "delivery" | "room" } | null}
   */
  check(segments, now) {
    if (now - this.lastCue < GAP) return null;
    const timed = segments.filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end));
    for (const cue of [this.#unanswered(timed, now), this.#monologue(timed, now), this.#pace(timed, now), this.#fillers(timed, now), this.#talkShare(timed, now), this.#shortAnswers(timed), this.#noQuestions(timed, now)]) {
      if (!cue || (this.cues && !this.cues.has(cue.id))) continue;
      if (now - (this.lastBy.get(cue.id) ?? -Infinity) < COOLDOWN) continue;
      this.lastBy.set(cue.id, now);
      this.lastCue = now;
      return cue;
    }
    return null;
  }

  /** They asked you something and you haven't started answering. */
  #unanswered(segments, now) {
    const last = segments.at(-1);
    if (!last || last.you || !isQuestion(last.text)) return null;
    if (now - last.end < this.rules.unanswered.seconds) return null;
    const question = String(last.text).trim().split(/(?<=[.!?])\s+/).filter(isQuestion).at(-1) || last.text;
    return { id: "unanswered", tone: "room", text: `They asked: “${question.slice(0, 90)}”` };
  }

  /** You've been talking a long while without a break from them. */
  #monologue(segments, now) {
    let start = null;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (!segment.you) break;
      start = segment.start;
    }
    if (start === null || now - start < this.rules.monologue.seconds) return null;
    return { id: "monologue", tone: "delivery", text: "You've been talking a while. Pause and check in." };
  }

  /** Words a minute over the last half a minute of yours. */
  #pace(segments, now) {
    const { wpm, window } = this.rules.pace;
    const mine = segments.filter((segment) => segment.you && segment.end > now - window);
    const seconds = mine.reduce((sum, segment) => sum + Math.max(0, Math.min(segment.end, now) - Math.max(segment.start, now - window)), 0);
    if (seconds < 15) return null;
    const count = mine.reduce((sum, segment) => sum + words(segment.text).length * (Math.max(0, Math.min(segment.end, now) - Math.max(segment.start, now - window)) / Math.max(0.1, segment.end - segment.start)), 0);
    return (count / seconds) * MINUTE > wpm ? { id: "pace", tone: "delivery", text: "You're speaking quickly. Slow down a touch." } : null;
  }

  #fillers(segments, now) {
    const { count, window } = this.rules.fillers;
    const text = segments.filter((segment) => segment.you && segment.end > now - window).map((segment) => segment.text).join(" ");
    return (text.match(FILLERS) || []).length >= count ? { id: "fillers", tone: "delivery", text: "Lots of “um”s. A short pause works better." } : null;
  }

  /** Your share of the talking over the last few minutes. */
  #talkShare(segments, now) {
    const { share, window, after } = this.rules.talkShare;
    if (now < after) return null;
    let yours = 0;
    let theirs = 0;
    for (const segment of segments) {
      const overlap = Math.max(0, Math.min(segment.end, now) - Math.max(segment.start, now - window));
      if (segment.you) yours += overlap;
      else theirs += overlap;
    }
    if (yours + theirs < 60) return null;
    return yours / (yours + theirs) > share ? { id: "talk-share", tone: "delivery", text: `You've done ${Math.round((yours / (yours + theirs)) * 100)}% of the talking lately. Ask them something.` } : null;
  }

  /** You haven't asked a question in a while. */
  #noQuestions(segments, now) {
    const { window, after } = this.rules.noQuestions;
    if (now < after) return null;
    const recent = segments.filter((segment) => segment.end > now - window);
    if (!recent.some((segment) => segment.you)) return null;
    return recent.some((segment) => segment.you && String(segment.text).includes("?")) ? null : { id: "no-questions", tone: "delivery", text: "No questions from you for a while. Ask one." };
  }

  /** Their answers getting much shorter than earlier in the call: interest or patience may be dropping. */
  #shortAnswers(segments) {
    const { ratio, recent, earlier } = this.rules.shortAnswers;
    const theirs = segments.filter((segment) => !segment.you).map((segment) => words(segment.text).length);
    if (theirs.length < recent + earlier) return null;
    const average = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
    const before = average(theirs.slice(0, -recent).slice(-12));
    const now = average(theirs.slice(-recent));
    return before >= 12 && now < before * ratio ? { id: "short-answers", tone: "room", text: "Their answers are getting short. Ask what's on their mind." } : null;
  }
}

module.exports = { LiveCoach, RULES, FOCUS_RULES, isQuestion };
