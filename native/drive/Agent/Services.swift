import AppKit
import DriveCore

/// Finder right-click actions (the Services menu): copy a share link, keep a file or folder offline, remove the offline copy.
final class ServiceHandler: NSObject {
    private func paths(_ pboard: NSPasteboard) -> [String] {
        (pboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL])?.map(\.path) ?? []
    }

    @objc func copyShareLink(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        let files = paths(pboard).compactMap { Env.key(forPath: $0) }.filter { !$0.isEmpty && !$0.hasSuffix("/") }
        guard !files.isEmpty, let client = Env.shared.client else {
            Task { @MainActor in Toast.show("Pick a file on Ember Drive", symbol: "exclamationmark.circle.fill") }
            return
        }
        Task {
            do {
                var links: [String] = []
                for key in files { links.append(try await client.shareURL(key: key).absoluteString) }
                await MainActor.run {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(links.joined(separator: "\n"), forType: .string)
                    Toast.show(links.count == 1 ? "Share link copied (works for 7 days)" : "\(links.count) share links copied")
                }
            } catch { await MainActor.run { Toast.show("Couldn't make a link: \(error)", symbol: "xmark.circle.fill") } }
        }
    }

    /// A video on the drive, shared through Ember's share page (Ember brings it in as a recording first).
    @objc func shareWithEmber(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        guard let file = paths(pboard).first else { return }
        guard Channel.shared.connected else {
            Task { @MainActor in Toast.show("Open Ember first, then try again", symbol: "exclamationmark.circle.fill") }
            return
        }
        Channel.shared.event("shareFile", ["path": file])
    }

    @objc func keepOffline(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        let keys = paths(pboard).compactMap { Env.key(forPath: $0) }
        Task { @MainActor in Pins.shared.pin(keys) }
    }

    @objc func removeOffline(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        let keys = paths(pboard).compactMap { Env.key(forPath: $0) }
        Task { @MainActor in Pins.shared.unpin(keys) }
    }
}
