<div align="center">

# Meeting Notes

### On-device meeting notes and dictation for macOS

**One app instead of Granola and Wispr Flow.**<br>
Transcribe and summarise any call live, ask questions about every call you've had, and hold a hotkey to type or edit by voice in any app.

[![Download](https://img.shields.io/badge/download-latest%20release-d9b25f?style=flat-square)](https://github.com/lucassynnott/meeting-notes/releases/latest)
![macOS 14.4+](https://img.shields.io/badge/macOS-14.4%2B-171717?style=flat-square&logo=apple)
![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-arm64-171717?style=flat-square)
![License: MIT](https://img.shields.io/badge/license-MIT-eeeae0?style=flat-square)

<img src="docs/screenshot.png" alt="Meeting Notes recording a call: your notes, the running summary, decisions and actions on the left, and the live transcript on a vertical rail on the right, with each speaker in their own colour and a gold tick marking who is speaking now" width="900">

[Install](#install) · [Why](#one-app-instead-of-two) · [Features](#features) · [Tour](#a-look-around) · [Calls](#how-it-works) · [Dictation](#dictation) · [Models](#transcription-models) · [Notion](#save-calls-to-notion) · [Privacy](#privacy) · [Development](#development)

</div>

---

## One app instead of two

| You'd use | For | Meeting Notes does it with |
|---|---|---|
| **Granola** | Meeting notes | Live on-device transcription of calls in any app, speakers told apart by voice, your own notes filled in from the transcript, a running summary with decisions and action items, prep cards before calls, and answers to any question about past calls |
| **Wispr Flow** | Speech to text anywhere | Hold a hotkey in any app and speak: the text is cleaned up, matched to the app's style and typed where your cursor is. Select text and say what to change to rewrite it |

Everything runs on one shared on-device model, so there's no monthly subscription and your audio never leaves your Mac. The AI parts (notes, Ask, prep, digests, drafts, AI cleanup) use your own [OpenRouter](https://openrouter.ai) key, so only text goes to the model you pick. See [Privacy](#privacy) for exactly what.

## Features

**Calls**

<table>
<tr><td width="30%">🎙️ <b>Live, on-device transcription</b></td><td>Phonon-2 or Parakeet transcribe while you talk, entirely on your Mac. Download models with one click.</td></tr>
<tr><td width="30%">📹 <b>Records any call</b></td><td>Auto-record for Zoom, Google Meet, Microsoft Teams, Slack huddles, FaceTime, Webex, Discord, WhatsApp, Signal, Telegram and more, in the app or the browser. It starts a few seconds into the call and stops when it ends.</td></tr>
<tr><td width="30%">👥 <b>Speaker names</b></td><td>Your side is labelled with your name. Other people are told apart by voice on your Mac (Speaker 1, Speaker 2…); name someone once and later calls recognise them. Zoom calls use Zoom's names and teach the app those voices. Each speaker gets their own colour.</td></tr>
<tr><td width="30%">📝 <b>Notes as the call unfolds</b></td><td>A running summary, decisions and action items with owners. Type your own notes during the call, and each line is filled in from the transcript afterwards.</td></tr>
<tr><td width="30%">🧭 <b>Live help</b></td><td>Ask during a call: “what should I ask next?”, “how do I handle that objection?”, “sum up the call so far”. Answers come from the call so far, your knowledge base and earlier calls with these people, in a couple of glanceable lines. Type it, or hold Right ⌘ and ask quietly; your spoken question is kept out of the transcript.</td></tr>
<tr><td width="30%">🖼️ <b>See what was shared</b></td><td>When someone shares slides or a document, each new one is saved with its text (read on your Mac). The notes get a Shared on screen section with the images, live help knows what's on screen, and the images go into the Notion page too.</td></tr>
<tr><td width="30%">📚 <b>Knowledge base</b></td><td>Point it at folders of your own documents (sales playbooks, call scripts, product notes, training transcripts in Markdown, PDF, Word and more). Live help, Ask and prep cards use them and cite the file. Read and searched on your Mac.</td></tr>
<tr><td width="30%">📅 <b>Calendar</b></td><td>Calls take their calendar event's name and list who was invited. Two minutes before a call, a prep card recaps your last calls with those people (or the last two of a repeating call) and what's still open, with an Open Zoom & join button.</td></tr>
<tr><td width="30%">✉️ <b>Follow-ups and digests</b></td><td>One click drafts the follow-up email or Slack message. Every Friday afternoon a weekly digest sums up the week's calls, decisions and open action items.</td></tr>
<tr><td width="30%">🗂️ <b>Save to a folder or Notion</b></td><td>Every call becomes a Markdown note, a page in a Notion database, or both.</td></tr>
</table>

**Your calls, afterwards**

<table>
<tr><td width="30%">🏠 <b>Home</b></td><td>Your week at a glance: calls per day, time in calls, words spoken and your share of the talking, words dictated and typing time saved, your open action items, who you met, and today's calendar.</td></tr>
<tr><td width="30%">📚 <b>Meetings</b></td><td>Every past call with its notes and transcript. Search everything, rename calls, file them in folders and tag them, and rename speakers.</td></tr>
<tr><td width="30%">💬 <b>Ask your meetings</b></td><td>Ask “What did I promise Harry?” and get an answer that links to the calls it came from. Ask about everything, one folder or one meeting, from the Meetings page or out loud from any app with Right ⌘.</td></tr>
</table>

**Dictation**

<table>
<tr><td width="30%">⌨️ <b>Dictate anywhere</b></td><td>Hold a hotkey (fn, Right ⌥, F5, Home… anything), speak, and the text is typed into whatever field you're in, or copied if there isn't one.</td></tr>
<tr><td width="30%">✨ <b>Cleanup and style</b></td><td>Fillers and stutters are removed on your Mac. AI cleanup also applies your corrections (“Tuesday, no wait, Wednesday”) and matches the app: casual in Slack, professional in Mail, exactly as said in code editors.</td></tr>
<tr><td width="30%">✏️ <b>Edit by voice</b></td><td>Select text in any app, hold Right ⌥ + Right ⌘ and say “make this shorter” or “translate to Spanish”. The selection is rewritten in place.</td></tr>
<tr><td width="30%">📖 <b>Your dictionary</b></td><td>Teach it names and words it mishears; they're fixed in dictation, transcripts and notes.</td></tr>
</table>

**And**

<table>
<tr><td width="30%">🚀 <b>Always ready</b></td><td>Opens at login if you like, waiting in the menu bar as a small waveform that shows a glowing red dot while it records. Updates install themselves.</td></tr>
<tr><td width="30%">🔒 <b>Local by default</b></td><td>Audio, notes and voice prints stay on your Mac. No accounts, telemetry or analytics.</td></tr>
</table>

## A look around

**Home.** Your week at a glance: calls, time in calls, words spoken and your share of the talking, words dictated, your open action items, who you met, and today's calendar with Join buttons.

<p align="center"><img src="docs/home.png" alt="The Home page: a Ready when your call starts panel beside today's calendar with a gold now line and Join buttons, then tiles for calls this week with a Monday to Sunday chart, time in calls, words spoken, words dictated, open action items and who you met" width="900"></p>

**Meetings and Ask.** Every past call with its notes and transcript. Ask a question in plain English and the answer lists the calls it came from, each with an Open meeting note button.

<p align="center"><img src="docs/meetings-ask.png" alt="The Meetings page with the Ask bar open: the answer to What did I agree to do this week, followed by the three calls it used, each with an Open meeting note button" width="900"></p>

**Prep before calls.** Two minutes before a call, a card recaps your last calls with those people (or the last two in a repeating series) and what's still open. Open Zoom & join takes you straight into the meeting. The same card answers questions you ask out loud with Right ⌘.

<p align="center"><img src="docs/prep-card.png" alt="The prep card before an Acme renewal call: a recap of the last two calls, what's still open for you and for Dana, something worth raising, the calls it came from, and an Open Zoom and join button" width="560"></p>

**Weekly digest.** Every Friday afternoon: the week in brief, decisions, open action items with yours first, and everyone you met, each linked to its call.

<p align="center"><img src="docs/weekly-digest.png" alt="The Weekly digest page for the week of 28 September: the week in brief, decisions, open action items and people, each linked to its call" width="900"></p>

## Install

> **Requires** an Apple Silicon Mac on macOS 14.4 or later.

1. Download **`Meeting-Notes-<version>-arm64.dmg`** from the [latest release](https://github.com/lucassynnott/meeting-notes/releases/latest) and drag **Meeting Notes** into Applications.
2. The app is signed with a Developer ID but **not notarized**. The first time you open it, right-click **Meeting Notes** in Applications, choose **Open**, then **Open** again.
   <sub>If macOS still refuses: `xattr -dr com.apple.quarantine "/Applications/Meeting Notes.app"`</sub>
3. A short welcome window walks you through the rest in about two minutes: your name, the **Microphone**, **Screen & System Audio Recording** and **Accessibility** permissions (each explained when it's asked for), downloading a transcription model, an optional [OpenRouter](https://openrouter.ai) key for AI notes, where notes go (a folder, Notion or both) and dictation. You can reopen it any time from the waveform in the menu bar: **Welcome & Setup…**

**Updates are automatic.** Meeting Notes checks for a new version every few hours, downloads it in the background and installs it the next time you restart the app. It never restarts during a call. **Settings → Updates** shows your version and has **Check for updates** and **Restart to update**. Copies older than 1.4.0 need this one download by hand; after that they update themselves.

## How it works

1. **Start recording**, or let it start on its own when a call begins in Zoom, Meet, Teams, Slack, FaceTime or another call app. The waveform in the menu bar gets a glowing red dot while it runs, and the sidebar shows **Recording**.
2. Your microphone and the Mac's system audio are recorded together and transcribed separately, so your words are always labelled with your name. The other side is told apart by voice, or named by Zoom.
3. Live notes refresh during the call, and you can type your own notes beside them. If calendar access is on, the call takes its event's name.
4. When it ends, Meeting Notes tidies the speaker labels, fills in your notes, and writes `YYYY-MM-DD-HHMM.md` (title, your notes, summary, decisions, action items and the full transcript) next to the `.webm` audio. It saves to Notion too if you've turned that on. Calls saved only to Notion keep a local copy, so they still appear on the Meetings page.

<details>
<summary><b>Recording calls automatically</b></summary>

- Turn it on in **Settings → Meetings → Record calls automatically**.
- **Zoom** is read through Accessibility: recording starts 2.5 seconds after Zoom shows an active meeting with someone in it, carries on through screen sharing, and stops 5 seconds after the meeting and sharing windows have gone.
- **Other apps** are noticed when they start using your microphone: Microsoft Teams, Slack huddles, FaceTime, Webex, Discord, WhatsApp, Signal, Telegram, Tuple, Around, GoTo, RingCentral and Amazon Chime.
- **Browser calls** (Google Meet, Teams, Zoom, Whereby, Jitsi and Webex in Chrome, Safari, Arc, Helium and others) count once the browser uses the microphone while showing the meeting tab. Switching tabs afterwards keeps the recording going.
- A call ends 15 seconds after its app lets go of the microphone, so a brief drop doesn't split the recording. Native apps also count as still in the call while they play call audio, so muting doesn't stop it.
- Automatic recordings only stop on their own; recordings you start yourself never stop when an app closes. Pressing **Stop** pauses automation until that call ends.

</details>

<details>
<summary><b>Speaker names</b></summary>

- **You:** the microphone you choose in **Settings → General** (the system default or a named input, with a level test).
- **Zoom:** a small native observer reads participant names and the active-speaker indicator from the macOS Accessibility tree. A segment is named only when one speaker clearly dominates it.
- **Everyone else:** each stretch of the other side's speech gets a voice print (a [WeSpeaker](https://github.com/wenet-e2e/wespeaker) model run with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), downloaded once, 26 MB). Prints that sound alike become Speaker 1, Speaker 2… and are tidied when the call ends.
- **Naming people:** click a speaker on the Meetings page and type who it is. The whole note is updated and their voice is remembered, so later calls name them. Voices from Zoom calls are learned automatically. A known name is only used when the match is clear; otherwise it stays Speaker 2.
- **Settings → Meetings** lists known voices with a Forget button. Voice prints can't be turned back into audio.

</details>

<details>
<summary><b>Calendar, prep cards and the weekly digest</b></summary>

- Turn on **Settings → Meetings → Name calls from your calendar**. It reads the Calendar app on your Mac, including Google and Outlook accounts added in System Settings, so macOS asks for Calendar access once.
- A recording takes the name of the event it falls in (one with a call link, other attendees or a meeting-like title) and the note lists who was invited. Their names help the AI spell them and are suggested when you name a speaker.
- **Prep cards:** about two minutes before a call with people you've met, a card recaps your last calls with them and what's still open. For a repeating event it recaps the last two calls in the series. **Open Zoom & join** opens Zoom straight into the meeting; Meet and Teams links open those. First calls stay quiet.
- **Weekly digest:** on Fridays from 4 pm the week's calls are summed up on the **Weekly digest** page, with a copy in a `Weekly digests` folder beside your notes, where `[[call]]` links open each call's note in Obsidian.

</details>

## Dictation

Speech to text anywhere on your Mac, like Wispr Flow, but transcribed on-device. Turn on **Settings → Dictation**, then hold the shortcut anywhere on your Mac, speak, and let go. A small pill at the bottom of the screen shows that it's listening. Your words are then:

- **typed into the text field you're in**: the app pastes with ⌘V and then restores whatever was on your clipboard before; or
- **copied to the clipboard** when no text field is focused (or it's a password field). The pill says so.

| Setting | Options |
|---|---|
| Shortcut | Any key or combination: fn, left or right ⌘ ⌥ ⌃ ⇧ on their own, F1–F20, Home, End, Page Up/Down, Ins, Del, letters, Space… Click **Change…** and press it. |
| Mode | **Hold to talk** (release to insert) or **Press to start, press again to insert** |
| Clipboard | Optionally keep the dictated text on the clipboard after pasting |

- **Cancel:** Esc cancels a dictation. A modifier-only shortcut such as Right ⌥ is cancelled automatically when you use it in a normal shortcut (Right ⌥+2 still types €), and taps shorter than 0.3 s are ignored.
- **Model:** dictation uses the transcription model selected below and keeps it loaded while dictation is on, so text appears about half a second after you let go. Phonon-2 uses about 1.1 GB of memory while loaded.
- **Terminals:** apps that draw their own text (Terminal, iTerm2, Warp, Ghostty and others) are always pasted into.
- **Using fn on its own:** set **System Settings → Keyboard → Press 🌐 key to** “Do Nothing” so macOS doesn't also open the emoji picker.
- **Permissions:** dictation needs **Accessibility** (to see the shortcut and paste) and **Microphone**.

**Clean up, style and your dictionary.** **Light** cleanup removes ums and stutters on your Mac. **AI** cleanup also applies your corrections ("Tuesday, no wait, Wednesday") and fixes punctuation in about half a second, falling back to Light if it's slow. With AI on, **Style by app** makes dictation casual in chat apps, professional in email, and exactly as said in code editors and terminals, where spoken symbols become characters ("dash b" becomes `-b`). You can add your own apps. **Settings → Dictionary** holds names and words it mishears, with what they're often heard as.

**Two more shortcuts**, set in **Settings → Dictation**:

| Shortcut | Default | Does |
|---|---|---|
| Ask | Right ⌘ | Ask a question about your meetings out loud. The answer appears in a card above the pill, with links to the calls it used. Esc closes it. |
| Edit | Right ⌥ + Right ⌘ | Rewrite the selected text in any app by saying what to change. The text is read from the selection, or copied with your clipboard put back. |

<p align="center"><img src="docs/dictation-settings.png" alt="Settings, Dictation page: the shortcut, hold or press mode, Clean up set to Light, and Style by app with chat apps set to Casual" width="620"></p>

## Transcription models

Pick a model in **Settings → Transcription model**. Each card has **Download**, **Use** and **Remove** buttons. A download shows a progress bar, can be cancelled, and resumes where it stopped. The menu bar's **Transcription Model** submenu switches between installed models.

| Model | Languages | When | Size |
|---|---|---|---|
| **Phonon-2** | English | Live | ~1.2 GB* |
| Parakeet TDT 0.6B v3 | 25 European | Live | 670 MB |
| Parakeet TDT 0.6B v2 | English | Live | 661 MB |
| Whisper large-v3 turbo | 99 | After call | 574 MB |
| Whisper base.en | English | After call | 148 MB |

<sub>* Including its Python runtime. Whisper models also need `brew install whisper-cpp ffmpeg`.</sub>

**Phonon-2** from [Fermion Research](https://www.fermionresearch.com/research/phonon-2/) is a 164 MB compressed Parakeet TDT model that runs on the Apple Silicon GPU with MLX. It loads in about 12 s, then transcribes each speech segment in under 0.1 s.

<p align="center"><img src="docs/settings.png" alt="The Settings window on the Transcription page: Phonon-2 in use, Parakeet v3 downloading at 44%, and Download and Remove actions" width="620"></p>

<details>
<summary><b>Download and install details</b></summary>

- Hugging Face models (`istupakov/parakeet-tdt-0.6b-v3-onnx`, `istupakov/parakeet-tdt-0.6b-v2-onnx`, `ggerganov/whisper.cpp`) are pinned to a commit and checked against SHA-256 hashes. They're moved into `~/Library/Application Support/MeetingNotes/models` only once complete.
- Phonon-2 installs itself. A pinned standalone `uv` (downloaded if you don't have it) provides Python 3.13 and the `fermion-research` runtime in `~/Library/Application Support/MeetingNotes/phonon-venv`. While recording, the app runs `fermion serve phonon-2` on a private Unix socket.
- Models installed another way are detected too:
  - a `fermion` CLI set with `FERMION_BIN`;
  - Parakeet folders from the Handy app;
  - whisper.cpp models set with `WHISPER_MODEL` or in standard locations.
- Optional Groq or OpenAI Whisper keys in `.env` enable cloud transcription after the call. Leave them out to keep transcription local.

</details>

## Save calls to Notion

After each call, Meeting Notes adds it as a page in a Notion database. The page has the summary, decisions, action items (as checkboxes) and the full speaker-labelled transcript. If you typed your own notes, they come first. It also gets these properties: **Date**, **Duration (min)**, **Source**, **Action items**, **Transcription** and **Summary model**.

Pages are named after the call (its calendar event or an AI-written title), and **Source** says how it started, such as Manual or Google Meet auto.

In **Settings → Notes & Notion**, choose **Notion** or **Both**, then sign in one of two ways. Neither needs a terminal.

| | **Connect Notion** | **Log in to Notion via Composio** |
|---|---|---|
| Uses | The official [Notion CLI](https://ntn.dev) (`ntn`) | The [Composio CLI](https://composio.dev) and your Composio account |
| First-time download | 5 MB from Notion, if `ntn` isn't installed | 110 MB from GitHub, if `composio` isn't installed |
| Sign-in | Your browser opens Notion; check the code matches | Your browser opens Composio, then Notion to allow access |

Downloads show a progress bar and are checked against a pinned SHA-256 before they run. Once you're signed in, pick an existing database or let Meeting Notes create **Call Transcripts** in a page you choose. You can switch between the two sign-ins later with **Use Composio instead** / **Use the Notion CLI instead**.

Each page is created in a single request, so a failed save never leaves a half-written page. A local ledger prevents duplicates and queues failed saves, which are retried when the app starts and after the next call.

## Permissions

| Permission | Why | Required |
|---|---|---|
| Microphone | Records your voice, and dictation | Yes |
| Screen & System Audio Recording | Records other participants via system audio | Yes |
| Accessibility | Reads Zoom participant names and the active speaker, browser window titles to spot meeting tabs, and lets dictation see its shortcuts and paste. It never clicks or controls other apps. | For Zoom names, browser calls and dictation |
| Calendars | Names calls after their event, lists attendees, prep cards and Home's calendar | Only if you turn on the calendar |

If macOS remembers an old permission, quit Meeting Notes, toggle its entry off and on in **System Settings → Privacy & Security**, and reopen it.

## Privacy

- **Stays on your Mac:** audio, transcripts, notes, voice prints, your calendar, pictures of shared screens, and your knowledge base documents (only matching passages go out with a question). Live transcription with Phonon-2, Parakeet or Whisper and speaker separation never leave the Mac. Dictation stats store word counts only, never what you said.
- **Leaves your Mac**, only to your [OpenRouter](https://openrouter.ai) model and only for features you use:
  - the transcript text, to write notes (with your own notes and the text read from shared slides, if any);
  - your question plus the notes, transcript and knowledge base passages it needs, for Ask, live help, prep cards, weekly digests and follow-up drafts;
  - the dictated text (never the audio) with AI cleanup on, and the selected text with your instruction for Edit by voice.
- **Also leaves**, if you turn it on: the finished note (and, with the Notion CLI, the shared-slide images) to Notion (through Composio's servers if you signed in with Composio), and audio only if you configure a cloud Whisper provider.
- **Your API key** is encrypted with macOS secure storage and never sent back to the app's windows.
- **Update checks** go to this repo's GitHub releases; nothing about you is sent.
- **No accounts, telemetry or analytics.**

## Development

Requires macOS 14.4+, Node.js 22+, [Bun](https://bun.sh), Rust/Cargo and the Xcode command-line tools.

```sh
git clone https://github.com/lucassynnott/meeting-notes.git
cd meeting-notes
npm install
npm run build:worker && npm run build:zoom-observer && npm run build:hotkey && npm run build:calendar && npm run build:extract && npm run build:screens   # native helpers
npm start            # builds the React renderer, then launches Electron
npm test
```

The windows are a Vite + React app in `renderer/`, built only from [shadcn/ui](https://ui.shadcn.com) components (Radix base, Hugeicons) on Tailwind v4. `cd renderer && bun run dev` serves them for UI work; the design system is documented in [`DESIGN.md`](DESIGN.md).

`npm run dist` builds the native helpers and packages a signed `dist/Meeting-Notes-<version>-arm64.dmg` and `.zip`. It signs with the first Developer ID Application identity in your keychain; set `CSC_IDENTITY_AUTO_DISCOVERY=false` to build unsigned. Configuration options are documented in [`.env.example`](.env.example).

To publish a version, bump `version` in `package.json` and run `npm run release -- notes.md`. That runs the tests, builds and signs the app, then publishes a GitHub release here with the DMG, zip and `latest-mac.yml`, which installed copies check for updates. To try an update before publishing, serve a `dist/` folder over HTTP and launch the installed app with `MEETING_NOTES_UPDATE_URL=http://localhost:8000/`.

<details>
<summary><b>Project layout</b></summary>

| Path | What it does |
|---|---|
| `src/main.js` | Electron main process: tray, windows, recording lifecycle |
| `renderer/` | Vite + React + shadcn/ui windows: `main-window/` (Home, live notes, Meetings, Ask, digest), `settings/`, `onboarding/`, `dictation/` (pill), `ask-card/` (answer and prep card) |
| `src/model-manager.js` | Model catalog, verified downloads, Phonon-2 installer |
| `src/phonon-transcription.js`, `src/live-transcription.js` | Phonon-2 server client and Parakeet worker client |
| `src/summary.js`, `src/note.js` | OpenRouter note generation and the Markdown note |
| `src/library.js` | The Meetings page: notes, copies, titles, folders, tags, speaker renames |
| `src/ask.js`, `src/prep.js`, `src/digest.js`, `src/follow-up.js` | Ask, prep cards, weekly digests and follow-up drafts |
| `src/speakers.js`, `src/voice-embedder-worker.js` | Voice prints, speaker grouping and known voices |
| `src/call-detection.js`, `src/zoom-accessibility.js`, `src/zoom-auto-recording.js` | Calls in any app, Zoom speaker names, auto-record state machine |
| `src/calendar.js`, `src/join-link.js` | Calendar events for calls, and Zoom/Meet/Teams join links |
| `src/dictation.js`, `src/dictation-cleanup.js`, `src/dictation-style.js`, `src/dictionary.js` | Dictation, cleanup, per-app style and your dictionary |
| `src/voice-ask.js`, `src/command-mode.js`, `src/ask-card.js` | Ask by voice, Edit by voice, and the floating card |
| `src/knowledge.js`, `src/live-help.js` | The knowledge base index and search, and live help during calls |
| `src/shared-screens.js` | Watching the call's window for shared slides, and placing them beside the note |
| `src/notion-sync.js`, `src/notion-connect.js`, `src/composio-notion.js` | Notion saves, sign-in and API calls |
| `src/stats.js`, `src/updater.js`, `src/tray-icon.js` | Home's numbers, background updates, the menu bar icon |
| `native/parakeet-worker` | Rust ONNX Parakeet worker |
| `native/zoom-observer` | Swift observer: Zoom's Accessibility tree, and which apps are using the microphone |
| `native/hotkey` | Swift event-tap helper: shortcuts, shortcut recorder, focus and selection, copy and paste |
| `native/calendar` | Swift EventKit helper for calendar events |
| `native/extract` | Swift PDFKit helper that reads PDFs for the knowledge base |
| `native/screens` | Swift ScreenCaptureKit + Vision helper that saves and reads slides shared in a call |

</details>

## License

[MIT](LICENSE). Model weights carry their own licences: Phonon-2 and Parakeet are CC-BY-4.0, Whisper is MIT, and the WeSpeaker voice model follows its VoxCeleb training data (CC-BY-4.0).
