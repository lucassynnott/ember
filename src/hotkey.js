const { defaultHotkeys } = require("./default-hotkeys");
const { nativeHelperPath } = require("./platform");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_HOTKEY = Object.freeze(defaultHotkeys().dictate);

// Terminals draw their own text views, which Accessibility doesn't report as editable.
const ALWAYS_PASTE_BUNDLE_IDS = new Set([
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "com.termius-dmg.mac",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "com.github.wez.wezterm",
]);

const MODIFIER_ORDER = [
  "fn",
  "leftControl",
  "rightControl",
  "leftOption",
  "rightOption",
  "leftShift",
  "rightShift",
  "leftCommand",
  "rightCommand",
];
const MODIFIER_SYMBOLS = {
  fn: "fn",
  leftControl: "⌃",
  rightControl: "Right ⌃",
  leftOption: "⌥",
  rightOption: "Right ⌥",
  leftShift: "⇧",
  rightShift: "Right ⇧",
  leftCommand: "⌘",
  rightCommand: "Right ⌘",
};
const MODIFIER_NAMES = {
  fn: "fn",
  leftControl: "Left ⌃",
  rightControl: "Right ⌃",
  leftOption: "Left ⌥",
  rightOption: "Right ⌥",
  leftShift: "Left ⇧",
  rightShift: "Right ⇧",
  leftCommand: "Left ⌘",
  rightCommand: "Right ⌘",
};

// macOS virtual key codes for keys whose label doesn't come from the keyboard layout.
const KEY_NAMES = {
  36: "Return", 48: "Tab", 49: "Space", 51: "Delete ⌫", 53: "Esc", 57: "Caps Lock",
  71: "Clear", 76: "Enter", 114: "Ins", 115: "Home", 116: "Page Up", 117: "Del",
  119: "End", 121: "Page Down", 123: "←", 124: "→", 125: "↓", 126: "↑",
  122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8",
  101: "F9", 109: "F10", 103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15",
  106: "F16", 64: "F17", 79: "F18", 80: "F19", 90: "F20",
  65: "Keypad .", 67: "Keypad *", 69: "Keypad +", 75: "Keypad /", 78: "Keypad -", 81: "Keypad =",
  82: "Keypad 0", 83: "Keypad 1", 84: "Keypad 2", 85: "Keypad 3", 86: "Keypad 4",
  87: "Keypad 5", 88: "Keypad 6", 89: "Keypad 7", 91: "Keypad 8", 92: "Keypad 9",
};
const ANSI_KEY_NAMES = {
  0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V", 11: "B",
  12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T", 18: "1", 19: "2", 20: "3", 21: "4",
  22: "6", 23: "5", 24: "=", 25: "9", 26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "O",
  32: "U", 33: "[", 34: "I", 35: "P", 37: "L", 38: "J", 39: "'", 40: "K", 41: ";", 42: "\\",
  43: ",", 44: "/", 45: "N", 46: "M", 47: ".", 50: "`",
};

function sortModifiers(modifiers = []) {
  return [...new Set(modifiers)].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
}

function hotkeyLabel(hotkey, platform = process.platform) {
  if (!hotkey || (hotkey.keyCode == null && !hotkey.modifiers?.length)) return "Not set";
  const modifiers = sortModifiers(hotkey.modifiers);
  if (platform === "win32") {
    const names = { fn: "Fn", leftControl: "Ctrl", rightControl: "Right Ctrl", leftOption: "Alt", rightOption: "Right Alt", leftShift: "Shift", rightShift: "Right Shift", leftCommand: "Win", rightCommand: "Right Win" };
    const parts = modifiers.map((name) => names[name] || name);
    if (hotkey.keyCode != null) parts.push(({ 36: "Enter", 51: "Backspace" })[hotkey.keyCode] || KEY_NAMES[hotkey.keyCode] || (hotkey.keyName ? hotkey.keyName.toUpperCase() : ANSI_KEY_NAMES[hotkey.keyCode]) || `Key ${hotkey.keyCode}`);
    return parts.join(" + ");
  }
  if (hotkey.keyCode == null) return modifiers.map((name) => MODIFIER_NAMES[name] || name).join(" + ");
  const key =
    KEY_NAMES[hotkey.keyCode] ||
    (hotkey.keyName ? hotkey.keyName.toUpperCase() : ANSI_KEY_NAMES[hotkey.keyCode]) ||
    `Key ${hotkey.keyCode}`;
  const prefix = modifiers.map((name) => MODIFIER_SYMBOLS[name] || name);
  const joiner = prefix.some((part) => part.length > 1) ? " + " : "";
  return prefix.length ? `${prefix.join(joiner)}${joiner || " "}${key}`.replace(/\s+/g, " ") : key;
}

function normalizeHotkey(hotkey) {
  if (!hotkey || typeof hotkey !== "object") return { ...DEFAULT_HOTKEY };
  const modifiers = sortModifiers((hotkey.modifiers || []).filter((name) => MODIFIER_ORDER.includes(name)));
  const keyCode = Number.isInteger(hotkey.keyCode) ? hotkey.keyCode : null;
  if (keyCode == null && !modifiers.length) return { ...DEFAULT_HOTKEY };
  return { keyCode, modifiers, ...(hotkey.keyName ? { keyName: String(hotkey.keyName) } : {}) };
}

function hotkeyHelperPath(app) {
  return nativeHelperPath(app, "hotkey");
}

