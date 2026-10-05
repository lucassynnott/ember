import AppKit
import ApplicationServices
import CoreAudio
import Foundation

private struct ZoomSnapshot: Equatable {
    let accessibility: Bool
    let meetingOpen: Bool
    let screenSharing: Bool
    let participants: [String]
    let activeSpeakers: [String]
}

private func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

private func zoomApplication() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "us.zoom.xos").first
}

private let participantStateMarkers = [
    ", Computer audio",
    ", No audio connected",
    ", Phone audio",
    ", Device audio",
    ", Telephone",
    ", Call me",
]

private func participantName(from description: String) -> String? {
    let lowercased = description.lowercased()
    guard lowercased.contains("active speaker") || participantStateMarkers.contains(where: description.contains) else {
        return nil
    }
    let markerIndexes = participantStateMarkers.compactMap { description.range(of: $0)?.lowerBound }
    guard let end = markerIndexes.min() else { return nil }
    let name = String(description[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? nil : name
}

private func meetingWindow(in windows: [AXUIElement]) -> AXUIElement? {
    windows.first { element in
        guard let title = stringAttribute(element, kAXTitleAttribute)?.lowercased() else {
            return false
        }
        return title.hasPrefix("zoom meeting")
    }
}

private let screenSharingMarkers = [
    "stop share",
    "pause share",
    "resume share",
    "new share",
    "you are screen sharing",
]

private func containsScreenSharingControls(_ root: AXUIElement) -> Bool {
    var queue = [(root, 0)]
    var visited = Set<CFHashCode>()

    while !queue.isEmpty && visited.count < 800 {
        let (element, depth) = queue.removeFirst()
        guard visited.insert(CFHash(element)).inserted else { continue }
        for attributeName in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            if let value = stringAttribute(element, attributeName)?.lowercased(),
               screenSharingMarkers.contains(where: value.contains) {
                return true
            }
        }
        if depth < 4 {
            queue.append(contentsOf: children(element).map { ($0, depth + 1) })
        }
    }
    return false
}

private func isScreenSharingWindow(_ element: AXUIElement) -> Bool {
    let title = stringAttribute(element, kAXTitleAttribute)?.lowercased() ?? ""
    if title == "share screen window" { return true }
    if title.contains("zoom") && title.contains("share") { return true }
    return containsScreenSharingControls(element)
}

private func participantDescriptions(in meetingWindow: AXUIElement) -> [String] {
    var queue = [(meetingWindow, 0)]
    var descriptions: [String] = []
    var visited = Set<CFHashCode>()

    while !queue.isEmpty && visited.count < 1500 {
        let (element, depth) = queue.removeFirst()
        guard visited.insert(CFHash(element)).inserted else { continue }
        if let description = stringAttribute(element, kAXDescriptionAttribute),
           participantName(from: description) != nil {
            descriptions.append(description)
        }
        if depth < 5 {
            queue.append(contentsOf: children(element).map { ($0, depth + 1) })
        }
    }
    return descriptions
}

private func snapshot() -> ZoomSnapshot {
    guard AXIsProcessTrusted() else {
        return ZoomSnapshot(accessibility: false, meetingOpen: false, screenSharing: false, participants: [], activeSpeakers: [])
    }
    guard let zoom = zoomApplication() else {
        return ZoomSnapshot(accessibility: true, meetingOpen: false, screenSharing: false, participants: [], activeSpeakers: [])
    }
    let application = AXUIElementCreateApplication(zoom.processIdentifier)
    let windows = children(application).filter {
        stringAttribute($0, kAXRoleAttribute) == kAXWindowRole
    }
    let window = meetingWindow(in: windows)
    let screenSharing = window == nil && windows.contains(where: isScreenSharingWindow)
    guard window != nil || screenSharing else {
        return ZoomSnapshot(accessibility: true, meetingOpen: false, screenSharing: false, participants: [], activeSpeakers: [])
    }

    let descriptions = window.map(participantDescriptions) ?? []
    let participants = Array(Set(descriptions.compactMap(participantName))).sorted()
    let activeSpeakerNames: [String] = descriptions.compactMap { description in
        guard description.lowercased().contains("active speaker") else { return nil }
        return participantName(from: description)
    }
    let activeSpeakers = Array(Set(activeSpeakerNames)).sorted()
    return ZoomSnapshot(
        accessibility: true,
        meetingOpen: true,
        screenSharing: screenSharing,
        participants: participants,
        activeSpeakers: activeSpeakers
    )
}

// Apps using the microphone or speakers, so calls outside Zoom can be detected.
// Helper processes (browser tabs, Electron renderers) are attributed to the app responsible for them.

private struct AudioApp: Equatable {
    let bundleId: String
    let name: String
    let input: Bool
    let output: Bool
    let titles: [String]
}

private typealias ResponsibleFunction = @convention(c) (pid_t) -> pid_t
private let responsiblePid: ResponsibleFunction? = {
    guard let symbol = dlsym(dlopen(nil, RTLD_NOW), "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(symbol, to: ResponsibleFunction.self)
}()

private func responsible(_ pid: pid_t) -> pid_t {
    let owner = responsiblePid?(pid) ?? pid
    return owner > 0 ? owner : pid
}

// Ember's own recording and dictation use the microphone too; never report them.
private let ownOwner = responsible(getppid())

private func audioValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
}

private func audioProcessObjects() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects) == noErr else { return [] }
    return objects
}

