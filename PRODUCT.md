# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron desktop app for macOS (Apple Silicon, macOS 14.4+). The interface is web technology inside Electron windows: a menu-bar tray app with a main live-notes window, a Settings window, and a floating dictation pill.

## Stack

Vite + React with shadcn/ui components and Tailwind CSS (user's choice; `bunx --bun shadcn@latest init -t vite`). Only shadcn components are used for UI. Electron main process, native Swift/Rust helpers and the preload bridges (`window.meetingRecorder`, `window.dictation`) are unchanged.

## Users

The owner (an agency operator who runs many Zoom coaching, sales and team calls a day) and other people who install it from GitHub and set it up from scratch. They use it in two situations: during a live call, glancing at it beside Zoom, and anywhere on the Mac when dictating into another app.

## Product Purpose

Records meetings privately and turns them into notes without the user doing anything: live on-device transcription with speaker names, AI notes (summary, decisions, action items with owners) during and after the call, Markdown saved locally, and an optional copy saved to Notion. Separately, a global dictation shortcut turns speech into text typed into whatever field has focus. Success is the user forgetting the tool is there until the notes arrive.

## Positioning

Transcription runs on the Mac (Phonon-2 or Parakeet) rather than a cloud bot joining the call; there are no accounts or telemetry. It names Zoom speakers from Zoom's own active-speaker signal and never guesses. Meeting notes and dictation share one locally loaded model.

## Operating Context

- Lives in the macOS menu bar (`MN`, `REC` while recording). The main window sits beside a Zoom window during calls; recording can start automatically when a Zoom meeting begins.
- Settings: transcription model downloads (Phonon-2, Parakeet v3/v2, Whisper) with progress, dictation shortcut recorder and mode, Zoom automation, Notion database, notes folder, OpenRouter key and model search, speaker name.
- Dictation pill: non-activating, bottom of the screen; states listening (mic level), transcribing, pasted, copied, no speech, cancelled, error.
- Permissions it depends on: Microphone, Screen & System Audio Recording, Accessibility.

## Capabilities and Constraints

- Main window states: idle, starting (model loading), recording, stopping, processing, plus permission and Zoom status (mic, system audio, Zoom names, active speaker, Zoom auto).
- Transcript segments carry timestamp, speaker and source (microphone vs system).
- Live notes update during the call once there is enough conversation.
- Settings must feel like a proper macOS settings window, not one long scroll.
- The dictation pill must never take focus from the app being typed into.
- Must be calm and low-distraction while recording, next to Zoom.

## Brand Commitments

- Name: Meeting Notes. Tray title `MN`.
- Copy: plain and direct. No em dashes in UI copy. No hype words.
- Must not look like a generic AI app: no purple gradients, glow, or template-dashboard feel.
- Dark mode only.

## Evidence on Hand

- Real app screenshots in `docs/` use a fictional meeting (Alex Rivera, Priya Shah, Jordan Lee); keep demonstration content fictional and clearly sample data.
- No customers, testimonials, metrics or pricing exist; never invent them.

## Product Principles

1. The call comes first: the app stays quiet and glanceable while someone is talking.
2. Local and private by default; say plainly when anything leaves the Mac.
3. Never guess: unknown speakers stay "Remote speaker", uncertain states are stated.
4. Setup should be possible for a stranger without reading the README.
5. Frequent actions (start, stop, open notes, switch model) are one step away.

## Accessibility & Inclusion

Dark appearance only (user decision, re-roll steer): the app is used beside Zoom, often in dim rooms. WCAG AA contrast in dark. Respects reduced motion. Keyboard reachable controls in Settings.
