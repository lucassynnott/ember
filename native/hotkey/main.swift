// Meeting Notes dictation helper.
// Watches a global hotkey with a Quartz event tap, records new hotkeys, reports whether the
// focused element accepts text, and pastes with Cmd+V. Talks JSON lines over stdin/stdout.
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let pasteMarker: Int64 = 0x4D4E_4454  // "MNDT": marks events this helper posts

// Device-dependent modifier bits (IOLLEvent.h) let us tell left from right.
let modifierKeys: [Int64: (name: String, family: CGEventFlags, device: UInt64)] = [
    59: ("leftControl", .maskControl, 0x0000_0001),
    62: ("rightControl", .maskControl, 0x0000_2000),
    56: ("leftShift", .maskShift, 0x0000_0002),
    60: ("rightShift", .maskShift, 0x0000_0004),
    55: ("leftCommand", .maskCommand, 0x0000_0008),
    54: ("rightCommand", .maskCommand, 0x0000_0010),
    58: ("leftOption", .maskAlternate, 0x0000_0020),
    61: ("rightOption", .maskAlternate, 0x0000_0040),
    63: ("fn", .maskSecondaryFn, 0),
    179: ("fn", .maskSecondaryFn, 0),
]
let deviceBits: UInt64 = 0x0000_207F

// Keys that macOS reports with the fn flag already set; fn is ignored for these.
let fnImpliedKeys: Set<Int64> = [
    114, 115, 116, 117, 119, 121, 123, 124, 125, 126,  // Help/Ins, Home, PgUp, Del, End, PgDn, arrows
    122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,  // F1–F20
]

struct Hotkey: Equatable {
    var keyCode: Int64?
    var modifiers: Set<String>
}

// One registered shortcut ("dictate", "ask") and whether it's currently held.
struct HotkeySlot {
    var hotkey: Hotkey
    // Modifier-only hotkey state.
    var chordActive = false
    // Key hotkey state.
    var pressedKey: Int64? = nil
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8)
    else { return }
    print(line)
}

func keyName(for keyCode: Int64) -> String? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    var deadKeyState: UInt32 = 0
    var length = 0
    var characters = [UniChar](repeating: 0, count: 4)
    let status = data.withUnsafeBytes { buffer -> OSStatus in
        guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
            return -1
        }
        return UCKeyTranslate(
            layout, UInt16(keyCode), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
            OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeyState, characters.count, &length,
            &characters)
    }
    guard status == noErr, length > 0 else { return nil }
    let name = String(utf16CodeUnits: characters, count: length)
    return name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : name
}

func keyCodeForCharacter(_ character: String) -> CGKeyCode {
    for code in 0..<128 where keyName(for: Int64(code))?.lowercased() == character {
        return CGKeyCode(code)
    }
    return CGKeyCode(kVK_ANSI_V)
}

final class HotkeyMonitor {
    var slots: [String: HotkeySlot] = [:]
    var held = Set<String>()
    var tap: CFMachPort?
    // Escape is swallowed and reported only while dictation is running.
    var dictating = false

    // Hotkey recording state.
    var capturing = false
    var captureMaxModifiers = Set<String>()

    func updateHeld(_ event: CGEvent) {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        if let key = modifierKeys[keyCode] {
            let raw = flags.rawValue
            let isDown: Bool
            if key.device != 0 && raw & deviceBits != 0 {
                isDown = raw & key.device != 0
            } else {
                isDown = flags.contains(key.family)
            }
            if isDown { held.insert(key.name) } else { held.remove(key.name) }
        }
        // Drop any family whose flag is now clear, in case an event was missed.
        for key in modifierKeys.values where !flags.contains(key.family) {
            held.remove(key.name)
        }
    }

    func relevantModifiers(for keyCode: Int64?) -> Set<String> {
        guard let keyCode, fnImpliedKeys.contains(keyCode) else { return held }
        return held.subtracting(["fn"])
    }

