# Meeting Notes

A private macOS menu-bar meeting recorder. It records the mapped microphone and macOS system/voice-chat audio, transcribes speech locally in real time with Phonon-2 (or Parakeet) when available, generates structured notes through OpenRouter, and saves the note plus source audio on this Mac.

## Install

Requirements: an Apple Silicon Mac running macOS 14.4 or later.

1. Download `Meeting-Notes-<version>-arm64.dmg` (or the `.zip`) from [Releases](../../releases) and drag **Meeting Notes** into Applications.
2. The app is signed with a Developer ID but **not notarized**, so the first time you open it, right-click **Meeting Notes** in Applications and choose **Open**, then **Open** again. If macOS still refuses, run `xattr -dr com.apple.quarantine "/Applications/Meeting Notes.app"`.
3. Open **Settings → Transcription model** and click **Download** on a model, then **Use**. Phonon-2 is recommended for English; it installs its own Python runtime automatically, so you don't need anything else.
4. Optional: set up [Notion](#notion) to save every call to a Notion database.

## Using it

1. Open **Meeting Notes**. Its workspace opens immediately and `MN` remains in the menu bar.
2. Open **Settings**. Set your name, transcription model, OpenRouter model, encrypted OpenRouter key, notes folder, and Zoom automation preference.
3. With **Automatically record Zoom meetings** enabled, Meeting Notes starts when Zoom exposes a meeting window with at least one participant. You can still use **Start recording** manually.
4. When the Zoom meeting ends—or when you choose **Stop recording**—Meeting Notes finalizes the transcript, generates notes, and writes the Markdown and audio files to the configured folder. A notification contains the saved path; the app does not force-open the note.

The transcript pane has a fixed height and its own scroll. Live notes remain visible beside it.

### Zoom automatic recording

Automatic recording is opt-in and enabled for the current installation. Meeting Notes waits 2.5 seconds after detecting an active Zoom meeting before recording. While you share your screen, Zoom's sharing toolbar is treated as part of the same meeting even when Zoom temporarily removes its normal meeting window. Recording stops only after neither the meeting window nor sharing controls have remained available for 5 seconds, so screen-share transitions, brief reconnects, and participant-tree changes stay in one recording.

Recordings remember how they were started. Zoom can stop only a recording it started; manually started recordings never stop when Zoom closes. Choosing **Stop recording** during an automatically started meeting pauses automation until that Zoom meeting window closes, preventing an unwanted restart.


## Audio mapping

- **Your speech:** the input named `Microphone` by default (Chromium may display it as `Microphone (Virtual)`). Set `MICROPHONE_LABEL` in `.env` to use a different input.
- **Other participants:** macOS ScreenCaptureKit system-audio loopback, shown as `System Audio` in the app (`SYSTEM_AUDIO_LABEL` in `.env`).
- **Music:** ignored as a microphone input. It is not mixed as your voice. If music is audible in the selected system output, macOS system capture may still record it as part of system audio.

The recorder stores one mixed WebM audio file while sending microphone and system PCM through separate transcription streams. During Zoom meetings, a local native observer reads participant names and active-speaker state from Zoom's macOS Accessibility tree, then conservatively correlates those time ranges with system-audio transcript segments. Ambiguous or unavailable identity remains `Remote speaker`; the app never guesses. Zoom may remain behind other apps, but its meeting window must stay open. It does not need to be frontmost or visibly unobstructed.

## Permissions

Grant three permissions to **Meeting Notes** in **System Settings → Privacy & Security**:

1. **Microphone** — records `Microphone`.
2. **Screen & System Audio Recording** — records system and voice-chat audio through ScreenCaptureKit.
3. **Accessibility** — reads Zoom participant display names and active-speaker indicators. It does not click or control Zoom.

Microphone and Screen Recording are required to enable **Start recording**. Accessibility is optional for capture but required for named Zoom speakers. The footer reports capture access, Zoom-name access, meeting detection, and the current active speaker. If macOS has an old permission record, fully quit Meeting Notes, remove/re-enable its entry in System Settings, and reopen the app. Screen Recording changes can require a restart.

## Development

Requirements: macOS 14.4+, Node.js 22+, npm, Rust/Cargo, and Xcode command-line tools.

```sh
git clone https://github.com/lucassynnott/meeting-notes.git
cd meeting-notes
npm install
npm run build:worker && npm run build:zoom-observer
npm start
npm test
```

`npm run dist` builds the Rust Parakeet worker and Swift Zoom observer, then packages `dist/Meeting-Notes-<version>-arm64.dmg` and `.zip`. electron-builder signs with the first Developer ID Application identity in your keychain (set `CSC_IDENTITY_AUTO_DISCOVERY=false` to build unsigned). Notarization isn't configured.

## Transcription

**Settings → Transcription model** lists these downloadable models, each with **Download**, **Use**, **Remove** and a progress bar (downloads can be cancelled and resume where they stopped):

| Model | Source | Languages | When | Size |
|---|---|---|---|---|
| Phonon-2 | Fermion Research | English | Live | ~1.2 GB incl. runtime |
| Parakeet TDT 0.6B v3 | `istupakov/parakeet-tdt-0.6b-v3-onnx` | 25 European | Live | 670 MB |
| Parakeet TDT 0.6B v2 | `istupakov/parakeet-tdt-0.6b-v2-onnx` | English | Live | 661 MB |
| Whisper large-v3 turbo (q5) | `ggerganov/whisper.cpp` | 99 | After recording | 574 MB |
| Whisper base.en | `ggerganov/whisper.cpp` | English | After recording | 148 MB |

Hugging Face files are pinned to a commit and checked against SHA-256 hashes, then moved into `~/Library/Application Support/MeetingNotes/models` only once complete. Phonon-2 is installed with a pinned standalone `uv` (downloaded if you don't have it), which provides Python 3.13, the `fermion-research` runtime and the model. Whisper models need `brew install whisper-cpp ffmpeg`. The menu bar's **Transcription Model** submenu switches between installed models.

It also detects models installed some other way:

- Phonon-2 (Fermion Research), when the `fermion` CLI is installed in `~/Library/Application Support/MeetingNotes/phonon-venv` or `FERMION_BIN` points to it. This is the default.
- Parakeet TDT 0.6B v3 model folders under Handy's application support directory.
- Parakeet model folders under `~/Library/Application Support/MeetingNotes/models`.
- A whisper.cpp model specified by `WHISPER_MODEL` or in a standard model location.

Phonon-2 is a 164 MB compressed Parakeet TDT model from Fermion Research (English only, CC-BY-4.0 weights, MLX on Apple Silicon). While recording, the app starts `fermion serve phonon-2` on a private Unix socket and posts each speech segment to its `/v1/audio/transcriptions` endpoint. It loads in about 12 s and transcribes a segment in under 0.1 s once warm. `npm run setup:local` installs it into its own Python 3.13 environment and downloads the model. Pick Parakeet in **Settings** for non-English meetings.

Parakeet provides live, source-separated transcription. Whisper.cpp is a local post-recording fallback. Install its medium model and dependencies with:

```sh
npm run setup:local
```

Optional Groq/OpenAI Whisper keys enable cloud transcription when selected through `.env`; omit them to keep transcription local. Copy `.env.example` to `.env`, or place it at `~/MeetingNotes/.env` for the installed app.

## Notes generation

The selected OpenRouter model defaults to `openai/gpt-5.6-luna`. The dedicated Settings page searches the live OpenRouter model catalog by provider or model name. The API key is encrypted with Electron `safeStorage`; it is never returned to renderer code after saving. `OPENROUTER_API_KEY` in `.env` is supported, but the encrypted Settings field is preferred.

Generated Markdown contains:

- exactly five summary bullets;
- decisions made;
- action items with owners;
- a divider;
- the complete source-labeled transcript.

## Storage and privacy

Default output: `~/MeetingNotes/YYYY-MM-DD-HHMM.md` plus `YYYY-MM-DD-HHMM.webm`. Change the folder from **Settings**.

There are no accounts, telemetry, analytics, or cloud storage. Audio and notes remain local. Audio leaves the machine only when a cloud Whisper provider is configured. Transcript text leaves the machine when OpenRouter generates notes.

## Notion

After each meeting's local note is saved, the app also saves it as a page in a Notion database: summary, decisions, action items (as checkboxes) and the full speaker-labelled transcript. Each page gets these properties: **Date** (start–end), **Duration (min)**, **Source** (Manual / Zoom auto), **Action items**, **Transcription**, **Summary model** and **Local note**.

Setup:

1. Install and log in to the Notion CLI: `brew install notion-cli`, then `ntn login`. The app looks for `ntn` in `/opt/homebrew/bin` and `/usr/local/bin`, or set `NTN_BIN`.
2. Create the database under a page the CLI can access. Copy the page's ID from its URL:

   ```sh
   scripts/create-notion-database.sh <parent-page-id>
   ```

   It prints the new database's link and its **data source ID**.
3. In **Settings → Notion**, turn on **Save each call to Notion** and paste the data source ID (or set `NOTION_DATA_SOURCE_ID` in `.env`).

How it works:

- Pages are created with one `POST /v1/pages` call using the `markdown` body, so a failed save never leaves a half-written page.
- `notion-sync.json` in the app's data folder records which notes are already in Notion (no duplicates). It also queues failed saves, which are retried when the app starts and after the next meeting.
