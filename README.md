<div align="center">

# Meeting Notes

**A private meeting recorder and speech-to-text app for macOS: one app instead of Granola and Wispr Flow.**<br>
Record calls with live on-device transcription, named Zoom speakers and AI notes, and dictate into any app with a hotkey.

[![Download](https://img.shields.io/badge/download-latest%20release-9a8cff?style=flat-square)](https://github.com/lucassynnott/meeting-notes/releases/latest)
![macOS 14.4+](https://img.shields.io/badge/macOS-14.4%2B-171717?style=flat-square&logo=apple)
![Apple Silicon](https://img.shields.io/badge/Apple%20Silicon-arm64-171717?style=flat-square)
![License: MIT](https://img.shields.io/badge/license-MIT-eeeae0?style=flat-square)

<img src="docs/screenshot.png" alt="Meeting Notes recording a Zoom call: notes and participants on the left, and the transcript hanging off a vertical rail on the right, with a yellow tick marking who is speaking now" width="900">

[Install](#install) · [Why](#one-app-instead-of-two) · [Features](#features) · [Dictation](#dictation) · [Transcription models](#transcription-models) · [Notion](#save-calls-to-notion) · [Privacy](#privacy) · [Development](#development)

</div>

---

## One app instead of two

| You'd use | For | Meeting Notes does it with |
|---|---|---|
| **Granola** | Meeting notes | Live on-device transcription of every call, real speaker names from Zoom, a running summary with decisions and action items, and the note saved to a folder or Notion |
| **Wispr Flow** | Speech to text anywhere | Hold a hotkey in any app, speak, and the text is typed where your cursor is, using the same on-device model |

Both run on one shared on-device model, so there's no monthly subscription and your audio stays on your Mac. AI notes use your own [OpenRouter](https://openrouter.ai) key, so only the transcript text goes to the model you pick, and the finished note goes to Notion if you've turned that on.

## Features

<table>
<tr><td width="30%">🎙️ <b>Live, on-device transcription</b></td><td>Phonon-2 or Parakeet transcribe while you talk, entirely on your Mac. Download models with one click.</td></tr>
<tr><td width="30%">👥 <b>Real speaker names</b></td><td>Your mic is labelled with your name. Other people are named from Zoom's active-speaker indicator, and never guessed.</td></tr>
<tr><td width="30%">⌨️ <b>Dictate anywhere</b></td><td>Hold a hotkey (fn, Right ⌥, F5, Home… anything), speak, and the text is typed into whatever field you're in, or copied if there isn't one.</td></tr>
<tr><td width="30%">📝 <b>Notes as the call unfolds</b></td><td>A running summary, decisions and action items with owners, generated through any OpenRouter model.</td></tr>
<tr><td width="30%">📹 <b>Zoom auto-record</b></td><td>Starts when a Zoom meeting begins and stops when it ends, including across screen shares and brief reconnects.</td></tr>
<tr><td width="30%">🗂️ <b>Save to a folder or Notion</b></td><td>Every call becomes a Markdown note, a page in a Notion database (with Date, Duration, Source and action-item properties), or both.</td></tr>
<tr><td width="30%">🔒 <b>Local by default</b></td><td>Audio and Markdown notes stay in a folder you choose. No accounts, telemetry or analytics.</td></tr>
</table>

## Install

> **Requires** an Apple Silicon Mac on macOS 14.4 or later.

1. Download **`Meeting-Notes-<version>-arm64.dmg`** from the [latest release](https://github.com/lucassynnott/meeting-notes/releases/latest) and drag **Meeting Notes** into Applications.
2. The app is signed with a Developer ID but **not notarized**. The first time you open it, right-click **Meeting Notes** in Applications, choose **Open**, then **Open** again.
   <sub>If macOS still refuses: `xattr -dr com.apple.quarantine "/Applications/Meeting Notes.app"`</sub>
3. Grant **Microphone** and **Screen & System Audio Recording** when asked. Grant **Accessibility** as well if you want named Zoom speakers.
4. Open **Settings → Transcription model**, click **Download** on a model, then **Use**. Phonon-2 is recommended for English and installs everything it needs.
5. Add an [OpenRouter](https://openrouter.ai) API key in **Settings** for meeting notes. To save calls to Notion too, see [Save calls to Notion](#save-calls-to-notion).

**Updates are automatic.** Meeting Notes checks for a new version every few hours, downloads it in the background and installs it the next time you restart the app. It never restarts during a call. **Settings → Updates** shows your version and has **Check for updates** and **Restart to update**. Copies older than 1.4.0 need this one download by hand; after that they update themselves.

## How it works

1. **Start recording**, or let it start on its own when a Zoom meeting begins. `MN` sits in the menu bar while it runs.
2. Your microphone and the Mac's system audio are recorded together. They're transcribed separately, so your words are always labelled with your name.
3. Live notes refresh during the call. When it ends, Meeting Notes writes `YYYY-MM-DD-HHMM.md` (summary, decisions, action items and the full transcript) next to the `.webm` audio, then saves a copy to Notion if you've enabled it.

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

After each call, Meeting Notes adds it as a page in a Notion database. The page has the summary, decisions, action items (as checkboxes) and the full speaker-labelled transcript. It also gets these properties: **Date**, **Duration (min)**, **Source** (Manual or Zoom auto), **Action items**, **Transcription** and **Summary model**.

In **Settings → Notes & Notion**, choose **Notion** or **Both**, then sign in one of two ways. Neither needs a terminal.

| | **Connect Notion** | **Log in to Notion via Composio** |
|---|---|---|
| Uses | The official [Notion CLI](https://ntn.dev) (`ntn`) | The [Composio CLI](https://composio.dev) and your Composio account |
| First-time download | 5 MB from Notion, if `ntn` isn't installed | 110 MB from GitHub, if `composio` isn't installed |
| Sign-in | Your browser opens Notion; check the code matches | Your browser opens Composio, then Notion to allow access |

Downloads show a progress bar and are checked against a pinned SHA-256 before they run. Once you're signed in, pick an existing database or let Meeting Notes create **Call Transcripts** in a page you choose. You can switch between the two sign-ins later with **Use Composio instead** / **Use the Notion CLI instead**.

Each page is created in a single request, so a failed save never leaves a half-written page. A local ledger prevents duplicates and queues failed saves, which are retried when the app starts and after the next call.

## Zoom automation

<details>
<summary><b>Auto-record behaviour</b></summary>

- Automatic recording is opt-in (**Settings → Zoom automation**).
- It starts 2.5 seconds after Zoom shows an active meeting with at least one participant.
- Screen sharing counts as the same meeting, even while Zoom hides its normal meeting window.
- Recording stops only after the meeting window and sharing controls have both been gone for 5 seconds. Screen-share transitions and brief reconnects stay in one recording.
- Zoom can only stop a recording it started. Recordings you start manually never stop when Zoom closes.
- Pressing **Stop recording** during an automatic recording pauses automation until that meeting ends.

</details>

<details>
<summary><b>Speaker names and audio routing</b></summary>

- **Your speech:** the input named `Microphone` by default. Set `MICROPHONE_LABEL` in `.env` to use another input.
- **Everyone else:** system audio captured through ScreenCaptureKit (`SYSTEM_AUDIO_LABEL` in `.env`).
- **Naming other speakers:** a small native observer reads Zoom participant names and the active-speaker indicator from the macOS Accessibility tree. A segment is named only when one Zoom speaker clearly dominates it. Otherwise it stays `Remote speaker`.
- **Zoom window:** it can sit behind other apps, but the meeting window must stay open.

</details>

## Permissions

| Permission | Why | Required |
|---|---|---|
| Microphone | Records your voice | Yes |
| Screen & System Audio Recording | Records other participants via system audio | Yes |
| Accessibility | Reads Zoom participant names and the active speaker, and lets dictation see its shortcut and paste. It never clicks or controls Zoom. | For named speakers and dictation |

If macOS remembers an old permission, quit Meeting Notes, toggle its entry off and on in **System Settings → Privacy & Security**, and reopen it.

## Privacy

- **Stays on your Mac:** audio, transcripts and notes are saved locally (`~/MeetingNotes` by default). Live transcription with Phonon-2, Parakeet or Whisper never leaves the Mac.
- **Leaves your Mac:**
  - the transcript text, sent to OpenRouter to generate notes;
  - the finished note, sent to Notion if you've turned that on (through Composio's servers if you signed in with Composio);
  - audio, only if you configure a cloud Whisper provider.
- **Your API key** is encrypted with macOS secure storage and never sent back to the app's windows.
- **Update checks** go to this repo's GitHub releases; nothing about you is sent.
- **No accounts, telemetry or analytics.**

## Development

Requires macOS 14.4+, Node.js 22+, [Bun](https://bun.sh), Rust/Cargo and the Xcode command-line tools.

```sh
git clone https://github.com/lucassynnott/meeting-notes.git
cd meeting-notes
npm install
npm run build:worker && npm run build:zoom-observer && npm run build:hotkey   # native helpers
npm start            # builds the React renderer, then launches Electron
npm test
```

The windows are a Vite + React app in `renderer/`, built only from [shadcn/ui](https://ui.shadcn.com) components (Radix base, Hugeicons) on Tailwind v4. `cd renderer && bun run dev` serves them for UI work; the design system is documented in [`DESIGN.md`](DESIGN.md).

`npm run dist` builds both helpers and packages a signed `dist/Meeting-Notes-<version>-arm64.dmg` and `.zip`. It signs with the first Developer ID Application identity in your keychain; set `CSC_IDENTITY_AUTO_DISCOVERY=false` to build unsigned. Configuration options are documented in [`.env.example`](.env.example).

To publish a version, bump `version` in `package.json` and run `npm run release -- notes.md`. That runs the tests, builds and signs the app, then publishes a GitHub release here with the DMG, zip and `latest-mac.yml`, which installed copies check for updates. To try an update before publishing, serve a `dist/` folder over HTTP and launch the installed app with `MEETING_NOTES_UPDATE_URL=http://localhost:8000/`.

<details>
<summary><b>Project layout</b></summary>

| Path | What it does |
|---|---|
| `src/main.js` | Electron main process: tray, windows, recording lifecycle |
| `renderer/` | Vite + React + shadcn/ui windows: `main-window/` (live notes and rail), `settings/`, `dictation/` (pill) |
| `src/model-manager.js` | Model catalog, verified downloads, Phonon-2 installer |
| `src/phonon-transcription.js`, `src/live-transcription.js` | Phonon-2 server client and Parakeet worker client |
| `src/summary.js` | OpenRouter note generation |
| `src/notion-sync.js` | Notion page saves with a retry ledger |
| `src/notion-connect.js`, `src/composio-notion.js` | Notion sign-in and API calls through the Notion CLI or Composio |
| `src/updater.js` | Background updates from this repo's GitHub releases |
| `src/dictation.js`, `src/dictation-overlay.js`, `src/hotkey.js` | Dictation state machine, floating pill window, hotkey helper client |
| `src/transcriber-service.js` | Shares one warm transcriber between meetings and dictation |
| `src/zoom-accessibility.js`, `src/zoom-auto-recording.js` | Zoom speaker names and auto-record state machine |
| `native/parakeet-worker` | Rust ONNX Parakeet worker |
| `native/zoom-observer` | Swift Accessibility observer for Zoom |
| `native/hotkey` | Swift event-tap helper: global shortcut, shortcut recorder, focus check and paste |

</details>

## License

[MIT](LICENSE). Model weights carry their own licences: Phonon-2 and Parakeet are CC-BY-4.0, and Whisper is MIT.
