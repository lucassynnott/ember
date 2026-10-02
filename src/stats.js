// Numbers for the Now page: this week's calls, words spoken and dictated, open items, people met.
const fs = require("node:fs/promises");
const path = require("node:path");
const { weekOf } = require("./digest");

const TYPING_WPM = 40;
const SPEAKING_WPM = 150;
const GENERIC_SPEAKER = /^(remote speaker|speaker \d+|unknown)$/i;

function wordCount(text) {
  return (String(text || "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Dictation counts per day, kept on this Mac. Only counts, never the text. */
class UsageStats {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async #load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch {
      this.data = {};
    }
    this.data.dictation ||= {};
    return this.data;
  }

  recordDictation(text, date = new Date()) {
    const words = wordCount(text);
    if (!words) return this.queue;
    this.queue = this.queue
      .then(async () => {
        const data = await this.#load();
        const day = (data.dictation[dayKey(date)] ||= { words: 0, sessions: 0 });
        day.words += words;
        day.sessions += 1;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(`${this.filePath}.tmp`, `${JSON.stringify(data)}\n`, { mode: 0o600 });
        await fs.rename(`${this.filePath}.tmp`, this.filePath);
      })
      .catch(() => {});
    return this.queue;
  }

  async dictation(week, now = new Date()) {
    const data = await this.#load();
    let weekWords = 0;
    let weekSessions = 0;
    let totalWords = 0;
    for (const [key, day] of Object.entries(data.dictation)) {
      totalWords += day.words;
      const [year, month, date] = key.split("-").map(Number);
      const time = new Date(year, month - 1, date).getTime();
      if (time >= week.start && time < week.end) {
        weekWords += day.words;
        weekSessions += day.sessions;
      }
    }
    const today = data.dictation[dayKey(now)]?.words || 0;
    // Typing at about 40 words a minute against speaking at about 150.
    const minutesSaved = Math.round(weekWords / TYPING_WPM - weekWords / SPEAKING_WPM);
    return { weekWords, weekSessions, totalWords, today, minutesSaved };
  }
}

function isMe(name, speakerName) {
  const a = String(name || "").trim().toLowerCase();
  const b = String(speakerName || "").trim().toLowerCase();
  return Boolean(a) && (a === b || a === "you" || (b && a === b.split(/\s+/)[0]));
}

/** This week's calls, from the meeting notes. */
function meetingStats(meetings, { now = new Date(), speakerName = "" } = {}) {
  const week = weekOf(now);
  const lastWeek = { start: week.start - 7 * 86_400_000, end: week.start };
  const inWeek = meetings.filter((meeting) => meeting.startedAt >= week.start && meeting.startedAt < week.end);
  const byDay = Array.from({ length: 7 }, () => 0);
  let minutes = 0;
  let words = 0;
  let yourWords = 0;
  const people = new Map();
  const actions = [];
  for (const meeting of inWeek) {
    byDay[(new Date(meeting.startedAt).getDay() + 6) % 7] += 1;
    minutes += (meeting.duration || 0) / 60;
    const met = new Set();
    for (const line of meeting.transcript) {
      const count = wordCount(line.text);
      words += count;
      if (isMe(line.speaker, speakerName)) yourWords += count;
      else if (line.speaker && !GENERIC_SPEAKER.test(line.speaker)) met.add(line.speaker);
    }
    for (const name of meeting.attendees || []) if (!isMe(name, speakerName)) met.add(name);
    for (const name of met) people.set(name, (people.get(name) || 0) + 1);
    meeting.actionItems.forEach((item, index) => {
      if (isMe(item.owner, speakerName) && !item.done) {
        actions.push({ task: item.task, meetingId: meeting.id, meetingTitle: meeting.title, startedAt: meeting.startedAt, index });
      }
    });
  }
  return {
    weekId: week.id,
    meetings: inWeek.length,
    lastWeekMeetings: meetings.filter((meeting) => meeting.startedAt >= lastWeek.start && meeting.startedAt < lastWeek.end).length,
    minutes: Math.round(minutes),
    byDay,
    today: (new Date(now).getDay() + 6) % 7,
    words,
    yourWords,
    people: [...people.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([name, calls]) => ({ name, calls })),
    actions: actions.sort((a, b) => b.startedAt - a.startedAt).slice(0, 6),
  };
}

module.exports = { UsageStats, isMe, meetingStats, wordCount };
