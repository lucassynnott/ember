// Pastel colours that tell speakers apart on the dark background. Gold is left out because it
// marks the live line. Each passes WCAG AA against --background.
export const SPEAKER_PALETTE = [
  "#9ccfe8", // sky
  "#f2b5a7", // coral
  "#b4dcb0", // mint
  "#c9b8f0", // lavender
  "#f5c99b", // peach
  "#9fd9cf", // aqua
  "#f0b6d2", // pink
  "#c5d49a", // sage
]

/**
 * Gives each speaker a colour in the order they first speak, so the first eight never share one.
 * Your own name (and unknown lines) keep the normal text colour.
 */
export function speakerColors(speakers: (string | null | undefined)[], self?: string | null) {
  const colors = new Map<string, string>()
  for (const speaker of speakers) {
    if (!speaker || speaker === self || colors.has(speaker)) continue
    colors.set(speaker, SPEAKER_PALETTE[colors.size % SPEAKER_PALETTE.length])
  }
  return colors
}
