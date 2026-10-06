import AppKit
import Foundation
import DriveCore

/// The drive itself: mounting, status, settings, search, share links and the cache.
@MainActor
final class Drive {
    static let shared = Drive()
    var onChange: (() -> Void)?
    private(set) var message: String?

    /// /Volumes/Ember Drive once the one-time sidebar setup is done (Finder only lists /Volumes mounts in its sidebar),
    /// otherwise ~/Ember Drive.
    var mountPoint: URL { MountPointSetup.isReady ? MountPointSetup.volumesURL : MountPointSetup.homeURL }

    var mounted: Bool { isMounted(MountPointSetup.volumesURL.path) || isMounted(MountPointSetup.homeURL.path) }
    var currentPath: String { isMounted(MountPointSetup.volumesURL.path) ? MountPointSetup.volumesURL.path : MountPointSetup.homeURL.path }

    var pendingUploads: Int {
        guard let paths = Env.shared.paths, let d = try? Data(contentsOf: paths.uploadJournal),
              let jobs = try? JSONDecoder().decode([UploadQueue.Job].self, from: d) else { return 0 }
        return jobs.count
    }

    private func isMounted(_ path: String) -> Bool {
        var s = statfs()
        guard statfs(path, &s) == 0 else { return false }
        return withUnsafePointer(to: &s.f_fstypename) { $0.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) } } == "emberdrive"
    }

    func status() -> [String: Any] {
        let cfg = Env.shared.config
        let notice = Env.shared.paths?.readNotice()
        let pins = Pins.shared
        return [
            "supported": true,
            "configured": cfg != nil,
            "provider": cfg?.provider.rawValue as Any,
            "bucket": cfg?.bucketName as Any,
            "mounted": mounted,
            "path": mounted ? currentPath : mountPoint.path,
            "sidebarReady": MountPointSetup.isReady,
            "pendingUploads": pendingUploads,
            "message": message as Any,
            "notice": notice.map { ["message": $0.message, "actionTitle": $0.actionTitle as Any, "actionURL": $0.actionURL as Any] } as Any,
            "pins": ["keys": pins.keys, "syncing": pins.syncing, "done": pins.filesDone, "total": pins.filesTotal],
            "cacheLimitGB": cfg?.cacheLimitGB ?? 20,
            "legacyGhost": Migration.legacyConfigExists,
        ]
    }

    /// The settings without secrets, for the settings form.
    func settings() -> [String: Any] {
        guard let c = Env.shared.config else { return [:] }
        return ["provider": c.provider.rawValue, "keyID": c.keyID, "hasSecret": !c.applicationKey.isEmpty, "bucketName": c.bucketName,
                "accountID": c.accountID, "region": c.region, "endpoint": c.endpoint, "cacheLimitGB": c.cacheLimitGB]
    }

    private var refreshing = false

    func mount(refreshed: Bool = false) {
        guard Env.shared.config != nil else { message = "Set up Ember Drive first."; onChange?(); return }
        guard !mounted, !refreshing || refreshed else { return }
        try? FileManager.default.createDirectory(at: mountPoint, withIntermediateDirectories: true)
        if let problem = FSKitEnablement.ensureEnabled() { message = problem; onChange?(); return }
        run("/sbin/mount", ["-F", "-t", "emberdrive", "emberdrive://\(Env.shared.config!.bucketName)", mountPoint.path]) { [weak self] in
            guard let self, !self.mounted, !refreshed, let problem = self.message else { return }
            // After Ember updates, FSKit can hold on to the old copy of the extension until it restarts.
            if problem.contains("extensionKit.errorDomain error 2") || problem.contains("named emberdrive not found") {
                DiagnosticsLog.append("FSKit has a stale copy of the extension; restarting it")
                self.refreshing = true
                Task.detached {
                    FSKitEnablement.restartAgent()
                    await MainActor.run {
                        self.mount(refreshed: true)
                        self.refreshing = false
                    }
                }
            }
        }
    }

    func unmount(then: (() -> Void)? = nil) {
        guard mounted else { then?(); return }
        run("/usr/sbin/diskutil", ["unmount", currentPath], then: then)
    }

    /// After the storage settings change: unmount the old drive, then mount on the new settings.
    func reconnect() {
        Env.shared.reset()
        unmount { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.mount() }
        }
    }

    func openInFinder() { NSWorkspace.shared.open(URL(fileURLWithPath: mounted ? currentPath : mountPoint.path)) }

    /// One-time admin prompt that makes /Volumes/Ember Drive available at every boot, so the drive sits in Finder's sidebar.
    func setUpSidebar(reply: @escaping (String?) -> Void) {
        Task.detached {
            let result = MountPointSetup.install()
            await MainActor.run {
                if result == nil, self.mounted, self.currentPath != MountPointSetup.volumesURL.path {
                    // Move the drive across to its sidebar home.
                    self.unmount { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.mount() } }
                }
                reply(result)
                self.onChange?()
            }
        }
    }

    /// Tests settings end to end (sign in, write, read, delete, trash rule, share link), reporting each step.
    func test(_ cfg: SharedConfig, progress: @escaping @Sendable ([StorageCheck]) -> Void) async -> Bool {
        await StorageVerifier.run(config: cfg, update: progress)
    }

    func save(_ input: SharedConfig) throws {
        guard let paths = Env.shared.paths else { throw NSError(domain: "EmberDrive", code: 1, userInfo: [NSLocalizedDescriptionKey: "The drive's settings folder isn't available."]) }
        var c = input
        c.keyID = c.keyID.trimmingCharacters(in: .whitespaces); c.applicationKey = c.applicationKey.trimmingCharacters(in: .whitespaces)
        c.bucketName = c.bucketName.trimmingCharacters(in: .whitespaces); c.accountID = c.accountID.trimmingCharacters(in: .whitespaces)
        c.region = c.region.trimmingCharacters(in: .whitespaces); c.endpoint = c.endpoint.trimmingCharacters(in: .whitespaces)
        if c.provider != .b2 { c.bucketID = nil }
        try paths.save(c)
        reconnect()
    }

    func forget() {
        unmount()
        if let paths = Env.shared.paths { try? FileManager.default.removeItem(at: paths.config) }
        Env.shared.reset()
        onChange?()
    }

    func setCacheLimit(_ gb: Int) {
        guard let paths = Env.shared.paths, var c = paths.loadConfig() else { return }
        c.cacheLimitGB = gb
        try? paths.save(c)
        Env.shared.reset()
    }

    func cacheBytes() -> Int64 {
        guard let dir = Env.shared.paths?.chunkCache else { return 0 }
        return ChunkReader.directorySize(dir)
    }

    func clearCache() {
        guard let dir = Env.shared.paths?.chunkCache else { return }
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    func shareLink(key: String) async throws -> String {
        guard let client = Env.shared.client else { throw NSError(domain: "EmberDrive", code: 2, userInfo: [NSLocalizedDescriptionKey: "Set up Ember Drive first."]) }
        return try await client.shareURL(key: key).absoluteString
    }

    func reveal(key: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: mounted ? currentPath : mountPoint.path).appendingPathComponent(key)])
    }

    /// Copies a local file onto the drive (Ember's backups use this), through the mounted volume so it uploads like any other write.
    func put(file: URL, as key: String) throws {
        guard mounted else { throw NSError(domain: "EmberDrive", code: 3, userInfo: [NSLocalizedDescriptionKey: "Ember Drive isn't mounted."]) }
        let target = URL(fileURLWithPath: currentPath).appendingPathComponent(key)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
        try FileManager.default.copyItem(at: file, to: target)
    }

    private func run(_ exe: String, _ args: [String], then: (() -> Void)? = nil) {
        let p = Process(); p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
        let pipe = Pipe(); p.standardError = pipe; p.standardOutput = pipe
        p.terminationHandler = { proc in
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            Task { @MainActor in
                self.message = proc.terminationStatus == 0 ? nil : out.trimmingCharacters(in: .whitespacesAndNewlines)
                if proc.terminationStatus == 0, exe == "/sbin/mount", MountPointSetup.isReady { SidebarFavorite.ensureAdded() }
                self.onChange?()
                then?()
            }
        }
        do { try p.run() } catch { message = "\(error)"; onChange?(); then?() }
    }
}