private func windowTitles(_ pid: pid_t) -> [String] {
    guard AXIsProcessTrusted() else { return [] }
    let application = AXUIElementCreateApplication(pid)
    return children(application)
        .filter { stringAttribute($0, kAXRoleAttribute) == kAXWindowRole }
        .compactMap { stringAttribute($0, kAXTitleAttribute) }
        .map { String($0.prefix(300)) }
}

private func audioApps() -> [AudioApp] {
    var byOwner: [pid_t: (input: Bool, output: Bool)] = [:]
    for object in audioProcessObjects() {
        guard let pid: pid_t = audioValue(object, kAudioProcessPropertyPID, 0), pid > 0 else { continue }
        let input = (audioValue(object, kAudioProcessPropertyIsRunningInput, UInt32(0)) ?? 0) != 0
        let output = (audioValue(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0
        guard input || output else { continue }
        let owner = responsible(pid)
        if owner == ownOwner || owner == getpid() { continue }
        let current = byOwner[owner] ?? (false, false)
        byOwner[owner] = (current.input || input, current.output || output)
    }
    return byOwner.compactMap { owner, use in
        guard let app = NSRunningApplication(processIdentifier: owner), let bundleId = app.bundleIdentifier else { return nil }
        // Window titles tell a browser's Google Meet tab from any other page using the microphone.
        return AudioApp(
            bundleId: bundleId,
            name: app.localizedName ?? bundleId,
            input: use.input,
            output: use.output,
            titles: use.input ? windowTitles(owner) : []
        )
    }.sorted { $0.bundleId < $1.bundleId }
}

private func emitAudio(_ apps: [AudioApp]) {
    let payload: [String: Any] = [
        "type": "audio-apps",
        "observedAt": Int64(Date().timeIntervalSince1970 * 1000),
        "apps": apps.map { ["bundleId": $0.bundleId, "name": $0.name, "input": $0.input, "output": $0.output, "titles": $0.titles] },
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

private func emit(_ snapshot: ZoomSnapshot) {
    let payload: [String: Any] = [
        "type": "zoom-accessibility",
        "observedAt": Int64(Date().timeIntervalSince1970 * 1000),
        "accessibility": snapshot.accessibility ? "granted" : "not-granted",
        "meetingOpen": snapshot.meetingOpen,
        "screenSharing": snapshot.screenSharing,
        "participants": snapshot.participants,
        "activeSpeakers": snapshot.activeSpeakers,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

private var previous: ZoomSnapshot?
private var previousAudio: [AudioApp]?
private var tick = 0
while true {
    autoreleasepool {
        let current = snapshot()
        if current != previous {
            emit(current)
            previous = current
        }
        // Audio use changes slowly; once a second is plenty.
        if tick % 5 == 0 {
            let apps = audioApps()
            if apps != previousAudio {
                emitAudio(apps)
                previousAudio = apps
            }
        }
        tick += 1
    }
    Thread.sleep(forTimeInterval: 0.2)
}
