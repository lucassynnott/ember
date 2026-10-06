import Foundation

/// Persists directory listings so the drive still browses (and pinned files still open) with no network.
public final class ListingCache: @unchecked Sendable {
    public struct Entry: Codable {
        public var name: String, isFolder: Bool, size: Int64, modified: Date, fileID: String?
    }

    private let file: URL
    private let lock = NSLock()
    private var data: [String: [Entry]] = [:]
    private var lastWrite = Date.distantPast

    public init(file: URL) {
        self.file = file
        if let d = try? Data(contentsOf: file), let m = try? JSONDecoder().decode([String: [Entry]].self, from: d) { data = m }
    }

    public func get(prefix: String) -> [RemoteObject]? {
        lock.lock(); defer { lock.unlock() }
        return data[prefix]?.map { RemoteObject(name: $0.name, kind: $0.isFolder ? .folder : .file, size: $0.size, modified: $0.modified, fileID: $0.fileID) }
    }

    public func put(prefix: String, objects: [RemoteObject]) {
        lock.lock()
        data[prefix] = objects.map { Entry(name: $0.name, isFolder: $0.kind == .folder, size: $0.size, modified: $0.modified, fileID: $0.fileID) }
        let due = Date().timeIntervalSince(lastWrite) > 3
        let snapshot = due ? data : nil
        if due { lastWrite = Date() }
        lock.unlock()
        if let snapshot, let d = try? JSONEncoder().encode(snapshot) { try? d.write(to: file, options: .atomic) }
    }
}
