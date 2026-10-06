import Foundation

/// Background write-back queue. Files are staged locally first (so apps never block on the network), then uploaded
/// with retry/backoff. The pending list is journaled to disk so interrupted uploads resume after a crash or relaunch.
public actor UploadQueue {
    public struct Job: Codable, Sendable, Equatable {
        public var key: String
        public var stagedPath: String
        public var queuedAt: Date
        /// The remote version this edit was based on (nil for a brand-new file). If the cloud has moved on since, we upload
        /// as a "conflicted copy" instead of overwriting another Mac's changes.
        public var baseFileID: String?
    }

    public struct Status: Sendable {
        public var pending: Int
        public var uploading: String?
        public var bytesDone: Int64
        public var bytesTotal: Int64
        public var lastError: String?
    }

    private let client: any ObjectStore
    private let journal: URL
    private var jobs: [Job] = []
    private var running = false
    private var current: Job?
    private var bytesDone: Int64 = 0
    private var bytesTotal: Int64 = 0
    private var lastError: String?
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    public var onUploaded: (@Sendable (String, URL) -> Void)?

    public init(client: any ObjectStore, journal: URL) {
        self.client = client
        self.journal = journal
        if let d = try? Data(contentsOf: journal), let j = try? JSONDecoder().decode([Job].self, from: d) {
            jobs = j.filter { FileManager.default.fileExists(atPath: $0.stagedPath) }
        }
    }

    public func setOnUploaded(_ f: (@Sendable (String, URL) -> Void)?) { onUploaded = f }

    /// Call once after init to resume anything left over from a previous run.
    public func resume() { if !jobs.isEmpty { startIfNeeded() } }

    private var lastUploadedID: [String: String] = [:]

    public func enqueue(key: String, staged: URL, baseFileID: String? = nil) {
        // A newer edit supersedes a queued older one, but keeps the original base so conflicts are judged against what we started from.
        let base = jobs.first { $0.key == key }?.baseFileID ?? baseFileID
        jobs.removeAll { $0.key == key }
        jobs.append(Job(key: key, stagedPath: staged.path, queuedAt: Date(), baseFileID: base))
        persist()
        startIfNeeded()
    }

    public func isPending(key: String) -> Bool { jobs.contains { $0.key == key } || current?.key == key }
    public func stagedURL(for key: String) -> URL? {
        if let c = current, c.key == key { return URL(fileURLWithPath: c.stagedPath) }
        return jobs.first { $0.key == key }.map { URL(fileURLWithPath: $0.stagedPath) }
    }
    public func status() -> Status {
        Status(pending: jobs.count + (current == nil ? 0 : 1), uploading: current?.key, bytesDone: bytesDone, bytesTotal: bytesTotal, lastError: lastError)
    }

    /// Suspends until `key` has finished uploading (used by fsync/synchronize).
    public func waitUntilUploaded(key: String) async {
        guard isPending(key: key) else { return }
        await withCheckedContinuation { waiters[key, default: []].append($0) }
    }

    private func persist() {
        let all = jobs + (current.map { [$0] } ?? [])
        try? JSONEncoder().encode(all).write(to: journal, options: .atomic)
    }

    private func startIfNeeded() {
        guard !running else { return }
        running = true
        Task { await self.drain() }
    }

    private func drain() async {
        var backoff: UInt64 = 2
        while let job = jobs.first {
            jobs.removeFirst()
            current = job
            let url = URL(fileURLWithPath: job.stagedPath)
            let size = ((try? FileManager.default.attributesOfItem(atPath: job.stagedPath)[.size]) as? NSNumber)?.int64Value ?? 0
            bytesDone = 0; bytesTotal = size
            do {
                var target = job.key
                if let remote = try await client.stat(key: job.key), remote.fileID != job.baseFileID, remote.fileID != lastUploadedID[job.key] {
                    target = Self.conflictKey(for: job.key)       // another Mac changed it; keep both, lose nothing
                }
                try await client.upload(file: url, as: target, mtime: nil, progress: { [weak self] done in
                    Task { await self?.setProgress(done) }
                })
                if target == job.key, let now = try? await client.stat(key: target) { lastUploadedID[job.key] = now.fileID }
                lastError = nil; backoff = 2
                // If a newer version was queued while this uploaded, keep the staged file for it; else notify and finish.
                let superseded = jobs.contains { $0.key == job.key }
                current = nil
                persist()
                if !superseded { onUploaded?(job.key, url) }
                release(job.key)
            } catch {
                lastError = "\(error)"
                current = nil
                if !FileManager.default.fileExists(atPath: job.stagedPath) { persist(); release(job.key); continue }
                if !jobs.contains(where: { $0.key == job.key }) { jobs.insert(job, at: 0) }   // retry same job
                persist()
                try? await Task.sleep(for: .seconds(Double(backoff)))
                backoff = min(backoff * 2, 60)
            }
        }
        running = false
        persist()
    }

    private func setProgress(_ d: Int64) { bytesDone = d }

    /// "dir/report.pdf" -> "dir/report (conflicted copy from MacStudio 2026-10-06 1341).pdf"
    static func conflictKey(for key: String) -> String {
        let host = Host.current().localizedName ?? "another Mac"
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HHmm"
        let stamp = f.string(from: Date())
        let ns = key as NSString
        let ext = ns.pathExtension, base = (ns.deletingPathExtension as NSString).lastPathComponent, dir = (ns.deletingLastPathComponent as NSString)
        let name = "\(base) (conflicted copy from \(host) \(stamp))" + (ext.isEmpty ? "" : ".\(ext)")
        return dir.length == 0 ? name : "\(dir)/\(name)"
    }

    private func release(_ key: String) {
        guard !isPending(key: key), let w = waiters.removeValue(forKey: key) else { return }
        w.forEach { $0.resume() }
    }
}
