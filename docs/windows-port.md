# Ember Windows port

Target: a functioning Windows version with the same recording, editing, transcription, dictation, notes, integrations, and cloud-drive capabilities as Ember on macOS.

## Current implementation

- Shared platform module preserves existing macOS paths and resolves Windows roaming application data and native .exe helpers.
- Model storage, Whisper discovery, Phonon storage, MCP storage, and helper callers use platform-aware paths.
- Parakeet worker lookup recognizes Windows executable names.
- Platform and affected feature tests pass locally on macOS. These do not establish Windows runtime correctness.

## Required work and verification

- Windows native helper implementation: global keyboard hook and shortcut capture, foreground focus and secure-field detection, paste/copy and clipboard observation, call detection and Zoom UI Automation, screen OCR, document extraction, calendar integration.
- Screen and camera recording: screen/window/area selection, microphone plus WASAPI system loopback, separate camera track, pause/resume, timestamps and cursor tracking, editor export. Preserve current editor semantics.
- Windows local inference: Parakeet ONNX worker and dependencies; replace Apple MLX-only transcription/AI backends with working Windows engines and platform-specific model catalogs and runtime downloads.
- Windows drive: implement filesystem mounting, provider setup, search, offline pinning/cache, backups, and sharing. macOS FSKit is unavailable on Windows.
- Main-process platform audit: privacy APIs, browser URL retrieval, login/autostart, app/window focus, integrations, CLI downloads, image conversion, background assets, shortcuts, and platform copy.
- Windows installer and updates: native Windows build job, packaged helpers and DLLs, NSIS installer, install/uninstall and upgrade verification.
- Execute Windows unit/integration tests and real desktop acceptance covering install, first-run setup, capture/playback/export, transcription, dictation into another app, drive read/write, and relaunch persistence.

## Environment

The current host is macOS. No Windows runtime, Wine, or .NET SDK was found during the initial inventory. Windows behavior must be verified on a Windows runner or desktop before claiming completion. The existing macOS drive changes were already uncommitted and must be preserved.