    func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) == pasteMarker {
            return Unmanaged.passUnretained(event)
        }
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0

        if type == .flagsChanged { updateHeld(event) }
        if capturing { return handleCapture(type: type, keyCode: keyCode) ? nil : Unmanaged.passUnretained(event) }

        if type == .keyDown && keyCode == Int64(kVK_Escape) && dictating && !isRepeat {
            emit(["event": "escape"])
            return nil
        }
        var swallow = false
        for name in slots.keys.sorted() {
            guard var slot = slots[name] else { continue }
            let hotkey = slot.hotkey
            if let hotkeyCode = hotkey.keyCode {
                if type == .keyDown && keyCode == hotkeyCode {
                    if isRepeat {
                        if slot.pressedKey == hotkeyCode { swallow = true }
                    } else if relevantModifiers(for: keyCode) == hotkey.modifiers {
                        slot.pressedKey = hotkeyCode
                        emit(["event": "down", "hotkey": name])
                        swallow = true
                    }
                } else if type == .keyUp && keyCode == hotkeyCode && slot.pressedKey == hotkeyCode {
                    slot.pressedKey = nil
                    emit(["event": "up", "hotkey": name])
                    swallow = true
                }
            } else if type == .flagsChanged {
                // Modifier-only hotkey, e.g. fn or Right Option.
                if !slot.chordActive && held == hotkey.modifiers {
                    slot.chordActive = true
                    emit(["event": "down", "hotkey": name])
                } else if slot.chordActive && held != hotkey.modifiers {
                    slot.chordActive = false
                    emit(["event": hotkey.modifiers.isSubset(of: held) ? "cancel" : "up", "hotkey": name])
                }
            } else if type == .keyDown && slot.chordActive {
                // The modifier is being used for a regular shortcut such as Option+2.
                slot.chordActive = false
                emit(["event": "cancel", "hotkey": name])
            }
            slots[name] = slot
        }
        return swallow ? nil : Unmanaged.passUnretained(event)
    }

    // Returns true when the event should be swallowed.
    func handleCapture(type: CGEventType, keyCode: Int64) -> Bool {
        switch type {
        case .flagsChanged:
            captureMaxModifiers.formUnion(held)
            emit(["event": "capturing", "modifiers": Array(held).sorted()])
            if held.isEmpty && !captureMaxModifiers.isEmpty {
                finishCapture(Hotkey(keyCode: nil, modifiers: captureMaxModifiers))
            }
            return false
        case .keyDown:
            if keyCode == Int64(kVK_Escape) && held.isEmpty {
                capturing = false
                emit(["event": "captureCancelled"])
                return true
            }
            finishCapture(Hotkey(keyCode: keyCode, modifiers: relevantModifiers(for: keyCode)))
            return true
        case .keyUp:
            return true
        default:
            return false
        }
    }

    func finishCapture(_ captured: Hotkey) {
        capturing = false
        captureMaxModifiers = []
        var result: [String: Any] = ["event": "captured", "modifiers": Array(captured.modifiers).sorted()]
        if let keyCode = captured.keyCode {
            result["keyCode"] = keyCode
            if let name = keyName(for: keyCode) { result["keyName"] = name }
        } else {
            result["keyCode"] = NSNull()
        }
        emit(result)
    }

    func installTap() -> Bool {
        if tap != nil { return true }
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(refcon!).takeUnretainedValue()
            return monitor.handle(type: type, event: event)
        }
        guard
            let newTap = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                eventsOfInterest: CGEventMask(mask), callback: callback,
                userInfo: Unmanaged.passUnretained(self).toOpaque())
        else { return false }
        tap = newTap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
        return true
    }
}

// MARK: - Focus and paste

func copyAttribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func isSettable(_ element: AXUIElement, _ name: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success && settable.boolValue
}

var chromiumCache: [String: Bool] = [:]
var accessibilityEnabledPids = Set<pid_t>()

// Chromium browsers and Electron apps all ship chrome_100_percent.pak inside their framework.
func isChromium(_ app: NSRunningApplication) -> Bool {
    guard let bundle = app.bundleURL else { return false }
    if let cached = chromiumCache[bundle.path] { return cached }
    let frameworks = bundle.appendingPathComponent("Contents/Frameworks")
    let names = (try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)) ?? []
    let found = names.filter { $0.hasSuffix(".framework") }.contains { name in
        let framework = frameworks.appendingPathComponent(name)
        return ["Resources/chrome_100_percent.pak", "Versions/Current/Resources/chrome_100_percent.pak"].contains {
            FileManager.default.fileExists(atPath: framework.appendingPathComponent($0).path)
        }
    }
    chromiumCache[bundle.path] = found
    return found
}

