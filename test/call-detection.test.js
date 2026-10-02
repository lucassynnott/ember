const test = require("node:test");
const assert = require("node:assert/strict");
const { CallTracker, callFrom, webMeeting } = require("../src/call-detection");
const { ZoomAutoRecordingController } = require("../src/zoom-auto-recording");

const app = (bundleId, extra = {}) => ({ bundleId, name: bundleId, input: false, output: false, titles: [], ...extra });

test("recognises meeting apps and browser meeting pages by microphone use", () => {
  assert.equal(callFrom(app("com.microsoft.teams2", { input: true })).app, "Microsoft Teams");
  assert.equal(callFrom(app("com.tinyspeck.slackmacgap", { input: true })).app, "Slack");
  assert.equal(callFrom(app("com.microsoft.teams2", { output: true })), null, "speakers alone don't start a call");
  assert.equal(callFrom(app("us.zoom.xos", { input: true })), null, "Zoom is read through Accessibility");
  assert.equal(callFrom(app("fr.adesky.GoXlr-App", { input: true })), null);

  const meet = callFrom(app("net.imput.helium", { name: "Helium", input: true, titles: ["Meet - abc-defg-hij - Helium"] }));
  assert.deepEqual(meet, { bundleId: "net.imput.helium", app: "Google Meet", browser: true, via: "Helium" });
  assert.equal(callFrom(app("com.google.Chrome", { input: true, titles: ["YouTube - Google Chrome"] })), null);
  assert.equal(webMeeting(["Weekly sync | Microsoft Teams"]), "Microsoft Teams");
  assert.equal(webMeeting(["Meeting notes - Google Docs"]), null);
  assert.equal(webMeeting(["Meet the team – Our blog"]), null);
});

test("a call continues while the app keeps the mic or, for native apps, the speakers", () => {
  const tracker = new CallTracker();
  assert.equal(tracker.update([app("com.microsoft.teams2", { output: true })]), null);
  assert.equal(tracker.update([app("com.microsoft.teams2", { input: true, output: true })]).app, "Microsoft Teams");
  const muted = tracker.update([app("com.microsoft.teams2", { output: true })]);
  assert.equal(muted.live, true);
  assert.equal(muted.active, false);
  assert.equal(tracker.update([]), null);

  const browser = new CallTracker();
  browser.update([app("com.google.Chrome", { input: true, titles: ["Meet - abc-defg-hij"] })]);
  assert.equal(browser.update([app("com.google.Chrome", { input: true, titles: ["Inbox - Gmail"] })]).app, "Google Meet", "switching tabs keeps the call");
  assert.equal(browser.update([app("com.google.Chrome", { output: true })]), null, "a browser playing sound isn't a call");
});

test("auto-record starts for a Meet call and stops after the longer call delay", async () => {
  const timers = [];
  let phase = "idle";
  let origin = null;
  const events = [];
  const controller = new ZoomAutoRecordingController({
    getEnabled: () => true,
    getPhase: () => phase,
    getRecordingOrigin: () => origin,
    onStart: async () => {
      events.push("start");
      phase = "recording";
      origin = "zoom-auto";
      return true;
    },
    onStop: async () => {
      events.push("stop");
      phase = "idle";
      origin = null;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  const run = async () => {
    const timer = timers.filter((candidate) => !candidate.cleared && !candidate.ran).at(-1);
    timer.ran = true;
    await timer.fn();
    return timer.ms;
  };

  controller.updateCallState({ bundleId: "com.google.Chrome", app: "Google Meet", live: true, active: true, browser: true });
  assert.equal(controller.source(), "Google Meet");
  assert.equal(await run(), 2500);
  assert.deepEqual(events, ["start"]);

  controller.updateCallState(null);
  assert.equal(await run(), 15000);
  assert.deepEqual(events, ["start", "stop"]);
  assert.equal(controller.source(), "Google Meet");
});
