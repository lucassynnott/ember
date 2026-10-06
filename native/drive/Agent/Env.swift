import Foundation
import DriveCore

/// Shared storage access for the helper's own features (search, share links, offline pinning). The file system
/// extension has its own client; both read the same config and share the chunk and pinned stores in the app group.
final class Env: @unchecked Sendable {
    static let shared = Env()
    let paths = SharedPaths.appGroupPaths()
    private var _client: (any ObjectStore)?
    private var _reader: ChunkReader?
    private let lock = NSLock()

    var config: SharedConfig? { paths?.loadConfig() }

    var client: (any ObjectStore)? {
        lock.lock(); defer { lock.unlock() }
        if _client == nil, let c = config { _client = c.makeStore() }
        return _client
    }

    /// Drops cached clients after the storage settings change.
    func reset() { lock.lock(); _client = nil; _reader = nil; lock.unlock() }

    var reader: ChunkReader? {
        lock.lock(); defer { lock.unlock() }
        if _reader == nil, let p = paths, let c = config, let cl = _client ?? { _client = c.makeStore(); return _client }() {
            _reader = ChunkReader(client: cl, cacheDir: p.chunkCache, pinnedDir: p.pinned, maxCacheBytes: c.cacheLimitBytes, readAhead: 0)
        }
        return _reader
    }

    /// The drive's key for a path on the mounted volume, or nil if it isn't on the drive. Folders end in "/".
    static func key(forPath path: String) -> String? {
        for root in [MountPointSetup.volumesURL.path, MountPointSetup.homeURL.path] {
            if path == root { return "" }
            if path.hasPrefix(root + "/") {
                var k = String(path.dropFirst(root.count + 1))
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue, !k.hasSuffix("/") { k += "/" }
                return k
            }
        }
        return nil
    }
}
