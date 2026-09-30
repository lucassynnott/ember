import AppKit
import ApplicationServices
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
while true {
    autoreleasepool {
        let current = snapshot()
        if current != previous {
            emit(current)
            previous = current
        }
    }
    Thread.sleep(forTimeInterval: 0.2)
}
