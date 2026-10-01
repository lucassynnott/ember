---
name: Meeting Notes
description: A dark, quiet desktop companion where the call hangs off one calibrated rail and state is carried by line form.
colors:
  charcoal-ground: "#1a1c1e"
  charcoal-panel: "#1f2124"
  charcoal-popover: "#222327"
  charcoal-muted: "#232428"
  charcoal-secondary: "#26272c"
  charcoal-accent: "#2a2b30"
  bone-ink: "#e9e7e1"
  near-black-ink: "#18181b"
  ash: "#a2a2a5"
  faint-ash: "#8b8d92"
  rail-grey: "#8e9095"
  sodium-yellow: "#f4c542"
  rec-red: "#f0645f"
  destructive-red: "#e5484d"
  hairline: "rgb(255 255 255 / 8%)"
  hairline-sidebar: "rgb(255 255 255 / 7%)"
  input-edge: "rgb(255 255 255 / 12%)"
  focus-ring: "rgb(233 231 225 / 45%)"
typography:
  window-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 400
    letterSpacing: "-0.02em"
  section-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    letterSpacing: "-0.015em"
  reading:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.45
  speaker:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  transcript:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  note:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  timecode:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    fontFeature: "tnum"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.43
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "4.2px"
  md: "5.6px"
  lg: "7px"
  xl: "9.8px"
  pill: "20px"
  full: "999px"
spacing:
  hairline: "1px"
  tick-gap: "3px"
  xs: "6px"
  sm: "12px"
  md: "16px"
  row: "17px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.bone-ink}"
    textColor: "{colors.near-black-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-secondary:
    backgroundColor: "{colors.charcoal-secondary}"
    textColor: "{colors.bone-ink}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-ghost:
    textColor: "{colors.bone-ink}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-ghost-hover:
    backgroundColor: "{colors.charcoal-muted}"
  button-stop:
    backgroundColor: "{colors.rec-red}"
    textColor: "{colors.near-black-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 32px"
  input:
    backgroundColor: "{colors.charcoal-ground}"
    textColor: "{colors.bone-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "4px 12px"
  ready-panel:
    backgroundColor: "{colors.charcoal-ground}"
    rounded: "{rounded.xl}"
    width: "460px"
    padding: "36px 40px"
  popover:
    backgroundColor: "{colors.charcoal-popover}"
    textColor: "{colors.bone-ink}"
    rounded: "{rounded.xl}"
    padding: "16px"
  tooltip:
    backgroundColor: "{colors.bone-ink}"
    textColor: "{colors.charcoal-ground}"
    rounded: "{rounded.xl}"
    padding: "6px 12px"
  dictation-pill:
    backgroundColor: "{colors.charcoal-ground}"
    textColor: "{colors.bone-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 16px 0 14px"
  model-row:
    textColor: "{colors.bone-ink}"
    rounded: "0"
    padding: "16px 0 16px 20px"
---

# Design System: Meeting Notes

## Overview

**Creative North Star: "The Emission-Line Rail"**

Meeting Notes is a dark instrument that sits beside Zoom and stays quiet. Everything about a call hangs off one calibrated vertical rail: timecodes to its left, transcript lines hanging to its right, a hairline tick where each line attaches. State is read from the form of a line, not from colour. A spoken line is a solid hairline, listening is a dashed line, the person speaking now is a doubled tick, and the end of a call is a small terminal square. Colour is held back so that the two signals that matter, who is speaking and whether you are recording, are the only things that ever light up.