func focusedElement(in app: NSRunningApplication?, chromium: Bool) -> AXUIElement? {
    if let app, chromium {
        // Chromium builds its accessibility tree only when an assistive app asks for it.
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        if !accessibilityEnabledPids.contains(app.processIdentifier) {
            AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            accessibilityEnabledPids.insert(app.processIdentifier)
            Thread.sleep(forTimeInterval: 0.15)
        }
        if let element = copyAttribute(appElement, kAXFocusedUIElementAttribute) {
            return (element as! AXUIElement)
        }
    }
    if let element = copyAttribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) {
        return (element as! AXUIElement)
    }
    return nil
}

func focusInfo() -> [String: Any] {
    var info: [String: Any] = [
        "event": "focus", "editable": false, "secure": false,
        "accessibility": AXIsProcessTrusted(),
    ]
    let app = NSWorkspace.shared.frontmostApplication
    let chromium = app.map(isChromium) ?? false
    info["chromium"] = chromium
    info["focusFound"] = false
    if let app {
        info["bundleId"] = app.bundleIdentifier ?? ""
        info["app"] = app.localizedName ?? ""
    }
    guard let element = focusedElement(in: app, chromium: chromium) else { return info }
    info["focusFound"] = true
    let role = copyAttribute(element, kAXRoleAttribute) as? String ?? ""
    let subrole = copyAttribute(element, kAXSubroleAttribute) as? String ?? ""
    info["role"] = role
    info["subrole"] = subrole
    let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
    let editable =
        textRoles.contains(role)
        || copyAttribute(element, "AXEditableAncestor") != nil
        || (role != "AXStaticText" && isSettable(element, kAXSelectedTextRangeAttribute))
    info["editable"] = editable
    info["secure"] = subrole == "AXSecureTextField"
    return info
}

func paste() {
    let source = CGEventSource(stateID: .combinedSessionState)
    let vKey = keyCodeForCharacter("v")
    for keyDown in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: keyDown) else { continue }
        event.flags = .maskCommand
        event.setIntegerValueField(.eventSourceUserData, value: pasteMarker)
        event.post(tap: .cghidEventTap)
    }
}

// MARK: - Commands

let monitor = HotkeyMonitor()

func parseHotkey(_ object: Any?) -> Hotkey? {
    guard let dictionary = object as? [String: Any] else { return nil }
    let modifiers = Set(dictionary["modifiers"] as? [String] ?? [])
    let keyCode = (dictionary["keyCode"] as? NSNumber)?.int64Value
    if keyCode == nil && modifiers.isEmpty { return nil }
    return Hotkey(keyCode: keyCode, modifiers: modifiers)
}

func reportStatus() {
    emit(["event": "status", "accessibility": AXIsProcessTrusted(), "tap": monitor.tap != nil])
}

func handleCommand(_ line: String) {
    guard let data = line.data(using: .utf8),
        let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let name = command["cmd"] as? String
    else { return }
    switch name {
    case "setHotkey":
        let name = command["name"] as? String ?? "dictate"
        if let hotkey = parseHotkey(command["hotkey"]) {
            monitor.slots[name] = HotkeySlot(hotkey: hotkey)
        } else {
            monitor.slots.removeValue(forKey: name)
        }
        emit(["event": "hotkeySet", "hotkey": name])
    case "setDictating":
        monitor.dictating = command["active"] as? Bool ?? false
    case "capture":
        monitor.capturing = true
        monitor.captureMaxModifiers = []
        emit(["event": "captureStarted"])
    case "cancelCapture":
        monitor.capturing = false
        emit(["event": "captureCancelled"])
    case "focus":
        var info = focusInfo()
        info["id"] = command["id"]
        emit(info)
    case "paste":
        paste()
        emit(["event": "pasted", "id": command["id"] ?? NSNull()])
    case "status":
        reportStatus()
    default:
        emit(["event": "error", "message": "Unknown command \(name)"])
    }
}

Thread.detachNewThread {
    while let line = readLine() {
        DispatchQueue.main.async { handleCommand(line) }
    }
    exit(0)
}

func ensureTap() {
    if !monitor.installTap() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { ensureTap() }
    }
    reportStatus()
}

DispatchQueue.main.async { ensureTap() }
CFRunLoopRun()
