// The coach for one call: brings together the delivery cues (on this Mac), the call's goal and checklist, instant
// cues from your knowledge base, and time nudges from the calendar, into one state for the coach chip and the
// live view. The AI is only used for suggesting the goal and ticking off the checklist, both grounded in your
// knowledge base. Main feeds it transcript segments and a tick every few seconds.
const { EventEmitter } = require("node:events");
const { LiveCoach, isQuestion } = require("./live-coach");
const { KnowledgeCues, TRIGGERS } = require("./kb-cues");
const { knowledgeBlock, PLAYBOOK_WORDS } = require("./knowledge");
const { frameworkFor, modeFor, modePrompt } = require("./coach-modes");
const { checklistFor, coverageMessages, goalMessages, knowledgeQuery, minutesLeft, parseCoverage, parseGoal, timeNudge } = require("./call-goals");

// The checklist is re-read at most this often, and only after this many new words.
const COVERAGE_EVERY_MS = { cloud: 75_000, local: 150_000 };
const COVERAGE_MIN_WORDS = 60;
// A cue stays on the chip this long.
const CUE_MS = 12_000;
// The goal is suggested once there's a calendar event, or after this much of the call without one.
const GOAL_WITHOUT_CALENDAR_MS = 90_000;
const OBJECTION = new RegExp(TRIGGERS.filter((trigger) => trigger.id !== "pricing" && trigger.id !== "security" && trigger.id !== "contract").map((trigger) => trigger.pattern.source).join("|"), "i");

class CallCoach extends EventEmitter {
  /**
   * @param ai (system, user) => the model's reply text, or null when there's no AI
   * @param search the knowledge base's search, or null when it's off; only local folders, never MCP sources
   */
  constructor({ startedAt, settings, search = null, ai = null, earlier = async () => [], topics = null, focus = null, local = false, now = Date.now }) {
    super();
    this.startedAt = startedAt;
    this.settings = settings;
    this.search = search;
    this.ai = ai;
    this.earlier = earlier;
    this.now = now;
    this.local = local;
    this.focus = focus;
    this.mode = modeFor(settings.coachMode);
    this.live = new LiveCoach({ focus: focus?.id || null, cues: this.mode.cues });
    const competitors = String(settings.coachCompetitors || "").split(/[,\n]/);
    this.cues = search ? new KnowledgeCues({ search, competitors: KnowledgeCues.competitorsFrom(topics, competitors), now, only: this.mode.knowledge }) : null;
    this.calendar = null;
    this.goal = null;
    const start = frameworkFor(this.mode, settings.coachFramework || "auto", settings.coachChecklist);
    this.framework = start.framework;
    this.customChecklist = start.checklist;
    this.items = checklistFor(this.framework, this.customChecklist);
    this.covered = [];
    this.next = null;
    this.cue = null;
    this.timeSent = new Set();
    this.coverageAt = 0;
    this.coverageWords = 0;
    this.busy = { goal: false, coverage: false };
    this.goalAsked = false;
    this.ended = false;
  }

  /** What the chip and the live view show. */
  state() {
    const left = minutesLeft(this.calendar, this.now());
    return {
      goal: this.goal,
      framework: this.framework,
      items: this.items.map((item) => ({ ...item, done: this.covered.includes(item.id) })),
      next: this.next,
      cue: this.cue && this.now() - this.cue.at < CUE_MS ? this.cue : null,
      minutesLeft: left === null ? null : Math.max(0, Math.round(left)),
      focus: this.focus ? { id: this.focus.id, label: this.focus.label } : null,
      mode: { id: this.mode.id, label: this.mode.label },
      enabled: { goals: this.settings.callGoals !== false, cues: this.settings.coachCues !== false },
    };
  }

