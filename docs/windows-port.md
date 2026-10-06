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

- Composio 0.4.2 source at dfb8f1dfbd991d821cf9250def70e911cb6c1cf8 now cross-compiles through a reproducible script using Bun 1.3.14 and frozen pnpm dependencies. Verified the resulting AMD64 PE locally. Windows discovery uses the bundled executable, packaging invokes the build, and an independent Windows CI job checks startup/version and retains executable/license/source provenance. Upstream Windows credential storage falls back to plaintext; secure Windows credentials, login/proxy acceptance, and portable Composio test fixtures remain required.

- Composio ZIP extraction now uses a production JavaScript dependency instead of macOS ditto. ZIP fixtures are generated with yazl and script CLIs run through Node; all 185 Node and 22 renderer tests pass locally with these portable fixtures. Latest source-build Windows job 37524363094 is live; Windows acceptance remains pending.

- Actual Windows run 37524363094 passed Composio startup/version, Notion startup/version, generated-device Chromium capture including pause/resume and media conversion, hotkey helper startup/protocol, and Rust worker compilation. Its Node suite had three failures: two old Composio ditto fixtures and a tray image test double missing resize; these are fixed locally. This does not establish real desktop-device capture or transcription inference.
- Added Windows DPAPI CurrentUser credential storage to the pinned Composio source build, with Windows default protected storage and failure propagation instead of plaintext write fallback. The protected CLI cross-compiled locally and full upstream pnpm typecheck passed. CI now tests the store with synthetic credentials; Windows DPAPI behavior remains unverified until that job passes.

- Windows import/recovery and waveform extraction now use Ember's bundled Node runtime and FFmpeg/FFprobe, independent of the absent macOS record helper. Import creates H.264/AAC MP4, poster and 16kHz mono notes WAV (including silent videos); waveform extraction decodes to a temporary PCM file for bounded memory. Real-media tests passed; local suite now 187 Node plus 22 renderer tests. Editor export/cursor images remain separate outstanding work.
- Windows run 37524947572 exposed CRLF-sensitive Composio source-patch syntax and pnpm shell-filter quoting. Patch input now normalizes line endings and Windows pnpm arguments are quoted. Rebuilt successfully from fresh upstream files converted to CRLF locally; fresh Windows build/DPAPI proof is still needed.

- Added the Windows export audio renderer: clip trims/source switches, pitch-preserving speeds (including chained tempo filters), independent microphone/system volumes, mute intervals on the edited timeline, system gaps for other recording sources, delayed/trimmed added audio, and silent sources. It writes 48kHz stereo WAV through FFmpeg with bounded command length via a filter script. Spectrum/timing tests passed eight repeated real-media runs after fixing timestamp trimming of padded extra audio. This component is not yet connected to full editor export; the frame renderer/encoding pipeline remains required.

- Windows run 37525318358 passed the protected DPAPI store test (synthetic credential persistence/replacement/corruption/deletion) and patched Composio CLI startup. Transcription worker build passed. The broader Windows app/media suite remains in progress. Local suite with the export-audio component passed 189 Node tests and 22 renderer tests.

- Windows run 37525318358 completed successfully across all three jobs: full app/unit/media suite, generated-device recording lifecycle, native hotkey startup/protocol, Windows transcription worker build, Composio build/startup and DPAPI store checks. This validates the pre-export-audio snapshot, not complete desktop acceptance.
- Added Chromium export-spec frame compositor with backgrounds, masks/shadows, interpolated zoom and alternate-source letterboxing, camera crop/mirror/radius, picture/caption fades and motions, blur/redaction layers, click effects, cursor shape/hotspot/visibility and motion blur. Intermediate canvases are reused. Production renderer build and a real Chromium smoke test with 13 pixel assertions passed locally; Windows CI now runs it. Full video decode/streaming encode transport and editor export integration are still required.

- Connected Windows editor export to a sandboxed Chromium frame producer and FFmpeg encoder, with exact-file media routing, bounded sequential PNG transport, audio mixing, MP4/GIF output, progress, cancellation and staged output cleanup. Local end-to-end acceptance passed decoded MP4/GIF checks and an 18-frame cut/speed comparison (worst RGB mean error 10.24/255); cancellation left no output or staging directories. Production renderer build and 192 Node plus 22 renderer tests passed. Real Windows export acceptance is now included in CI and remains pending.
