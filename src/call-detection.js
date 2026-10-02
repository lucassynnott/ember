// Recognises calls outside Zoom from which apps are using the microphone and speakers.
// Zoom itself is read through Accessibility (zoom-accessibility.js), which also names speakers.

const NATIVE_APPS = {
  "com.microsoft.teams2": "Microsoft Teams",
  "com.microsoft.teams": "Microsoft Teams",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.apple.FaceTime": "FaceTime",
  "com.cisco.webexmeetingsapp": "Webex",
  "Cisco-Systems.Spark": "Webex",
  "com.webex.meetingmanager": "Webex",
  "com.hnc.Discord": "Discord",
  "net.whatsapp.WhatsApp": "WhatsApp",
  "desktop.WhatsApp": "WhatsApp",
  "org.whispersystems.signal-desktop": "Signal",
  "ru.keepcoder.Telegram": "Telegram",
  "org.telegram.desktop": "Telegram",
  "com.skype.skype": "Skype",
  "app.tuple.app": "Tuple",
  "co.teamport.around": "Around",
  "com.logmein.GoToMeeting": "GoTo Meeting",
  "com.logmein.goto": "GoTo Meeting",
  "com.ringcentral.RingCentral": "RingCentral",
  "com.amazon.Amazon-Chime": "Amazon Chime",
  "com.bluejeans.BlueJeans": "BlueJeans",
  "com.pop.pop.app": "Pop",
};

// Window titles of meeting pages in a browser.
const WEB_MEETINGS = [
  [/(^|\s)Meet\s*[-–—:]\s*\S|Google Meet|meet\.google\.com/i, "Google Meet"],
  [/Microsoft Teams|teams\.microsoft\.com|teams\.live\.com/i, "Microsoft Teams"],
  [/Zoom Meeting|Zoom Workplace|app\.zoom\.us/i, "Zoom"],
  [/Whereby/i, "Whereby"],
  [/Jitsi Meet|meet\.jit\.si/i, "Jitsi Meet"],
  [/Webex/i, "Webex"],
  [/Huddle.*Slack|Slack.*Huddle/i, "Slack"],
  [/Discord/i, "Discord"],
  [/Riverside/i, "Riverside"],
  [/StreamYard/i, "StreamYard"],
  [/Around/i, "Around"],
];

// Zoom is handled by the Accessibility observer.
const IGNORED = new Set(["us.zoom.xos"]);

function webMeeting(titles = []) {
  for (const title of titles) {
    for (const [pattern, name] of WEB_MEETINGS) if (pattern.test(title)) return name;
  }
  return null;
}

// The call an app is in right now, judged from a single snapshot. Only microphone use starts a call.
function callFrom(app) {
  if (!app?.bundleId || IGNORED.has(app.bundleId) || !app.input) return null;
  const native = NATIVE_APPS[app.bundleId];
  if (native) return { bundleId: app.bundleId, app: native, browser: false };
  const web = webMeeting(app.titles);
  return web ? { bundleId: app.bundleId, app: web, browser: true, via: app.name } : null;
}

/**
 * Follows one call across snapshots. A call starts when a meeting app (or a browser on a meeting page)
 * uses the microphone. It continues while that app keeps the microphone, or, for native apps, the
 * speakers too, since some apps release the microphone while you're muted.
 */
class CallTracker {
  constructor() {
    this.call = null;
  }

  update(apps = []) {
    const byBundle = new Map(apps.map((app) => [app.bundleId, app]));
    if (this.call) {
      const app = byBundle.get(this.call.bundleId);
      const still = app && (app.input || (!this.call.browser && app.output));
      if (still) {
        // A browser that moved to another meeting page is still the same call.
        return { ...this.call, live: true, active: Boolean(app.input) };
      }
      this.call = null;
    }
    for (const app of apps) {
      const call = callFrom(app);
      if (call) {
        this.call = call;
        return { ...call, live: true, active: true };
      }
    }
    return null;
  }
}

module.exports = { CallTracker, NATIVE_APPS, callFrom, webMeeting };
