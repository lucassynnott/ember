const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { DictationController, splitForTranscription } = require("../src/dictation");
const { HotkeyHelper, canPasteInto, deliveryFor, hotkeyLabel, normalizeHotkey } = require("../src/hotkey");
const { TranscriberService } = require("../src/transcriber-service");

test("labels hotkeys including fn, side-specific modifiers and special keys", () => {
  assert.equal(hotkeyLabel({ keyCode: null, modifiers: ["rightOption"] }), "Right ⌥");
  assert.equal(hotkeyLabel({ keyCode: null, modifiers: ["fn"] }), "fn");
  assert.equal(hotkeyLabel({ keyCode: null, modifiers: ["rightCommand", "fn"] }), "fn + Right ⌘");
  assert.equal(hotkeyLabel({ keyCode: 49, modifiers: ["leftOption", "leftControl"] }), "⌃⌥ Space");
  assert.equal(hotkeyLabel({ keyCode: 115, modifiers: [] }), "Home");
  assert.equal(hotkeyLabel({ keyCode: 114, modifiers: [] }), "Ins");
  assert.equal(hotkeyLabel({ keyCode: 117, modifiers: ["leftCommand"] }), "⌘ Del");
  assert.equal(hotkeyLabel({ keyCode: 116, modifiers: [] }), "Page Up");
  assert.equal(hotkeyLabel({ keyCode: 96, modifiers: ["fn"] }), "fn + F5");
  assert.equal(hotkeyLabel({ keyCode: 2, modifiers: ["leftCommand"], keyName: "d" }), "⌘ D");
  assert.deepEqual(normalizeHotkey(null), { keyCode: null, modifiers: ["rightOption"] });
  assert.deepEqual(normalizeHotkey({ keyCode: null, modifiers: ["bogus"] }), { keyCode: null, modifiers: ["rightOption"] });
});

test("pastes only into editable, non-password fields or known terminals", () => {
  assert.equal(canPasteInto({ editable: true, secure: false }), true);
  assert.equal(canPasteInto({ editable: true, secure: true }), false);
  assert.equal(canPasteInto({ editable: false, bundleId: "com.apple.finder" }), false);
  assert.equal(canPasteInto({ editable: false, bundleId: "com.googlecode.iterm2" }), true);
  assert.equal(canPasteInto(null), false);
});

test("pastes into Chromium and Electron apps but keeps a clipboard copy, since their focus info is unreliable", () => {
  assert.equal(deliveryFor({ editable: true, chromium: true }), "paste");
  assert.equal(deliveryFor({ editable: false, chromium: true, focusFound: false, bundleId: "net.imput.helium" }), "paste-and-copy");
  assert.equal(deliveryFor({ editable: false, chromium: true, secure: true }), "copy");
  assert.equal(deliveryFor({ editable: false, chromium: false, focusFound: true, role: "AXOutline" }), "copy");
});

test("splits long audio at quiet moments into pieces the Parakeet worker accepts", () => {
  const rate = 16000;
  const samples = new Float32Array(rate * 70).map((_, index) => 0.2 * Math.sin(index / 7));
  // Quiet gaps at 25 s and 52 s.
  samples.fill(0, rate * 25, rate * 25.5);
  samples.fill(0, rate * 52, rate * 52.5);
  const pieces = splitForTranscription(samples, { maxSeconds: 28 });
  assert.equal(pieces.length, 3);
  assert.ok(pieces.every((piece) => piece.length <= rate * 28));
  assert.equal(pieces.reduce((sum, piece) => sum + piece.length, 0), samples.length);
  assert.ok(Math.abs(pieces[0].length / rate - 25.25) < 0.3, `first cut at ${pieces[0].length / rate}s`);
});

