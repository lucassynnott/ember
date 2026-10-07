export function shortcutLabel(key: string, platform = window.meetingRecorder.platform): string {
  const mac = platform === "darwin"
  const names: Record<string, string> = mac
    ? { mod: "⌘", shift: "⇧", alt: "⌥", space: "Space", backspace: "⌫", delete: "⌦", tab: "Tab" }
    : { mod: "Ctrl", shift: "Shift", alt: "Alt", space: "Space", backspace: "Backspace", delete: "Delete", tab: "Tab" }
  return key.split("+").map(part => names[part] || part.toUpperCase()).join(mac ? "" : "+")
}
