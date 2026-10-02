const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { VoiceAskController } = require("../src/voice-ask");
const { HotkeyHelper } = require("../src/hotkey");

function fakes({ samples = new Float32Array(16000).fill(0.1), transcript = "um what did harry say" } = {}) {
  const helper = Object.assign(new EventEmitter(), { escape: [], setDictating(active, owner) { this.escape.push([active, owner]); } });
  const pill = [];
  const overlay = {
    show: (state, message) => pill.push([state, message]),
    hide: () => pill.push(["hidden"]),
    startCapture: async () => {},
    stopCapture: async () => samples,
    cancelCapture: () => pill.push(["cancel"]),
  };
  const card = Object.assign(new EventEmitter(), {
    visible: false,
    states: [],
    show(state) { this.visible = true; this.states.push({ ...state }); },
    update(change) { this.states.push({ ...this.states.at(-1), ...change }); },
    hide() { const was = this.visible; this.visible = false; if (was) this.emit("closed"); },
  });
  let now = 0;
  const controller = new VoiceAskController({
    helper,
    overlay,
    card,
    transcribe: async () => transcript,
    clean: async (text) => text.replace(/^um /, "").replace(/^w/, "W"),
    answer: async ({ question, onDelta }) => {
      onDelta("Harry said ");
      onDelta("the video was blank [[2026-09-30-1701]].");
      return { text: `Harry said the video was blank [[2026-09-30-1701]]. (${question})` };
    },
    getSettings: () => ({ dictationMode: "hold" }),
    now: () => now,
    timers: { setTimeout: (fn, ms) => (ms === 150 ? fn() : 1), clearTimeout: () => {} },
  });
  return { helper, overlay, card, pill, controller, advance: (ms) => (now += ms) };
}

test("holding the Ask shortcut asks a spoken question and shows the answer", async () => {
  const { helper, card, pill, controller, advance } = fakes();
  helper.emit("ask:down");
  await new Promise(setImmediate);
  assert.deepEqual(pill[0], ["listening", "Ask your meetings"]);
  advance(1200);
  helper.emit("ask:up");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(card.visible, true);
  assert.equal(card.states[0].question, "What did harry say");
  assert.equal(card.states.at(-1).status, "done");
  assert.match(card.states.at(-1).text, /\[\[2026-09-30-1701\]\]/);
  assert.equal(controller.state, "idle");
  assert.deepEqual(helper.escape.at(-1), [true, "ask"], "Esc stays caught while the card is open");

  helper.emit("escape");
  assert.equal(card.visible, false);
  assert.deepEqual(helper.escape.at(-1), [false, "ask"]);
});

test("a tap, a shortcut chord or silence doesn't ask anything", async () => {
  const tap = fakes();
  tap.helper.emit("ask:down");
  tap.advance(100);
  tap.helper.emit("ask:up");
  await new Promise(setImmediate);
  assert.equal(tap.card.visible, false);
  assert.ok(tap.pill.some(([state]) => state === "cancel"));

  const chord = fakes();
  chord.helper.emit("ask:down");
  chord.helper.emit("ask:cancel");
  assert.equal(chord.controller.state, "idle");

  const quiet = fakes({ samples: new Float32Array(16000) });
  quiet.helper.emit("ask:down");
  quiet.advance(1000);
  quiet.helper.emit("ask:up");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(quiet.pill.at(-1), ["empty", "No question heard"]);
  assert.equal(quiet.card.visible, false);
});

test("the hotkey helper routes each named shortcut to its own events", () => {
  const helper = new HotkeyHelper({ binaryPath: "/nonexistent" });
  const seen = [];
  for (const name of ["down", "up", "ask:down", "ask:up", "ask:cancel", "escape"]) helper.on(name, () => seen.push(name));
  helper.ingest(
    ['{"event":"down","hotkey":"dictate"}', '{"event":"up","hotkey":"dictate"}', '{"event":"down","hotkey":"ask"}', '{"event":"cancel","hotkey":"ask"}', '{"event":"escape"}', ""].join("\n"),
  );
  assert.deepEqual(seen, ["down", "up", "ask:down", "ask:cancel", "escape"]);

  const sent = [];
  helper.child = { stdin: { writable: true, write: (line) => sent.push(JSON.parse(line)) } };
  helper.setDictating(true, "dictate");
  helper.setDictating(true, "ask");
  helper.setDictating(false, "dictate");
  assert.equal(sent.at(-1).active, true, "Esc stays caught while the Ask card is open");
  helper.setDictating(false, "ask");
  assert.equal(sent.at(-1).active, false);
});
