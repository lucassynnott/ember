const test = require("node:test");
const assert = require("node:assert/strict");
const { attendeeNames, matchEvent, nameFromEmail } = require("../src/calendar");

const minute = 60_000;
const now = new Date(2026, 9, 2, 14, 0).getTime();
const event = (title, startOffset, endOffset, extra = {}) => ({ title, start: now + startOffset * minute, end: now + endOffset * minute, attendees: [], ...extra });

test("names attendees from the invite, skipping you and anyone who declined", () => {
  assert.equal(nameFromEmail("harry.maule@acme.com"), "Harry Maule");
  assert.deepEqual(
    attendeeNames(
      { attendees: [{ me: true, name: "Lucas" }, { name: "Priya Shah" }, { email: "sam_okafor@acme.com" }, { name: "Bob", declined: true }, { name: "lucas" }] },
      "Lucas",
    ),
    ["Priya Shah", "Sam Okafor"],
  );
});

test("picks the meeting a call belongs to, not focus time or lunch", () => {
  const events = [
    event("Focus time", -60, 60),
    event("Lunch", -10, 50),
    event("Acme renewal", 5, 35, { link: "https://meet.google.com/abc-defg-hij", attendees: [{ name: "Priya Shah" }] }),
    event("Team sync", -120, -60, { attendees: [{ name: "Sam" }] }),
  ];
  const match = matchEvent(events, { startedAt: now, callApp: "Google Meet", selfName: "Lucas" });
  assert.equal(match.title, "Acme renewal");
  assert.deepEqual(match.attendees, ["Priya Shah"]);
  assert.equal(matchEvent([events[0], events[1]], { startedAt: now }), null);
  assert.equal(matchEvent([events[3]], { startedAt: now }), null, "an event that already ended doesn't count");
});

test("prefers the event whose call link matches the app, then the most overlap", () => {
  const events = [
    event("Weekly sync", 0, 30, { attendees: [{ name: "A" }, { name: "B" }] }),
    event("Client call", 0, 30, { link: "https://teams.microsoft.com/l/meetup-join/x", attendees: [{ name: "C" }] }),
  ];
  assert.equal(matchEvent(events, { startedAt: now, callApp: "Microsoft Teams" }).title, "Client call");
  assert.equal(matchEvent(events, { startedAt: now, endedAt: now + 30 * minute, callApp: "Zoom" }).title, "Client call", "a call link beats a plain invite");
});

test("prep finds earlier calls with the same people and briefs from them", () => {
  const { pastMeetingsWith, prepMessages, upcomingEvents } = require("../src/prep");
  const call = (id, speakers, extra = {}) => ({
    id,
    title: id,
    startedAt: new Date(`${id.slice(0, 10)}T10:00`).getTime(),
    transcript: speakers.map((speaker) => ({ speaker, text: "hi" })),
    summary: [],
    decisions: [],
    actionItems: [],
    attendees: [],
    ...extra,
  });
  const meetings = [
    call("2026-09-30-1701", ["Harry Maule", "Lucas"], { actionItems: [{ owner: "Lucas", task: "Review the site" }] }),
    call("2026-09-28-1000", ["Priya"]),
    call("2026-09-20-1000", ["Lucas"], { summary: ["Harry wants a new landing page"] }),
    call("2026-09-10-1000", ["Harrison Ford"]),
    call("2026-10-05-1000", ["Harry Maule"]),
  ];
  const found = pastMeetingsWith(meetings, ["Harry Maule"], { before: new Date("2026-10-02T12:00").getTime() });
  assert.deepEqual(found.map((meeting) => meeting.id), ["2026-09-30-1701", "2026-09-20-1000"]);
  assert.deepEqual(pastMeetingsWith(meetings, []), []);

  const [system, user] = prepMessages({ event: { title: "VSL check-in", attendees: ["Harry Maule"] }, meetings: found, speakerName: "Lucas" });
  assert.match(system.content, /Still open:/);
  assert.match(user.content, /Upcoming call: VSL check-in with Harry Maule/);
  assert.match(user.content, /Action items: Lucas: Review the site/);

  const now = new Date("2026-10-02T13:58").getTime();
  const events = [
    { title: "Soon", start: now + 2 * minute, link: "https://meet.google.com/x", attendees: [] },
    { title: "Later", start: now + 20 * minute, attendees: [{ name: "A" }] },
    { title: "Solo", start: now + minute, attendees: [{ me: true, name: "Lucas" }] },
  ];
  assert.deepEqual(upcomingEvents(events, now).map((event) => event.title), ["Soon"]);
});

test("weekly digests cover Monday to Sunday and are kept per week", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { DigestStore, digestMessages, weekFromId, weekOf } = require("../src/digest");
  assert.equal(weekOf(new Date(2026, 9, 2, 15)).id, "2026-09-28");
  assert.equal(weekOf(new Date(2026, 9, 4, 23)).id, "2026-09-28", "Sunday belongs to the week before");
  assert.equal(weekOf(new Date(2026, 9, 5, 1)).id, "2026-10-05");
  assert.equal(weekFromId("2026-09-30").id, "2026-09-28");
  assert.throws(() => weekFromId("../etc"), /isn't a week/);

  const week = weekFromId("2026-09-28");
  const [system, user] = digestMessages({
    week,
    speakerName: "Lucas",
    meetings: [{ id: "2026-09-30-1701", title: "VSL fix", startedAt: week.start, duration: 600, transcript: [{ speaker: "Harry Maule", text: "hi" }], summary: ["Video blank."], decisions: [], actionItems: [{ owner: "Lucas", task: "Review the site" }] }],
  });
  assert.match(system.content, /## Open action items/);
  assert.match(system.content, /\*\*You\*\*: task/);
  assert.match(user.content, /Week of 28 Sep 2026/);
  assert.match(user.content, /Speakers: Harry Maule/);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "digests-"));
  const store = new DigestStore(directory);
  await store.save("2026-09-30", "# Week of 28 Sep 2026\n\nHello\n");
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["2026-09-28"]);
  assert.match((await store.get("2026-09-28")).markdown, /Hello/);
  assert.equal(await store.get("2026-10-05"), null);
  await fs.rm(directory, { recursive: true, force: true });
});