  #changed() {
    if (!this.ended) this.emit("state", this.state());
  }

  #showCue(cue) {
    this.cue = { ...cue, at: this.now() };
    this.emit("cue", this.cue);
    this.#changed();
  }

  setCalendar(event) {
    this.calendar = event;
    this.#changed();
    void this.suggestGoal();
  }

  /** The week's focus, which tightens the cue it's about. */
  setFocus(focus) {
    this.focus = focus;
    this.live.setFocus(focus?.id || null);
    this.#changed();
  }

  setGoal(text) {
    const goal = String(text || "").trim().slice(0, 120);
    this.goal = goal ? { text: goal, why: "", source: "you", cite: [], sources: {} } : null;
    this.#changed();
  }

  setFramework(id, custom = this.customChecklist) {
    this.framework = id;
    this.items = checklistFor(id, custom);
    this.covered = this.covered.filter((covered) => this.items.some((item) => item.id === covered));
    this.#changed();
  }

  toggleItem(id) {
    this.covered = this.covered.includes(id) ? this.covered.filter((item) => item !== id) : [...this.covered, id];
    this.#changed();
  }

  #knowledge(query, limit = 5) {
    if (!this.search) return { text: "", sources: {} };
    return knowledgeBlock(this.search(query, { limit, maxChars: 5000, prefer: PLAYBOOK_WORDS }));
  }

  /** Suggests the call's goal from the calendar, earlier calls and your playbooks. */
  async suggestGoal(segments = []) {
    if (this.goalAsked || this.goal || !this.ai || this.settings.callGoals === false) return;
    this.goalAsked = true;
    this.busy.goal = true;
    try {
      const transcript = segments.map((segment) => `${segment.you ? "Me" : "Them"}: ${segment.text}`).join("\n");
      const knowledge = this.#knowledge(`${this.calendar?.title || ""} call goal agenda playbook process next step ${transcript.slice(-600)}`, 4);
      const [system, user] = goalMessages({ calendar: this.calendar, earlier: await this.earlier(), knowledge: knowledge.text, framework: this.framework, speakerName: this.settings.speakerName, transcript, coaching: modePrompt(this.mode, "goal") });
      const goal = parseGoal(await this.ai(system.content, user.content));
      if (!goal || this.goal || this.ended) return;
      this.goal = { text: goal.goal, why: goal.why, source: "suggested", cite: goal.cite, sources: Object.fromEntries(Object.entries(knowledge.sources).filter(([id]) => goal.cite.includes(id))) };
      // Modes with their own checklist keep it; the others take the framework that fits the call.
      if (this.settings.coachFramework === "auto" && this.mode.framework !== "custom" && goal.framework && goal.framework !== this.framework) this.setFramework(goal.framework);
      this.#changed();
    } catch (error) {
      this.goalAsked = false;
      this.emit("error", error);
    } finally {
      this.busy.goal = false;
    }
  }

  /**
   * A new line of the call. Runs the instant checks, and returns what main should do with it:
   * `tip` when they've just asked something or pushed back (the moment for a tip, rather than the timer).
   */
  onSegment(segments) {
    const last = segments.at(-1);
    if (!last || this.ended) return {};
    const at = (this.now() - this.startedAt) / 1000;
    if (this.settings.coachCues !== false) {
      const cue = this.live.check(segments, at);
      if (cue) this.#showCue(cue);
    }
    let knowledgeCue = null;
    if (!last.you && this.cues && this.settings.knowledgeCues !== false) knowledgeCue = this.cues.check(last.text);
    if (!this.goal && !this.calendar && this.now() - this.startedAt > GOAL_WITHOUT_CALENDAR_MS) void this.suggestGoal(segments);
    const tip = !last.you && (isQuestion(last.text) || OBJECTION.test(last.text)) ? (isQuestion(last.text) ? "question" : "objection") : null;
    return { knowledgeCue, tip };
  }

  /** Every few seconds: time-based cues (a question left hanging), time nudges, and the checklist now and then. */
  async tick(segments, words) {
    if (this.ended) return;
    const at = (this.now() - this.startedAt) / 1000;
    if (this.settings.coachCues !== false) {
      const cue = this.live.check(segments, at);
      if (cue) this.#showCue(cue);
    }
    if (this.settings.callGoals !== false) {
      const nudge = timeNudge({ items: this.items, covered: this.covered, left: minutesLeft(this.calendar, this.now()), sent: this.timeSent });
      if (nudge) this.#showCue({ ...nudge, tone: "time" });
    }
    if (this.cue && this.now() - this.cue.at >= CUE_MS && !this.cue.cleared) {
      this.cue.cleared = true;
      this.#changed();
    }
    await this.#updateCoverage(segments, words);
  }

  async #updateCoverage(segments, words) {
    if (!this.ai || this.busy.coverage || this.settings.callGoals === false || !this.items.length) return;
    if (this.now() - this.coverageAt < COVERAGE_EVERY_MS[this.local ? "local" : "cloud"] || words - this.coverageWords < COVERAGE_MIN_WORDS) return;
    if (this.covered.length === this.items.length) return;
    this.busy.coverage = true;
    this.coverageAt = this.now();
    this.coverageWords = words;
    try {
      const knowledge = this.#knowledge(knowledgeQuery({ segments, goal: this.goal?.text, items: this.items, covered: this.covered }), 4);
      const transcript = segments.map((segment) => `${segment.you ? this.settings.speakerName || "Me" : segment.speaker || "Them"}: ${segment.text}`).join("\n");
      const [system, user] = coverageMessages({ transcript, goal: this.goal?.text, items: this.items, covered: this.covered, knowledge: knowledge.text, minutesLeft: minutesLeft(this.calendar, this.now()), speakerName: this.settings.speakerName, coaching: modePrompt(this.mode, "tips") });
      const result = parseCoverage(await this.ai(system.content, user.content), this.items);
      if (!result || this.ended) return;
      this.covered = [...new Set([...this.covered, ...result.covered])];
      this.next = result.next ? { ...result.next, sources: Object.fromEntries(Object.entries(knowledge.sources).filter(([id]) => result.next.cite.includes(id))) } : null;
      this.#changed();
    } catch (error) {
      this.emit("error", error);
    } finally {
      this.busy.coverage = false;
    }
  }

  /** What's kept with the call for its scorecard. */
  summary() {
    return { mode: this.mode.id, goal: this.goal?.text || "", goalSource: this.goal?.source || null, framework: this.framework, items: this.items, covered: this.covered, focus: this.focus?.id || null };
  }

  end() {
    this.ended = true;
    this.removeAllListeners();
  }
}

module.exports = { CallCoach };