function harness({ focus = { editable: true }, mode = "hold", text = "hello world", speech = 0.3, preflight, intercept } = {}) {
  const helper = new EventEmitter();
  const calls = [];
  helper.setDictating = (active) => calls.push(`dictating:${active}`);
  helper.focus = async () => focus;
  helper.paste = async () => calls.push("paste");
  let clipboard = "previous clipboard";
  const overlay = {
    states: [],
    show(state, message) {
      this.states.push(message ? `${state}:${message}` : state);
    },
    hide() {
      this.states.push("hidden");
    },
    startCapture: async () => calls.push("capture:start"),
    stopCapture: async () => {
      calls.push("capture:stop");
      return new Float32Array(16000).fill(speech);
    },
    cancelCapture: () => calls.push("capture:cancel"),
  };
  let now = 0;
  const pendingTimers = [];
  const timers = {
    setTimeout: (callback, delay) => {
      const timer = { callback, at: now + delay };
      pendingTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = pendingTimers.indexOf(timer);
      if (index !== -1) pendingTimers.splice(index, 1);
    },
  };
  const advance = (ms) => {
    now += ms;
    for (const timer of [...pendingTimers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= now) {
        timers.clearTimeout(timer);
        timer.callback();
      }
    }
  };
  const controller = new DictationController({
    helper,
    overlay,
    transcribe: async () => text,
    intercept,
    clipboard: {
      snapshot: () => ({ text: clipboard }),
      writeText: (value) => {
        clipboard = value;
      },
      readText: () => clipboard,
      restore: (snapshot) => {
        clipboard = snapshot.text;
      },
    },
    getSettings: () => ({ dictationMode: mode }),
    preflight,
    now: () => now,
    timers,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { helper, controller, overlay, calls, advance, settle, clipboard: () => clipboard };
}

test("hold to talk: pastes into a text field and restores the previous clipboard", async () => {
  const h = harness();
  h.helper.emit("down");
  await h.settle();
  h.advance(200);
  assert.deepEqual(h.overlay.states, ["listening"]);
  h.advance(800);
  h.helper.emit("up");
  for (let index = 0; index < 5; index += 1) await h.settle();
  assert.deepEqual(h.calls, ["dictating:true", "capture:start", "capture:stop", "paste", "dictating:false"]);
  assert.deepEqual(h.overlay.states, ["listening", "transcribing", "pasted:Pasted"]);
  assert.equal(h.clipboard(), "hello world");
  h.advance(700);
  assert.equal(h.clipboard(), "previous clipboard");
  assert.equal(h.controller.lastText, "hello world");
  assert.equal(h.controller.state, "idle");
});

test("copies to the clipboard when no text field is focused", async () => {
  const h = harness({ focus: { editable: false, bundleId: "com.apple.finder" } });
  h.helper.emit("down");
  await h.settle();
  h.advance(1000);
  h.helper.emit("up");
  for (let index = 0; index < 5; index += 1) await h.settle();
  assert.ok(!h.calls.includes("paste"));
  assert.equal(h.clipboard(), "hello world");
  assert.ok(h.overlay.states.includes("copied:Copied to clipboard"));
  h.advance(1000);
  assert.equal(h.clipboard(), "hello world");
});

test("ignores accidental taps and cancels when the hotkey is used for a shortcut", async () => {
  const tap = harness();
  tap.helper.emit("down");
  await tap.settle();
  tap.advance(120);
  tap.helper.emit("up");
  await tap.settle();
  assert.ok(tap.calls.includes("capture:cancel"));
  assert.ok(!tap.calls.includes("capture:stop"));
  assert.equal(tap.controller.state, "idle");

  const shortcut = harness();
  shortcut.helper.emit("down");
  await shortcut.settle();
  shortcut.advance(500);
  shortcut.helper.emit("cancel");
  await shortcut.settle();
  assert.ok(shortcut.calls.includes("capture:cancel"));
  assert.equal(shortcut.overlay.states.at(-1), "hidden");
});

test("toggle mode starts on one press and inserts on the next; Esc cancels", async () => {
  const h = harness({ mode: "toggle" });
  h.helper.emit("down");
  await h.settle();
  h.helper.emit("up");
  h.advance(3000);
  assert.equal(h.controller.state, "listening");
  h.helper.emit("down");
  for (let index = 0; index < 5; index += 1) await h.settle();
  assert.ok(h.calls.includes("paste"));

  const escape = harness({ mode: "toggle" });
  escape.helper.emit("down");
  await escape.settle();
  escape.helper.emit("up");
  escape.advance(2000);
  escape.helper.emit("escape");
  assert.equal(escape.controller.state, "idle");
  assert.equal(escape.overlay.states.at(-1), "cancelled:Cancelled");
});

test("leaves the text on the clipboard after pasting into a Chromium app", async () => {
  const h = harness({ focus: { editable: false, chromium: true, focusFound: false, bundleId: "com.tinyspeck.slackmacgap" } });
  h.helper.emit("down");
  await h.settle();
  h.advance(1000);
  h.helper.emit("up");
  for (let index = 0; index < 5; index += 1) await h.settle();
  assert.ok(h.calls.includes("paste"));
  assert.ok(h.overlay.states.includes("pasted:Pasted · also on clipboard"));
  h.advance(1000);
  assert.equal(h.clipboard(), "hello world");
});

test("reports silence and missing models instead of pasting", async () => {
  const silent = harness({ speech: 0 });
  silent.helper.emit("down");
  await silent.settle();
  silent.advance(1000);
  silent.helper.emit("up");
  for (let index = 0; index < 5; index += 1) await silent.settle();
  assert.equal(silent.overlay.states.at(-1), "empty:No speech heard");
  assert.ok(!silent.calls.includes("paste"));

  const noModel = harness({ preflight: () => "No transcription model is installed." });
  noModel.helper.emit("down");
  await noModel.settle();
  assert.deepEqual(noModel.overlay.states, ["error:No transcription model is installed."]);
  assert.ok(!noModel.calls.includes("capture:start"));
});

test("shares one warm transcriber between users and stops it when no longer needed", async () => {
  const created = [];
  const service = new TranscriberService({
    createTranscriber: (model) => {
      const transcriber = {
        model: model.id,
        child: null,
        stopped: false,
        start: async () => {
          transcriber.child = {};
        },
        stop: async () => {
          transcriber.stopped = true;
          transcriber.child = null;
        },
      };
      created.push(transcriber);
      return transcriber;
    },
  });
  const phonon = { id: "phonon" };
  const parakeet = { id: "parakeet" };

  await service.keepWarm(phonon);
  const meeting = await service.acquire(phonon);
  const dictation = await service.acquire(phonon);
  assert.equal(meeting, dictation);
  assert.equal(created.length, 1);
  await service.release(phonon);
  await service.release(phonon);
  assert.equal(created[0].stopped, false, "warm model stays loaded");

  await service.keepWarm(parakeet);
  assert.equal(created[0].stopped, true, "previous warm model is unloaded");
  await service.keepWarm(null);
  assert.equal(created[1].stopped, true);

  const cold = await service.acquire(phonon);
  cold.child = null; // the process crashed
  await service.release(phonon);
  const restarted = await service.acquire(phonon);
  assert.notEqual(restarted, cold);
  await service.stopAll();
});

test("talks to the native helper over JSON lines", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), kill() {} });
  const helper = new HotkeyHelper({ binaryPath: "/fake", spawnImpl: () => child });
  helper.start();
  const sent = [];
  stdin.on("data", (chunk) => sent.push(...chunk.toString().trim().split("\n").map((line) => JSON.parse(line))));

  helper.setHotkey({ keyCode: 115, modifiers: [] });
  const events = [];
  helper.on("down", () => events.push("down"));
  stdout.write('{"event":"down"}\n{"event":"status","accessibility":true,"tap":true}\n');
  const focus = helper.focus();
  await new Promise((resolve) => setImmediate(resolve));
  const focusCommand = sent.find((command) => command.cmd === "focus");
  stdout.write(`{"event":"focus","id":${focusCommand.id},"editable":true,"bundleId":"com.apple.Notes"}\n`);
  assert.equal((await focus).bundleId, "com.apple.Notes");

  const capture = helper.capture();
  stdout.write('{"event":"captured","keyCode":null,"modifiers":["fn"]}\n');
  assert.deepEqual(await capture, { keyCode: null, modifiers: ["fn"] });

  assert.deepEqual(events, ["down"]);
  assert.deepEqual(helper.status, { accessibility: true, tap: true });
  assert.deepEqual(sent[0], { cmd: "setHotkey", hotkey: { keyCode: 115, modifiers: [] }, name: "dictate" });
  const denied = helper.paste();
  await new Promise((resolve) => setImmediate(resolve));
  const pasteCommand = sent.find((command) => command.cmd === "paste");
  stdout.write(`${JSON.stringify({ id: pasteCommand.id, ok: false, error: "Windows blocked input" })}\n`);
  await assert.rejects(denied, /Windows blocked input/);
  helper.stop();
});

test("during a call, a dictated action item goes into the call's notes instead of being pasted", async () => {
  const lines = [];
  const { callNoteCommand } = require("../src/call-notes");
  const intercept = async (spoken) => {
    const command = callNoteCommand(spoken);
    if (!command) return null;
    lines.push(command.line);
    return "Action item added to the call";
  };
  const h = harness({ text: "Action item, Priya sends the pricing deck by Friday.", intercept });
  h.helper.emit("down");
  await h.settle();
  h.advance(1000);
  h.helper.emit("up");
  for (let index = 0; index < 5; index += 1) await h.settle();
  assert.ok(!h.calls.includes("paste"));
  assert.equal(h.clipboard(), "previous clipboard");
  assert.deepEqual(lines, ["Action item: Priya sends the pricing deck by Friday"]);
  assert.equal(h.overlay.states.at(-1), "pasted:Action item added to the call");
  assert.equal(h.controller.state, "idle");

  const plain = harness({ text: "see you tomorrow", intercept });
  plain.helper.emit("down");
  await plain.settle();
  plain.advance(1000);
  plain.helper.emit("up");
  for (let index = 0; index < 5; index += 1) await plain.settle();
  assert.ok(plain.calls.includes("paste"));
});
