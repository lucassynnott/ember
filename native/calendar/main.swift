// Reads events from macOS Calendar (which includes Google and Outlook accounts added in System
// Settings) so a call can be named after its event. Prints one JSON object and exits.
//
//   meeting-notes-calendar status
//   meeting-notes-calendar request
//   meeting-notes-calendar events <fromEpochMs> <toEpochMs>

import EventKit
import Foundation

let store = EKEventStore()

func output(_ object: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
    exit(0)
}

func statusName() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess: return "granted"
    case .writeOnly: return "write-only"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

// Conference links in the location, URL or notes tell which app the call is in.
func conferenceLink(_ event: EKEvent) -> String? {
    let fields = [event.url?.absoluteString, event.location, event.notes].compactMap { $0 }
    let pattern = #"https?://[^\s<>"]*(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|webex\.com|whereby\.com|meet\.jit\.si|around\.co)[^\s<>"]*"#
    for field in fields {
        if let range = field.range(of: pattern, options: .regularExpression) { return String(field[range]) }
    }
    return nil
}

func events(from: Date, to: Date) -> [[String: Any]] {
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    return store.events(matching: predicate)
        .filter { !$0.isAllDay }
        .prefix(50)
        .map { event in
            var attendees: [[String: Any]] = []
            for participant in event.attendees ?? [] {
                var entry: [String: Any] = ["me": participant.isCurrentUser]
                if let name = participant.name { entry["name"] = name }
                let url = participant.url.absoluteString
                if url.lowercased().hasPrefix("mailto:") { entry["email"] = String(url.dropFirst(7)) }
                if participant.participantStatus == .declined { entry["declined"] = true }
                attendees.append(entry)
            }
            var item: [String: Any] = [
                "title": event.title ?? "",
                "start": Int64(event.startDate.timeIntervalSince1970 * 1000),
                "end": Int64(event.endDate.timeIntervalSince1970 * 1000),
                "calendar": event.calendar?.title ?? "",
                // A repeating event (weekly standup, fortnightly 1:1), so prep can read the last few.
                "recurring": event.hasRecurrenceRules || event.isDetached,
                "attendees": attendees,
            ]
            if let organizer = event.organizer?.name { item["organizer"] = organizer }
            if let link = conferenceLink(event) { item["link"] = link }
            return item
        }
}

let arguments = CommandLine.arguments.dropFirst()
switch arguments.first {
case "status":
    output(["status": statusName()])
case "request":
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    var failure: String?
    store.requestFullAccessToEvents { ok, error in
        granted = ok
        failure = error?.localizedDescription
        semaphore.signal()
    }
    semaphore.wait()
    output(["status": granted ? "granted" : statusName(), "error": failure ?? NSNull()])
case "events":
    guard statusName() == "granted" else { output(["status": statusName(), "events": []]) }
    let values = arguments.dropFirst().compactMap { Double($0) }
    guard values.count == 2 else { output(["error": "Usage: events <fromEpochMs> <toEpochMs>"]) }
    let from = Date(timeIntervalSince1970: values[0] / 1000)
    let to = Date(timeIntervalSince1970: values[1] / 1000)
    output(["status": "granted", "events": events(from: from, to: to)])
default:
    output(["error": "Usage: status | request | events <fromEpochMs> <toEpochMs>"])
}
