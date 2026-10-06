const { nativeHelperPath } = require("./platform");
// Names calls after their calendar event, through the meeting-notes-calendar helper (EventKit).
const path = require("node:path");
const { execFile } = require("node:child_process");

const EARLY_MS = 10 * 60 * 1000;
const MEETING_WORDS = /\b(call|meeting|sync|1:1|1-1|one on one|catch.?up|interview|demo|standup|stand-up|review|chat|intro)\b/i;
const LINK_APPS = [
  [/meet\.google\.com/i, "Google Meet"],
  [/teams\.(microsoft|live)\.com/i, "Microsoft Teams"],
  [/zoom\.us/i, "Zoom"],
  [/webex\.com/i, "Webex"],
  [/whereby\.com/i, "Whereby"],
  [/meet\.jit\.si/i, "Jitsi Meet"],
];

function calendarHelperPath(app) {
  return nativeHelperPath(app, "calendar");
}

// "harry.maule@acme.com" → "Harry Maule", for attendees without a display name.
function nameFromEmail(email) {
  const local = String(email || "").split("@")[0];
  if (!local) return "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function attendeeNames(event, selfName = "") {
  const names = [];
  for (const person of event.attendees || []) {
    if (person.me || person.declined) continue;
    const name = person.name && !person.name.includes("@") ? person.name : nameFromEmail(person.email || person.name);
    if (name && name.toLowerCase() !== String(selfName).toLowerCase() && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The event a call belongs to: one running at the time (from 10 minutes before it starts) that
 * looks like a meeting (it has a call link, other attendees or a meeting-like title). When several
 * overlap, the one with the most overlap wins, preferring a link to the app the call is in.
 */
function matchEvent(events, { startedAt, endedAt = startedAt, callApp = null, selfName = "" }) {
  const from = Number(startedAt);
  const to = Math.max(Number(endedAt), from + 1);
  let best = null;
  for (const event of events || []) {
    const start = Number(event.start) - EARLY_MS;
    const end = Number(event.end);
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap <= 0 && !(from >= start && from <= end)) continue;
    const others = attendeeNames(event, selfName);
    const linkApp = LINK_APPS.find(([pattern]) => pattern.test(event.link || ""))?.[1] || null;
    if (!event.link && !others.length && !MEETING_WORDS.test(event.title || "")) continue;
    const score = Math.max(overlap, 1) + (linkApp && linkApp === callApp ? 3_600_000 : 0) + (event.link ? 60_000 : 0) + others.length * 1000;
    if (!best || score > best.score) best = { score, event, others };
  }
  if (!best) return null;
  return {
    title: String(best.event.title || "").trim().slice(0, 120),
    attendees: best.others,
    start: best.event.start,
    end: best.event.end,
    link: best.event.link || null,
    recurring: Boolean(best.event.recurring),
  };
}

class CalendarReader {
  constructor(binaryPath) {
    this.binaryPath = binaryPath;
  }

  #run(args, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      execFile(this.binaryPath, args, { timeout: timeoutMs }, (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(String(stdout).trim().split("\n").pop()));
        } catch {
          reject(new Error("The calendar helper returned something unexpected."));
        }
      });
    });
  }

  async status() {
    return (await this.#run(["status"])).status;
  }

  // Shows macOS's permission prompt the first time.
  async request() {
    return (await this.#run(["request"], 120000)).status;
  }

  async events(from, to) {
    const result = await this.#run(["events", String(Math.round(from)), String(Math.round(to))]);
    return result.status === "granted" ? result.events || [] : [];
  }

  // Reminders, for sending action items there.
  async remindersStatus() {
    return (await this.#run(["reminders-status"])).status;
  }

  async requestReminders() {
    return (await this.#run(["reminders-request"], 120000)).status;
  }

  async reminderLists() {
    const result = await this.#run(["reminder-lists"]);
    return { status: result.status, lists: result.lists || [], defaultId: result.default || "" };
  }

  async completeReminder(id, done) {
    const result = await this.#run(["complete-reminder", String(id), done ? "done" : "open"]);
    if (result.error) throw new Error(result.error);
    return result.completed;
  }

  async addReminder({ list = "", title, notes = "", due = null }) {
    const result = await this.#run(["add-reminder", JSON.stringify({ list, title: String(title).slice(0, 500), notes: String(notes).slice(0, 4000), ...(due ? { due } : {}) })]);
    if (result.error) throw new Error(result.error);
    return result.id;
  }
}

module.exports = { CalendarReader, attendeeNames, calendarHelperPath, matchEvent, nameFromEmail };
