import Foundation

/// Reads remote files in fixed-size chunks with an on-disk LRU cache, request coalescing and sequential read-ahead.
/// This is what makes "open a 4 GB video instantly" work: only the chunks actually touched are downloaded.
public actor ChunkReader {
    public static let chunkSize = 4 * 1024 * 1024

    private let client: any ObjectStore
    private let cacheDir: URL
    private let pinnedDir: URL?                     // chunks here are never evicted ("Keep on this Mac")
    private let maxCacheBytes: Int64
    private let readAhead: Int
    private var inflight: [String: Task<Data, Error>] = [:]
    private var lastChunk: [String: Int] = [:]      // per-file, to detect sequential access
    private var memory: [String: Data] = [:]        // tiny hot cache (most recent chunks)
    private var memoryOrder: [String] = []
    private let memoryLimit = 24                    // 24 x 4MB = ~96MB
    private var bytesSinceTrim: Int64 = 0

    public init(client: any ObjectStore, cacheDir: URL, pinnedDir: URL? = nil, maxCacheBytes: Int64 = 20 * 1024 * 1024 * 1024, readAhead: Int = 4) {
        self.client = client
        self.cacheDir = cacheDir
        self.pinnedDir = pinnedDir
        if let pinnedDir { try? FileManager.default.createDirectory(at: pinnedDir, withIntermediateDirectories: true) }
        self.maxCacheBytes = maxCacheBytes
        self.readAhead = readAhead
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    /// Cache identity includes size+mtime so an edited remote file never serves stale chunks.
    public static func identity(key: String, size: Int64, mtime: Date) -> String {
        let raw = "\(key)|\(size)|\(Int64(mtime.timeIntervalSince1970))"
        var h: UInt64 = 0xcbf29ce484222325
        for b in raw.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return String(h, radix: 16)
    }

    public func read(key: String, identity: String, size: Int64, offset: Int64, length: Int, fileID: String? = nil) async throws -> Data {
        guard offset < size, length > 0 else { return Data() }
        let end = min(offset + Int64(length), size)
        let cs = Int64(Self.chunkSize)
        let first = Int(offset / cs), last = Int((end - 1) / cs)

        let sequential = lastChunk[identity].map { first == $0 || first == $0 + 1 } ?? (first == 0)
        lastChunk[identity] = last

        // Cold small read (file open, header probe, first frame): fetch just the bytes asked for (min 512 KB) so the
        // caller isn't waiting on a full 4 MB chunk, then pull the whole chunk and read-ahead in the background.
        if first == last, length <= 2 * 1024 * 1024, !isCachedOrInflight(identity: identity, index: first) {
            let want = Int(min(max(Int64(length), 512 * 1024), size - offset))
            let d = try await client.read(key: key, offset: offset, length: want, fileID: fileID)
            prefetch(key: key, identity: identity, size: size, index: first, fileID: fileID)
            kickReadAhead(key: key, identity: identity, size: size, last: last, sequential: sequential, fileID: fileID)
            return d.count > length ? d.prefix(length) : d
        }

        var out = Data(capacity: Int(end - offset))
        // Fetch needed chunks concurrently, assemble in order.
        let chunks = try await withThrowingTaskGroup(of: (Int, Data).self) { group in
            for i in first...last {
                group.addTask { (i, try await self.chunk(key: key, identity: identity, size: size, index: i, fileID: fileID)) }
            }
            var m: [Int: Data] = [:]
            for try await (i, d) in group { m[i] = d }
            return m
        }
        for i in first...last {
            guard let c = chunks[i] else { continue }
            let chunkStart = Int64(i) * cs
            let from = Int(max(offset - chunkStart, 0))
            let to = Int(min(end - chunkStart, Int64(c.count)))
            if from < to { out.append(c.subdata(in: from..<to)) }
        }
        // Read-ahead only after the requested bytes are in hand, so it never competes with the foreground read.
        kickReadAhead(key: key, identity: identity, size: size, last: last, sequential: sequential, fileID: fileID)
        return out
    }

    private func pinnedPath(_ identity: String, _ index: Int) -> URL? {
        pinnedDir?.appendingPathComponent(identity, isDirectory: true).appendingPathComponent(String(index))
    }

    private func isCachedOrInflight(identity: String, index: Int) -> Bool {
        let id = "\(identity)/\(index)"
        if memory[id] != nil || inflight[id] != nil { return true }
        if let p = pinnedPath(identity, index), FileManager.default.fileExists(atPath: p.path) { return true }
        return FileManager.default.fileExists(atPath: path(identity, index).path)
    }

    /// Downloads every chunk of a file into the pinned store so it's readable with no network. Returns bytes fetched.
    @discardableResult
    public func pin(key: String, identity: String, size: Int64, fileID: String? = nil) async throws -> Int64 {
        guard let dir = pinnedDir else { return 0 }
        let cs = Int64(Self.chunkSize)
        let total = Int((size + cs - 1) / cs)
        var fetched: Int64 = 0
        for i in 0..<total {
            let p = dir.appendingPathComponent(identity, isDirectory: true).appendingPathComponent(String(i))
            if FileManager.default.fileExists(atPath: p.path) { continue }
            let d = try await chunk(key: key, identity: identity, size: size, index: i, fileID: fileID)       // also warms the normal cache
            try? FileManager.default.createDirectory(at: p.deletingLastPathComponent(), withIntermediateDirectories: true)
            try d.write(to: p, options: .atomic)
            fetched += Int64(d.count)
        }
        return fetched
    }

    public func unpin(identity: String) {
        guard let dir = pinnedDir else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(identity, isDirectory: true))
    }

    public func isPinned(identity: String, size: Int64) -> Bool {
        guard let dir = pinnedDir else { return false }
        let total = Int((size + Int64(Self.chunkSize) - 1) / Int64(Self.chunkSize))
        return (0..<total).allSatisfy { FileManager.default.fileExists(atPath: dir.appendingPathComponent(identity).appendingPathComponent(String($0)).path) }
    }

    public func pinnedBytes() -> Int64 { pinnedDir.map(Self.directorySize) ?? 0 }

    private func kickReadAhead(key: String, identity: String, size: Int64, last: Int, sequential: Bool, fileID: String?) {
        guard sequential, readAhead > 0 else { return }
        let totalChunks = Int((size + Int64(Self.chunkSize) - 1) / Int64(Self.chunkSize))
        for i in (last + 1)...(last + readAhead) where i < totalChunks {
            prefetch(key: key, identity: identity, size: size, index: i, fileID: fileID)
        }
    }

    private func prefetch(key: String, identity: String, size: Int64, index: Int, fileID: String?) {
        Task.detached(priority: .utility) { [self] in
            _ = try? await self.chunk(key: key, identity: identity, size: size, index: index, fileID: fileID)
        }
    }

    private func path(_ identity: String, _ index: Int) -> URL {
        cacheDir.appendingPathComponent(identity, isDirectory: true).appendingPathComponent(String(index))
    }

    func chunk(key: String, identity: String, size: Int64, index: Int, fileID: String? = nil) async throws -> Data {
        let id = "\(identity)/\(index)"
        if let m = memory[id] { return m }
        if let pp = pinnedPath(identity, index), let d = try? Data(contentsOf: pp) { remember(id, d); return d }
        let p = path(identity, index)
        if let d = try? Data(contentsOf: p) {
            remember(id, d)
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: p.path)
            return d
        }
        if let t = inflight[id] { return try await t.value }

        let cs = Int64(Self.chunkSize)
        let start = Int64(index) * cs
        let len = Int(min(cs, size - start))
        let client = self.client
        let task = Task<Data, Error> {
            var lastError: Error?
            for attempt in 0..<4 {
                do {
                    let d = try await client.read(key: key, offset: start, length: len, fileID: fileID)
                    if d.count == len { return d }
                    lastError = B2Error.badResponse("short read \(d.count)/\(len)")
                } catch B2Error.notFound { throw B2Error.notFound } catch { lastError = error }
                try await Task.sleep(for: .milliseconds(300 * (attempt + 1)))
            }
            throw lastError ?? B2Error.badResponse("chunk")
        }
        inflight[id] = task
        defer { inflight[id] = nil }
        let d = try await task.value
        try? FileManager.default.createDirectory(at: p.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? d.write(to: p, options: .atomic)
        remember(id, d)
        bytesSinceTrim += Int64(d.count)
        if bytesSinceTrim > 256 * 1024 * 1024 { bytesSinceTrim = 0; trimInBackground() }
        return d
    }

    private func remember(_ id: String, _ d: Data) {
        memory[id] = d
        memoryOrder.removeAll { $0 == id }
        memoryOrder.append(id)
        while memoryOrder.count > memoryLimit { memory[memoryOrder.removeFirst()] = nil }
    }

    /// Drops cached chunks for a file (after it's changed or deleted).
    public func invalidate(identity: String) {
        try? FileManager.default.removeItem(at: cacheDir.appendingPathComponent(identity, isDirectory: true))
        for k in memory.keys where k.hasPrefix(identity + "/") { memory[k] = nil }
        memoryOrder.removeAll { $0.hasPrefix(identity + "/") }
    }

    public func cacheSize() -> Int64 { Self.directorySize(cacheDir) }

    private func trimInBackground() {
        let dir = cacheDir, limit = maxCacheBytes
        Task.detached(priority: .background) { Self.trim(dir: dir, limit: limit) }
    }

    public static func directorySize(_ dir: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let u as URL in e { total += Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        return total
    }

    /// Evicts least-recently-used chunks until under the limit.
    static func trim(dir: URL, limit: Int64) {
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) else { return }
        var files: [(URL, Int64, Date)] = []
        var total: Int64 = 0
        for case let u as URL in e {
            guard let v = try? u.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]), let s = v.fileSize, s > 0 else { continue }
            files.append((u, Int64(s), v.contentModificationDate ?? .distantPast)); total += Int64(s)
        }
        guard total > limit else { return }
        for f in files.sorted(by: { $0.2 < $1.2 }) {
            try? FileManager.default.removeItem(at: f.0)
            total -= f.1
            if total <= Int64(Double(limit) * 0.9) { break }
        }
    }
}