test("the Now page counts this week's calls, words and your open items", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { UsageStats, meetingStats, wordCount } = require("../src/stats");
  const { weekOf } = require("../src/digest");
  assert.equal(wordCount("It's a well-known fact."), 4);
  const now = new Date(2026, 9, 2, 15);
  const call = (id, date, seconds, lines, extra = {}) => ({
    id, title: id, startedAt: date.getTime(), duration: seconds,
    transcript: lines.map(([speaker, text]) => ({ speaker, text })), actionItems: [], attendees: [], ...extra,
  });
  const stats = meetingStats(
    [
      call("a", new Date(2026, 8, 28, 10), 1800, [["Lucas", "hello there friend"], ["Harry Maule", "hi how are you"], ["Speaker 2", "yo"]], {
        actionItems: [{ owner: "Lucas", task: "Review site" }, { owner: "Harry", task: "Fix video" }],
      }),
      call("b", new Date(2026, 9, 2, 9), 600, [["Priya", "one two"]], { attendees: ["Sam Okafor", "Lucas"] }),
      call("c", new Date(2026, 8, 22, 9), 600, []),
    ],
    { now, speakerName: "Lucas" },
  );
  assert.equal(stats.meetings, 2);
  assert.equal(stats.lastWeekMeetings, 1);
  assert.equal(stats.minutes, 40);
  assert.deepEqual(stats.byDay, [1, 0, 0, 0, 1, 0, 0]);
  assert.equal(stats.words, 10);
  assert.equal(stats.yourWords, 3);
  assert.deepEqual(stats.people.map((person) => person.name), ["Harry Maule", "Priya", "Sam Okafor"]);
  assert.deepEqual(stats.actions.map((action) => action.task), ["Review site"]);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stats-"));
  const usage = new UsageStats(path.join(directory, "stats.json"));
  await usage.recordDictation("one two three four", now);
  await usage.recordDictation("five six", now);
  await usage.recordDictation("old words here", new Date(2026, 8, 1));
  const dictation = await new UsageStats(path.join(directory, "stats.json")).dictation(weekOf(now), now);
  assert.deepEqual(dictation, { weekWords: 6, weekSessions: 2, totalWords: 9, today: 6, minutesSaved: 0 });
  assert.doesNotMatch(await fs.readFile(path.join(directory, "stats.json"), "utf8"), /one two/, "only counts are stored");
  await fs.rm(directory, { recursive: true, force: true });
});

test("a repeating call is briefed from its last two occurrences", () => {
  const { seriesMeetings, prepMessages } = require("../src/prep");
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
  const call = (id, startedAt, title = null) => ({ id, title, startedAt, transcript: [], summary: ["x"], decisions: [], actionItems: [], attendees: [] });
  const event = { title: "SSC Weekly Team Call", start: at(2026, 9, 2, 14, 0), recurring: true, attendees: [] };
  const meetings = [
    call("week-1", at(2026, 8, 25, 14, 3)),
    call("week-2", at(2026, 8, 18, 13, 58)),
    call("week-3", at(2026, 8, 11, 14, 0)),
    call("other-time", at(2026, 8, 25, 10, 0)),
    call("renamed", at(2026, 8, 30, 9, 0), "SSC weekly team call"),
    call("today-early", at(2026, 9, 2, 13, 58)),
  ];
  assert.deepEqual(seriesMeetings(meetings, event).map((meeting) => meeting.id), ["renamed", "week-1"]);
  assert.deepEqual(seriesMeetings(meetings, { ...event, title: "Something else" }).map((meeting) => meeting.id), ["week-1", "week-2"]);
  const [system, user] = prepMessages({ event, meetings: meetings.slice(0, 2), series: meetings.slice(0, 2) });
  assert.match(system.content, /repeating call/);
  assert.match(system.content, /Last 2 calls:/);
  assert.match(user.content, /repeats; the earlier calls in this series are \[\[week-1\]\] and \[\[week-2\]\]/);
});

test("joining a call opens Zoom straight into the meeting", () => {
  const { joinTarget } = require("../src/join-link");
  assert.deepEqual(joinTarget("https://us02web.zoom.us/j/81234567890?pwd=abc.1"), {
    url: "zoommtg://zoom.us/join?action=join&confno=81234567890&pwd=abc.1",
    label: "Open Zoom & join",
    app: "Zoom",
  });
  assert.equal(joinTarget("https://zoom.us/my/lucas").url, "https://zoom.us/my/lucas");
  assert.equal(joinTarget("https://meet.google.com/abc-defg-hij").label, "Join Google Meet");
  assert.equal(joinTarget("https://teams.microsoft.com/l/meetup-join/x").label, "Open Teams & join");
  assert.equal(joinTarget("javascript:alert(1)"), null);
  assert.equal(joinTarget("not a url"), null);
});
