# Ember Windows port

Target: a functioning Windows version with the same recording, editing, transcription, dictation, notes, integrations, and cloud-drive capabilities as Ember on macOS.

## Current implementation

- Shared platform module preserves existing macOS paths and resolves Windows roaming application data and native .exe helpers.
- Model storage, Whisper discovery, Phonon storage, MCP storage, and helper callers use platform-aware paths.
- Parakeet worker lookup recognizes Windows executable names.
- Permission handling uses Chromium device capture on Windows and retains native consent on macOS. Camera preview no longer calls the macOS-only prompt on Windows.
- Windows native hotkey helper implements the existing JSON-line protocol, side-specific shortcuts and capture, foreground UI Automation with password-field checks, copy/paste through SendInput, cancellation, and clipboard monitoring.
- `node scripts/build-windows-native.js x64` publishes the self-contained helper to `native/windows/bin`. Successfully cross-compiled and verified as a Windows x64 PE executable.
- `.github/workflows/windows-native.yml` builds on Windows and checks keyboard-hook startup plus the status request protocol. Windows runs are in progress; their completed checks and failures are recorded below.
- Windows defaults select the system microphone and use Right Ctrl / Ctrl+Alt shortcuts with Windows key labels.
- Windows capture backend uses a sandboxed Chromium renderer for screen/window/area/camera capture, microphone audio and a separate system-loopback track. Existing controls drive pause/resume/stop/restart; camera and audio companions are converted into the current recording format.
- Native helper now enumerates Windows window bounds and streams cursor position/button/shape samples for the editor. Capture controls and camera preview use Windows capture exclusion.
- FFmpeg and FFprobe Windows x64 binaries are provisioned from pinned upstream assets with compressed and extracted SHA-256 checks; license and source/build notes accompany them. Runtime prefers bundled tools.
- Local verification: 185 Node tests and 22 renderer tests passed; native helper compilation and renderer production build passed. Actual Chromium smoke test with generated camera and microphone recorded, paused/resumed and converted a decodable 1920x1080 MP4 and 16kHz WAV (1.40 seconds, 22528 samples).
- None of these Mac-host checks establishes Windows desktop capture behavior. Windows CI now includes media tests, Chromium smoke testing with a saved result, helper startup, and a CPU transcription-worker build. Initial run: https://github.com/lucassynnott/ember/actions/runs/37522416964 (failed: 13 cross-platform failures).
- Initial Windows run passed dependency setup, media verification and the production renderer build. Its full Node suite failed 13 checks: POSIX mode assertions, Mac-only archive/plist utilities, tray template behavior, CLI PATH/wrapper migration, Notion fixture execution, and simulated-platform path normalization. Tray visibility/template handling, path normalization, CLI wrappers/connection paths and the platform-specific test assumptions have been fixed locally. Composio/Notion runtime/archive portability remains next; fresh Windows verification is required.
- Functional smoke and helper build steps now run even when the broader unit suite fails, so they can expose independent runtime issues without masking the failed unit gate. Rust CPU worker compilation is a separate Windows job.
- Draft PR: https://github.com/lucassynnott/ember/pull/1, branch `codex/windows-port`. Snapshots were pushed without switching the working checkout off `main`; the local port edits remain in the working tree.
- Windows CPU transcription worker build passed in run https://github.com/lucassynnott/ember/actions/runs/37522819766. Artifact `ember-windows-parakeet-x64` was downloaded to ignored `.windows-tools/windows-parakeet-artifact` and its worker EXE and DirectML DLL verified as Windows x64 PE files. Model loading/transcription on Windows still needs real audio inference testing.
- Composio 0.4.2 official release assets were inspected: there is no Windows binary. Windows integration needs an appropriate Windows implementation/runtime rather than the pinned macOS executable. Notion CLI runtime/fixture portability also remains.
- Tray icons now use visible theme-aware colors on Windows, CLI installation writes Windows .cmd wrappers, Claude Desktop config uses Windows AppData, and connection migration normalizes path separators.
- `dist:win` and `dist:win:dir` now define NSIS/ZIP Windows packaging with Windows helper/media/ONNX resources. macOS-only resources are scoped to the macOS build. Installer commands have not yet been executed.

## Required work and verification

- Verify the implemented Windows hotkey helper on a real desktop, including modifier-only shortcut interactions, Chromium text fields, elevated apps, passwords, and clipboard filtering. Implement call detection and Zoom UI Automation, screen OCR, document extraction, and calendar integration.
- Verify actual Windows screen/window/area capture, microphone/system loopback, separate camera track, pause/resume and cursor tracking. Implement reliable cursor hiding and editor export, and verify all current editor semantics. The Chromium capture backend currently reports cursorHidden=false because native cursor suppression is not proven.
- Windows local inference: Parakeet ONNX worker and dependencies; replace Apple MLX-only transcription/AI backends with working Windows engines and platform-specific model catalogs and runtime downloads.
- Windows drive: implement filesystem mounting, provider setup, search, offline pinning/cache, backups, and sharing. macOS FSKit is unavailable on Windows.
- Main-process platform audit: privacy APIs, browser URL retrieval, login/autostart, app/window focus, integrations, CLI downloads, image conversion, background assets, shortcuts, and platform copy.
- Windows installer and updates: native Windows build job, packaged helpers and DLLs, NSIS installer, install/uninstall and upgrade verification.
- Execute Windows unit/integration tests and real desktop acceptance covering install, first-run setup, capture/playback/export, transcription, dictation into another app, drive read/write, and relaunch persistence.

## Environment

The current host is macOS. No Windows runtime or Wine was found during the initial inventory. An isolated .NET 10 SDK is now installed in the ignored `.windows-tools/dotnet` directory for cross-compilation. Windows behavior must be verified on a Windows runner or desktop before claiming completion. The existing macOS drive changes were already uncommitted and must be preserved.

- Notion CLI download now selects the official pinned Windows x64 executable from npm release 0.23.19, with archive checksum/size validation and exact-entry extraction using Windows tar.exe. Discovery uses roaming app storage and WinGet links. Locally verified extraction yields an AMD64 PE executable; nine existing Notion connection/sync tests passed. Windows login and fixture portability are still unverified.

- Notion login/sync fixtures now use script CLIs through the bundled Node runtime rather than Unix shebangs. Windows CI additionally downloads, checks, extracts and launches the official Notion CLI with --version; browser authentication remains a separate desktop acceptance requirement.
