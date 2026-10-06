# Windows native helpers

The hotkey helper implements the same JSON-line transport as `native/hotkey/main.swift`. It uses Win32 low-level keyboard hooks, UI Automation for focused fields, and SendInput for Ctrl+C/Ctrl+V. It conservatively copies rather than inserting when focus cannot be inspected; password fields are rejected. Native input failures propagate to the Electron caller.

Build with .NET 10:

```sh
node scripts/build-windows-native.js x64
```

The script supports `arm64` as an optional target, or `EMBER_DOTNET` to select a .NET SDK executable. Output is `native/windows/bin/meeting-notes-hotkey.exe` plus its companion native libraries. Package the entire output directory. These generated files are ignored by Git.

Persisted shortcut key codes remain compatible with Ember's existing macOS schema; the helper maps them to Windows virtual keys. Option means Alt, Command means Windows, and side-specific modifier names keep their meaning. Fn is not a Windows global key and is rejected. New Windows installations default to Right Ctrl for dictation and Ctrl+Alt chords for the other actions; labels use Windows key names.

Cross-compilation proves the Windows executable can be built. It does not verify input delivery, focus preservation, shortcut behavior or clipboard handling on Windows. The Windows workflow performs startup/protocol smoke checks; the full desktop acceptance checks in `docs/windows-port.md` remain required.
