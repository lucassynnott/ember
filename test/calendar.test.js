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
