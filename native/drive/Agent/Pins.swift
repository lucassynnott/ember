import Foundation
import DriveCore

/// "Keep on this Mac": pinned files and folders are fully downloaded into a store the cache never evicts, and re-synced
/// every 10 minutes so new and changed files inside pinned folders arrive by themselves.
@MainActor
final class Pins {
    static let shared = Pins()

    private(set) var keys: [String] = []
    private(set) var filesDone = 0
    private(set) var filesTotal = 0
    private(set) var syncing = false
    var onChange: (() -> Void)?

    private var identities: [String: String] = [:]      // file key -> pinned identity
    private var timer: Timer?
    private var task: Task<Void, Never>?
    private struct State: Codable { var keys: [String]; var identities: [String: String] }

    init() {
        if let u = Env.shared.paths?.pins, let d = try? Data(contentsOf: u), let s = try? JSONDecoder().decode(State.self, from: d) {
            keys = s.keys; identities = s.identities
        }
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in Task { @MainActor in Pins.shared.sync() } }
        sync()
    }

    func pin(_ add: [String]) {
        for k in add where !keys.contains(k) { keys.append(k) }
        save(); sync()
        Toast.show("Keeping \(add.count) item\(add.count == 1 ? "" : "s") on this Mac")
    }

    func unpin(_ remove: [String]) {
        keys.removeAll { k in remove.contains { k == $0 || k.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") } }
        save(); sync()
        Toast.show("Offline copy removed")
    }

    var pinnedBytes: Int64 { Env.shared.paths.map { ChunkReader.directorySize($0.pinned) } ?? 0 }

    private func save() {
        guard let u = Env.shared.paths?.pins else { return }
        try? JSONEncoder().encode(State(keys: keys, identities: identities)).write(to: u, options: .atomic)
        onChange?()
    }

    /// Downloads anything pinned that isn't local yet and drops pinned copies that are no longer wanted.
    func sync() {
        guard task == nil, let client = Env.shared.client, let reader = Env.shared.reader else { return }
        let wantedKeys = keys
        syncing = true
        onChange?()
        task = Task {
            var wanted: [String: RemoteObject] = [:]
            for k in wantedKeys {
                if let objs = try? await client.listAll(prefix: k) {
                    for o in objs where o.kind == .file && !o.name.hasSuffix(B2Client.keepName) { wanted[o.name] = o }
                }
                if !k.hasSuffix("/"), let o = try? await client.stat(key: k) { wanted[o.name] = o }
            }
            self.filesTotal = wanted.count; self.filesDone = 0; self.onChange?()
            var next: [String: String] = [:]
            for (key, o) in wanted {
                let ident = ChunkReader.identity(key: key, size: o.size, mtime: o.modified)
                next[key] = ident
                if let old = self.identities[key], old != ident { await reader.unpin(identity: old) }
                _ = try? await reader.pin(key: key, identity: ident, size: o.size, fileID: o.fileID)
                self.filesDone += 1; self.onChange?()
            }
            for (key, old) in self.identities where next[key] == nil { await reader.unpin(identity: old) }
            self.identities = next
            self.syncing = false; self.task = nil
            self.save()
        }
    }
}

/// Providers other than Backblaze have no dependable server-side expiry for the trash folder (and many keys can't set
/// one), so deleted files older than 30 days are cleared here, shortly after launch and twice a day.
enum TrashPurge {
    private static var timer: Timer?

    static func start() {
        run()
        timer = Timer.scheduledTimer(withTimeInterval: 12 * 3600, repeats: true) { _ in run() }
    }

    static func run() {
        guard let cfg = Env.shared.config, cfg.provider != .b2, let store = Env.shared.client else { return }
        Task.detached(priority: .background) {
            let n = (try? await store.purgeTrash(olderThanDays: 30)) ?? 0
            if n > 0 { DiagnosticsLog.append("purged \(n) trashed object(s) older than 30 days") }
        }
    }
}