The ground is a charcoal continuum (four close steps from #1a1c1e to #2a2b30) with bone ink on top, muted ash for secondary text, and 8% white hairlines for every division. There are no cards, no avatars, no chat bubbles and no gradients in the working surfaces. One type family, the SF Pro system stack, is ranked purely by weight and size. The density is calm: generous row spacing on the rail (17px above and below each line), reading-size notes after the call, and a single status line at the foot of the window.

The same world carries into Settings (a native-feeling sidebar window whose model list is drawn as rows separated by hairlines, not boxes) and into the dictation pill, where the microphone level is drawn as nine yellow emission lines.

**Key Characteristics:**
- Dark only. Charcoal ground, bone ink, ash secondary, white hairlines at 7 to 12 percent.
- State by line form: solid tick, 6/4 dashed tick, doubled yellow tick, terminal square.
- Two signal colours with fixed jobs: sodium yellow for the voice happening now, red for recording.
- One family, SF Pro system stack, ranked by weight. Tabular figures for every timecode and counter.
- Flat surfaces divided by hairlines; elevation only for transient overlays.
- Motion is small and functional: the live tick glides, new lines fade up.

## Colors

A near-monochrome charcoal and bone palette in which two saturated signals, sodium yellow and recording red, each have one job.

### Primary
- **Bone Ink** (bone-ink): the default text colour and the fill of primary buttons, switches when on, and progress bars. Also the solid past tick on the rail (drawn at 75% opacity) and the participant tick (60%). Body copy in the transcript and notes sits at 88 to 90 percent opacity of this ink.

### Secondary
- **Sodium Yellow** (sodium-yellow): the voice happening now. It appears as the doubled 2px tick on the rail line of the current speaker, the matching doubled tick beside that name in Participants, and the nine level lines in the dictation pill while listening. Nothing else in the working surfaces is yellow.

### Tertiary
- **Rec Red** (rec-red): recording. The REC dot and label in the title bar and the fill of the Stop button (with near-black ink on it). The build also uses it as the error and blocked-state text colour: "Microphone access needed" in the status bar, the dictation Accessibility warning, the Settings save error, and the pill's error icon.
- **Destructive Red** (destructive-red): confirm-to-remove actions inside alert dialogs only (Remove model, Remove key), as a tinted button at 20% fill.

### Neutral
- **Charcoal Ground** (charcoal-ground): the window background in every window, the ready panel's interior, the dictation pill (at 95%), and the knockout behind the live tick so it reads over the rail.
- **Charcoal Panel** (charcoal-panel): the Settings sidebar and card tokens.
- **Charcoal Popover** (charcoal-popover): popovers, dialogs and the model search.
- **Charcoal Muted / Secondary / Accent** (charcoal-muted, charcoal-secondary, charcoal-accent): ghost hover, secondary buttons, and the active Settings sidebar row respectively. They are one step apart on purpose; the ground is a continuum, not layers.
- **Ash** (ash): secondary text: status line, descriptions, "Speaking now", the after-call transcript body.
- **Faint Ash** (faint-ash): timecodes, empty-state lines in the notes column, model meta lines, "Listening for more speech…".
- **Rail Grey** (rail-grey): the vertical rail and its dashes.
- **Hairline** (hairline), **Sidebar Hairline** (hairline-sidebar), **Input Edge** (input-edge): every border and divider. **Focus Ring** (focus-ring): the 2px focus outline and 3px control ring.

### Named Rules
**The One Voice Rule.** Sodium yellow marks the person speaking now and the live microphone level. It is never used for emphasis, links, buttons, headings or selection states.

**The Red Means Recording Rule.** Rec red belongs to REC and Stop. Where something has gone wrong it may colour the message text, but it is never a fill anywhere except the Stop button.

**The Charcoal Continuum Rule.** Surfaces separate by one tonal step or a hairline, never by a shadow or a card.

## Typography

**Display Font:** none distinct. **Body Font:** SF Pro via the system stack (-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", system-ui, sans-serif). **Label/Mono Font:** the same family with tabular figures.

**Character:** One grotesque in two weights (400 and 600, with 500 for buttons and the pill). Hierarchy comes from weight and a short size ladder, which keeps the window feeling like a native Mac tool. The root size is 14px.

### Hierarchy
- **Window title** (400, 21px, tracking -0.02em): the meeting title in the title bar, for example "Meeting, Thu 12:07".
- **Section title** (600, 20px, tracking -0.015em): Settings page headings.
- **Reading** (400, 17px, 1.45): notes after the call, when the notes column widens to take over.
- **Speaker** (600, 16px): speaker names on the live rail. After the call the name drops to 14px semibold inline with the line.
- **Transcript** (400, 16px, 1.5, max 560px): live transcript lines.
- **Note** (400, 15px, 1.45): live notes lines in the left column.
- **Label** (600, 14px): notes headings (Summary, Decision, Actions, Participants). After the call they turn ash.
- **Timecode** (400, 14px, tabular): rail timecodes, the REC timer, "Ended" duration, download progress.
- **Body** (400, 13px): descriptions, the pill label (500), busy messages.
- **Meta** (400, 12px): model meta, "Live" or "After the call", "Speaking now".

### Named Rules
**The Weight Not Face Rule.** Rank by weight and size inside the one system family. Never introduce a second family or a display face.

**The Tabular Clock Rule.** Every timecode, timer, byte count and percentage uses tabular figures so numbers do not jitter while they change.

## Layout

The main window is three bands: a 52px title bar (left inset 96px for the traffic lights), the working area, and a 64px status footer. During a call the working area is a notes column at 26% (300 to 360px, 230px minimum under 900px) divided by a hairline from the rail. After the call the notes column widens to 46% and switches to reading size.

The rail is a three-column grid: 52px timecode, 34px tick, then the line (gap 16px). Under 900px it tightens to 42px, 26px and 12px. Each row draws its own stretch of the rail, so a solid segment runs through spoken rows and a dashed segment runs through the listening row to the bottom of the window. Rows breathe at 17px top and bottom while live, and compress to 6px after the call.

Settings is a 212px sidebar beside a scrolling page capped at 680px with 40px side padding. Fields stack with hairline separators. The dictation pill is 40px tall, up to 400px wide, centred.

## Elevation & Depth

The working surfaces are flat. Depth is conveyed by the charcoal continuum and hairlines. Shadows exist only on things that float above another app or another window.

### Shadow Vocabulary
- **Pill lift** (`box-shadow: 0 8px 24px rgb(0 0 0 / 0.35)`): the dictation pill, which floats over whatever app has focus.
- **Overlay** (Tailwind shadow-2xl plus a 1px ring at 5% bone): popovers and select menus. Dialogs use the ring alone.

### Named Rules
**The Flat Window Rule.** Nothing inside the main window or Settings casts a shadow. If it needs separating, use a hairline.

## Shapes

Corners are quiet and small. With the 14px root, the base radius is 7px. Controls (buttons, inputs, toggles, badges, progress tracks, dialogs) use the medium radius (5.6px). Floating and framing surfaces (the ready panel, popovers, select menus, tooltips, skeleton bars, outline items) use the extra-large radius (9.8px). The dictation pill is a full capsule (20px on a 40px height). Switches and the scrollbar thumb are fully round.

The rail's own marks are square-ended: 1px hairline ticks, 2px doubled ticks with a 3px gap, 6px dash and 4px gap, and a 7px solid square that terminates the rail. The selected model in Settings is marked by a 12px bone hairline at the row's left edge, the same tick language.

## Components

### Buttons
- **Shape:** gently rounded (5.6px).
- **Primary:** bone fill, near-black ink, 36px tall, 12px side padding, 500 weight. Hover drops to 80% fill. Used for Start recording and Download.
- **Secondary:** charcoal-secondary fill, bone ink; hover mixes in 5% bone. Grant access, Use, Open note, Choose…
- **Ghost:** no fill; hover takes charcoal-muted at 50%. Cancel, Remove, the folder and settings icons.
- **Stop:** rec red fill, near-black ink, 36px tall, 32px side padding, 15px label. The only filled red surface in the app.
- **Focus / Active:** 3px ring at half the focus colour; pressed buttons nudge down 1px.

### Inputs / Fields
- **Style:** 36px tall, 5.6px radius, 12% white edge, 30% input-tint fill, 13px text.
- **Focus:** border takes the focus colour with a 3px ring at 50%.
- **Error / Disabled:** destructive border and ring; disabled at 50% opacity.

### Navigation
- **Settings sidebar:** 212px, charcoal panel, hairline right edge. Rows are 13px with a 16px Hugeicons stroke icon; the active row takes charcoal-accent and 500 weight. No other navigation exists; the main window's controls live in the title bar and status line.

### Ready panel
A 460px panel centred in the empty window, 9.8px radius, with a 1px border drawn as a conic gradient that runs from 7% white through bone to 85% white and back, travelling around the edge every 7 seconds. Under reduced motion it stops at a fixed angle (300deg). Inside: the audio-wave icon tile, "Ready when your call starts" at 17px, and outline rows for any missing permission with a Grant access button.

### Rail (signature component)
- **Past tick:** 34px by 1px bone at 75%, solid rail through the row.
- **Listening tick:** 34px dashed line (6px on, 4px off) in rail grey, with a dashed rail continuing to the bottom; timecode reads "--:--" in faint ash; italic "Listening for more speech…".
- **Live tick:** two 2px sodium-yellow bars 3px apart, knocked out of the rail with the ground colour. A single instance glides to the current speaker's row with a 300ms transform on cubic-bezier(0.2, 0.8, 0.2, 1).
- **End mark:** a 7px square in bone at 70%, closing the rail after the call.
- **New line:** the newest line fades and slides up 4px over 200ms ease-out.

### Participants
Names at 14px with the same tick language: a 14px hairline at 60% bone for each person, the doubled yellow tick and an ash "Speaking now" for the active speaker.

### Model list (Settings)
Line form, not cards. Rows sit on a hairline top rule and are separated by hairline bottom rules with no radius or fill. Each row: 14px name, 12px faint "Live" or "After the call", "In use" in bone when selected, 12px meta and detail lines, a 4px bone progress bar with tabular byte counts while downloading, and actions on the right.

### Dictation pill
A 40px capsule at 95% ground with a 10% white edge and the pill lift shadow, 13px medium label. Listening shows nine 1px yellow level lines (18px tall, 3px apart) whose height follows the microphone on a sine profile, updating with 75ms linear transitions. Transcribing shows a spinner; pasted and copied show a bone tick or copy icon; errors show a red alert icon. It enters by fading in and rising 6px over 150ms.

## Do's and Don'ts

### Do:
- **Do** show state with line form first: solid 1px for done, 6/4 dashes for waiting, doubled 2px for live, a 7px square for ended.
- **Do** keep sodium yellow to the current speaker's doubled tick and the dictation level lines.
- **Do** keep rec red to REC, the recording timer label and Stop; use it only as text for errors.
- **Do** use tabular figures for every timecode, timer and download count.
- **Do** separate regions with 8% white hairlines and one-step charcoal changes.
- **Do** use the 5.6px radius for controls and 9.8px for floating or framing surfaces.
- **Do** honour reduced motion: transitions collapse to near zero and the ready border stops at a fixed angle.
- **Do** write UI copy plainly, with no em dashes and no hype words.

### Don't:
- **Don't** add a light theme; the app is dark only.
- **Don't** put list content in cards, add avatars, chat bubbles or gradients to the working surfaces. The ready panel's moving border is the one gradient, and it stays a 1px grey to white edge.
- **Don't** use yellow for focus, selection, links, buttons or emphasis.
- **Don't** introduce a second typeface or a display face.
- **Don't** cast shadows inside the main window or Settings; shadows are for the pill and transient overlays only.
- **Don't** animate more than the live tick, the arriving line, the pill and the ready border.
