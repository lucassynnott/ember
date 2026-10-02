// How dictation should sound in each app: chatty in Slack, professional in Mail, untouched in code.

const STYLES = {
  casual: "This goes into a chat app. Keep it relaxed and conversational: contractions are fine, short sentences, no greeting or sign-off unless spoken.",
  formal: "This goes into an email. Use complete sentences, proper punctuation and a professional tone, without adding greetings or sign-offs that weren't spoken.",
  plain:
    "This goes into a code editor or terminal. Keep the wording exactly; only remove fillers. Don't add punctuation at the end and don't capitalize. When spoken symbols are clearly part of a command, path, flag or identifier, write them as characters: dash → -, double dash → --, slash → /, dot → ., underscore → _, tilde → ~, pipe → |, equals → =.",
};

// Built-in groups, matched by bundle id first and app name second.
const PRESETS = [
  {
    id: "chat",
    label: "Chat apps",
    style: "casual",
    apps: ["Slack", "Messages", "Discord", "WhatsApp", "Telegram", "Signal", "Microsoft Teams", "Messenger"],
    bundleIds: ["com.tinyspeck.slackmacgap", "com.apple.MobileSMS", "com.hnc.Discord", "net.whatsapp.WhatsApp", "ru.keepcoder.Telegram", "org.whispersystems.signal-desktop", "com.microsoft.teams2"],
  },
  {
    id: "email",
    label: "Email",
    style: "formal",
    apps: ["Mail", "Microsoft Outlook", "Outlook", "Superhuman", "Spark", "Mimestream", "Airmail"],
    bundleIds: ["com.apple.mail", "com.microsoft.Outlook", "com.superhuman.electron", "com.readdle.SparkDesktop", "com.mimestream.Mimestream"],
  },
  {
    id: "code",
    label: "Code and terminals",
    style: "plain",
    apps: ["Visual Studio Code", "Code", "Cursor", "Xcode", "Zed", "Terminal", "iTerm2", "iTerm", "Warp", "Ghostty", "Nova", "Sublime Text"],
    bundleIds: ["com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.apple.dt.Xcode", "dev.zed.Zed", "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty"],
  },
];

function normalizeStyleRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => ({
      app: String(rule?.app || "").replace(/\s+/g, " ").trim().slice(0, 80),
      style: String(rule?.style || "").trim().slice(0, 300),
    }))
    .filter((rule) => rule.app && rule.style)
    .slice(0, 50);
}

/**
 * The style instruction for the app being typed into, or "" for none. Your own rules win over the
 * built-in groups; a rule's style is a preset name (casual, formal, plain) or your own words.
 * presets maps a group id to a style name, or "off".
 */
function styleFor(focus, { rules = [], presets = {} } = {}) {
  const none = { name: null, instruction: "" };
  if (!focus) return none;
  const app = String(focus.app || "").toLowerCase();
  const bundleId = String(focus.bundleId || "");
  const own = rules.find((rule) => rule.app.toLowerCase() === app || rule.app === bundleId);
  if (own) {
    return STYLES[own.style]
      ? { name: own.style, instruction: STYLES[own.style] }
      : { name: "custom", instruction: `Style for this app: ${own.style}` };
  }
  for (const preset of PRESETS) {
    const matches = preset.bundleIds.includes(bundleId) || preset.apps.some((name) => name.toLowerCase() === app);
    if (!matches) continue;
    const choice = presets[preset.id] ?? preset.style;
    return STYLES[choice] ? { name: choice, instruction: STYLES[choice] } : none;
  }
  return none;
}

module.exports = { PRESETS, STYLES, normalizeStyleRules, styleFor };
