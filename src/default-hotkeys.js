// Keep persisted key codes compatible with the existing shortcut editor.
function defaultHotkeys(platform = process.platform) {
  const chord = (keyCode, keyName) => ({ keyCode, keyName, modifiers: ["leftControl", "leftOption"] });
  if (platform === "win32") return {
    dictate: { keyCode: null, modifiers: ["rightControl"] },
    ask: chord(0, "a"), command: chord(14, "e"), liveHelp: chord(38, "j"),
    grab: chord(19, "2"), clipboard: chord(9, "v"), save: chord(1, "s"), record: chord(15, "r"),
  };
  return {
    dictate: { keyCode: null, modifiers: ["rightOption"] },
    ask: { keyCode: null, modifiers: ["rightCommand"] },
    command: { keyCode: null, modifiers: ["rightOption", "rightCommand"] },
    liveHelp: { keyCode: null, modifiers: ["rightCommand", "rightShift"] },
    grab: { keyCode: 19, modifiers: ["leftCommand", "leftShift"], keyName: "2" },
    clipboard: { keyCode: 9, modifiers: ["leftCommand", "leftControl"], keyName: "v" },
    save: { keyCode: 1, modifiers: ["leftCommand", "leftControl"], keyName: "s" },
    record: { keyCode: 15, modifiers: ["leftCommand", "leftControl"], keyName: "r" },
  };
}
module.exports = { defaultHotkeys };
