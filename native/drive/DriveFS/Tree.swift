import Foundation
import FSKit
import DriveCore

/// One file or directory in the mounted volume. Subclasses FSItem so FSKit can hand it back to us.
final class CNode: FSItem {
    let id: FSItem.Identifier
    var name: String
    weak var parent: CNode?
    var isDirectory: Bool
    var size: Int64
    var mtime: Date
    var fileID: String?
    var children: [String: CNode]?        // nil => not listed yet
    var listedAt: Date = .distantPast
    var staged: URL?                      // local copy, present while dirty / uploading / open for write
    var dirty = false
    var openWriters = 0
    var baseFileID: String?               // remote version our local edits are based on (conflict detection)
    var virtual = false                   // synthesized by the extension (e.g. the volume icon); read-only, never uploaded
    var xattrs: [String: Data] = [:]      // in-memory only; keeps macOS from littering the cloud with ._ sidecars

    init(id: FSItem.Identifier, name: String, parent: CNode?, isDirectory: Bool, size: Int64, mtime: Date, fileID: String?) {
        self.id = id; self.name = name; self.parent = parent; self.isDirectory = isDirectory
        self.size = size; self.mtime = mtime; self.fileID = fileID
        if isDirectory { children = nil }
    }

    /// Bucket key. Directories end in "/". The root is "".
    var key: String {
        var parts: [String] = []
        var n: CNode? = self
        while let c = n, c.parent != nil { parts.append(c.name); n = c.parent }
        let path = parts.reversed().joined(separator: "/")
        return isDirectory ? (path.isEmpty ? "" : path + "/") : path
    }

    var cacheIdentity: String { ChunkReader.identity(key: key, size: size, mtime: mtime) }
}

/// Owns the node graph. All mutation happens under `lock`; network calls happen outside it.
final class Tree: @unchecked Sendable {
    let root: CNode
    private let lock = NSLock()
    private var nextID: UInt64 = 3
    private var byID: [UInt64: CNode] = [:]

    init() {
        root = CNode(id: .rootDirectory, name: "", parent: nil, isDirectory: true, size: 0, mtime: Date(), fileID: nil)
        byID[FSItem.Identifier.rootDirectory.rawValue] = root
    }

    func withLock<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }

    func newID() -> FSItem.Identifier { lock.lock(); defer { lock.unlock() }; defer { nextID += 1 }; return FSItem.Identifier(rawValue: nextID)! }

    func register(_ n: CNode) { withLock { byID[n.id.rawValue] = n } }
    func forget(_ n: CNode) { withLock { byID[n.id.rawValue] = nil } }

    // Variants for callers that already hold the lock (NSLock is not re-entrant).
    func newIDUnlocked() -> FSItem.Identifier { defer { nextID += 1 }; return FSItem.Identifier(rawValue: nextID)! }
    func registerUnlocked(_ n: CNode) { byID[n.id.rawValue] = n }
    func forgetUnlocked(_ n: CNode) { byID[n.id.rawValue] = nil }
}