// Runs the native helper and turns its JSON lines into events and request/response calls.
class HotkeyHelper extends EventEmitter {
  constructor({ binaryPath, spawnImpl = spawn }) {
    super();
    this.binaryPath = binaryPath;
    this.spawn = spawnImpl;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.status = { accessibility: false, tap: false };
    this.hotkey = null;
    // Every named shortcut and the clipboard watch, re-sent if the helper restarts.
    this.hotkeys = new Map();
    this.watchingPasteboard = false;
    this.stopping = false;
  }

  start() {
    if (this.child) return;
    this.stopping = false;
    const child = this.spawn(this.binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.on("data", (chunk) => console.error(`hotkey helper: ${chunk}`.trim()));
    child.once("error", (error) => this.emit("error", error));
    child.once("close", (code) => {
      this.child = null;
      for (const waiter of this.pending.values()) waiter.reject(new Error("Hotkey helper stopped."));
      this.pending.clear();
      if (!this.stopping) {
        this.emit("error", new Error(`Hotkey helper exited with code ${code}`));
        setTimeout(() => {
          if (!this.stopping) this.start();
        }, 1000);
      }
    });
    for (const [name, hotkey] of this.hotkeys) this.#send({ cmd: "setHotkey", hotkey, name });
    if (this.watchingPasteboard) this.#send({ cmd: "watchPasteboard", active: true });
    if (this.watchingPointer) this.#send({ cmd: "watchPointer", active: true });
  }

  stop() {
    this.stopping = true;
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
  }

  #send(command) {
    if (!this.child?.stdin.writable) return false;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  #request(command, timeoutMs = 2000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hotkey helper did not answer ${command.cmd}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      if (!this.#send({ ...command, id })) {
        this.pending.get(id)?.reject(new Error("Hotkey helper is not running."));
        this.pending.delete(id);
      }
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id != null && this.pending.has(message.id)) {
        if (message.ok === false || message.error) this.pending.get(message.id).reject(new Error(message.error || "Native helper request failed."));
        else this.pending.get(message.id).resolve(message);
        this.pending.delete(message.id);
        continue;
      }
      if (message.event === "status") {
        this.status = { accessibility: Boolean(message.accessibility), tap: Boolean(message.tap) };
      }
      // Dictation's shortcut reports plain "down"/"up"; other shortcuts are prefixed, e.g. "ask:down".
      if (message.hotkey && message.hotkey !== "dictate" && ["down", "up", "cancel"].includes(message.event)) {
        this.emit(`${message.hotkey}:${message.event}`, message);
        continue;
      }
      this.emit(message.event, message);
      this.emit("message", message);
    }
  }

  // Parses helper output; public so tests can feed lines in.
  ingest(text) {
    this.#onData(Buffer.from(text));
  }

  setHotkey(hotkey, name = "dictate") {
    if (name === "dictate") this.hotkey = hotkey;
    if (hotkey) this.hotkeys.set(name, hotkey);
    else this.hotkeys.delete(name);
    this.#send({ cmd: "setHotkey", hotkey: hotkey || null, name });
  }

  // Reports each copy as a "pasteboard" event, for the clipboard history.
  watchPasteboard(active) {
    this.watchingPasteboard = Boolean(active);
    this.#send({ cmd: "watchPasteboard", active: this.watchingPasteboard });
  }

  windows() { return this.#request({ cmd: "windows" }, 5000); }

  watchPointer(active) {
    this.watchingPointer = Boolean(active);
    this.#send({ cmd: "watchPointer", active: this.watchingPointer });
  }

  // Brings an app back to the front, e.g. after the clipboard picker closes.
  activate(pid) {
    return this.#request({ cmd: "activate", pid });
  }

  // Esc is caught while any owner (dictation, the Ask card) is showing something it can cancel.
  setDictating(active, owner = "dictate") {
    this.escapeOwners ||= new Set();
    if (active) this.escapeOwners.add(owner);
    else this.escapeOwners.delete(owner);
    this.#send({ cmd: "setDictating", active: this.escapeOwners.size > 0 });
  }

  capture() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.off("captured", onCaptured);
        this.off("captureCancelled", onCancelled);
      };
      const onCaptured = (message) => {
        cleanup();
        resolve(normalizeHotkey({ keyCode: message.keyCode, modifiers: message.modifiers, keyName: message.keyName }));
      };
      const onCancelled = () => {
        cleanup();
        resolve(null);
      };
      this.on("captured", onCaptured);
      this.on("captureCancelled", onCancelled);
      if (!this.#send({ cmd: "capture" })) {
        cleanup();
        reject(new Error("Hotkey helper is not running."));
      }
    });
  }

  cancelCapture() {
    this.#send({ cmd: "cancelCapture" });
  }

  focus() {
    return this.#request({ cmd: "focus" });
  }

  paste() {
    return this.#request({ cmd: "paste" });
  }

  copy() {
    return this.#request({ cmd: "copy" });
  }
}

// "paste": a text field is focused. "paste-and-copy": probably a text field, but the app's
// accessibility info can't be trusted (Chromium, Electron), so the text also stays on the
// clipboard in case nothing received it. "copy": no text field.
function deliveryFor(focus) {
  if (!focus || focus.secure) return "copy";
  if (focus.editable || ALWAYS_PASTE_BUNDLE_IDS.has(focus.bundleId)) return "paste";
  if (focus.chromium) return "paste-and-copy";
  return "copy";
}

function canPasteInto(focus) {
  return deliveryFor(focus) !== "copy";
}

module.exports = {
  DEFAULT_HOTKEY,
  HotkeyHelper,
  canPasteInto,
  deliveryFor,
  hotkeyHelperPath,
  hotkeyLabel,
  normalizeHotkey,
};