/// The ⌃⌥O quick search: a whole-drive filename index, rebuilt from a full listing when it's over 90 seconds old.
@MainActor
final class SearchIndex {
    static let shared = SearchIndex()
    private var all: [(key: String, size: Int64)] = []
    private var indexedAt = Date.distantPast
    private var building: Task<Void, Never>?

    var count: Int { all.count }

    func refresh() async {
        if let building { await building.value; return }
        guard Date().timeIntervalSince(indexedAt) > 90, let client = Env.shared.client else { return }
        let task = Task {
            let objs = (try? await client.listAll(prefix: "")) ?? []
            self.all = objs.filter { $0.kind == .file && !$0.name.hasSuffix(B2Client.keepName) && !($0.name as NSString).lastPathComponent.hasPrefix("._") && !$0.name.hasPrefix(ghostTrashPrefix) }
                .map { ($0.name, $0.size) }
            self.indexedAt = Date()
            self.building = nil
        }
        building = task
        await task.value
    }

    /// Every word must match; names starting with the words come first, then names containing them, then paths.
    func search(_ query: String) -> [[String: Any]] {
        let terms = query.lowercased().split(separator: " ").map(String.init)
        let hits: [(key: String, size: Int64)]
        if terms.isEmpty { hits = Array(all.prefix(40)) }
        else {
            func rank(_ key: String) -> Int {
                let name = (key as NSString).lastPathComponent.lowercased()
                return terms.allSatisfy { name.hasPrefix($0) } ? 0 : terms.allSatisfy { name.contains($0) } ? 1 : 2
            }
            hits = all.filter { h in let l = h.key.lowercased(); return terms.allSatisfy { l.contains($0) } }
                .sorted { rank($0.key) < rank($1.key) }.prefix(60).map { $0 }
        }
        return hits.map { ["key": $0.key, "name": ($0.key as NSString).lastPathComponent, "folder": ($0.key as NSString).deletingLastPathComponent, "size": $0.size] }
    }
}

/// Ghost, the standalone app Ember Drive replaces: its settings and offline list are brought across once.
enum Migration {
    static var legacyRoot: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedPaths.legacyAppGroup) }
    static var legacyConfigExists: Bool {
        guard let root = legacyRoot, Env.shared.config == nil else { return false }
        return FileManager.default.fileExists(atPath: root.appendingPathComponent("config.json").path)
    }

    /// Copies Ghost's storage settings and pins. Returns false if there was nothing to bring across.
    static func importFromGhost() throws -> Bool {
        guard let root = legacyRoot, let paths = Env.shared.paths else { return false }
        let legacy = SharedPaths(root: root)
        guard var c = legacy.loadConfig() else { return false }
        c.volumeName = "Ember Drive"
        try paths.save(c)
        if let pins = try? Data(contentsOf: legacy.pins) { try? pins.write(to: paths.pins, options: .atomic) }
        Env.shared.reset()
        return true
    }
}
