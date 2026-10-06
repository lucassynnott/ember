import Foundation
import FSKit
import DriveCore
import os

private let log = Logger(subsystem: "com.local.meetingnotes.drive.fs", category: "volume")

/// The mounted volume. Reads stream from Backblaze in cached 4 MB chunks; writes land in a local staging file and
/// upload in the background, so Finder and pro apps never wait on the network.
final class DriveVolume: FSVolume, FSVolume.Operations, FSVolume.OpenCloseOperations, FSVolume.ReadWriteOperations, FSVolume.XattrOperations {
    let tree = Tree()
    let client: any ObjectStore
    let reader: ChunkReader
    let uploads: UploadQueue
    let listingCache: ListingCache
    let stagingDir: URL
    let paths: SharedPaths
    let providerIsB2: Bool
    let uid: UInt32
    let gid: UInt32
    private let listTTL: TimeInterval = 20

    init(config: SharedConfig, paths: SharedPaths) {
        client = config.makeStore()
        reader = ChunkReader(client: client, cacheDir: paths.chunkCache, pinnedDir: paths.pinned, maxCacheBytes: config.cacheLimitBytes)
        listingCache = ListingCache(file: paths.listings)
        uploads = UploadQueue(client: client, journal: paths.uploadJournal)
        stagingDir = paths.staging
        self.paths = paths; providerIsB2 = config.provider == .b2 || config.endpoint.contains("backblazeb2")
        uid = config.uid; gid = config.gid
        try? FileManager.default.createDirectory(at: stagingDir, withIntermediateDirectories: true)
        super.init(volumeID: FSVolume.Identifier(uuid: UUID(uuidString: "8F2F20E1-AD41-4630-8A5C-B9718866F047")!),
                   volumeName: FSFileName(string: config.volumeName))
    }

    // MARK: Capabilities / statistics

    var supportedVolumeCapabilities: FSVolume.SupportedCapabilities {
        let c = FSVolume.SupportedCapabilities()
        c.supportsPersistentObjectIDs = true
        c.supportsSymbolicLinks = false
        c.supportsHardLinks = false
        c.supportsSparseFiles = false
        c.supports64BitObjectIDs = true
        c.supports2TBFiles = true
        c.doesNotSupportImmutableFiles = true
        c.doesNotSupportSettingFilePermissions = true
        c.doesNotSupportRootTimes = true
        c.caseFormat = .insensitiveCasePreserving
        return c
    }

    var volumeStatistics: FSStatFSResult {
        let s = FSStatFSResult(fileSystemTypeName: "emberdrive")
        let block: UInt64 = 4096
        let total: UInt64 = 1 << 50                // present as effectively unlimited; the cloud is the limit
        s.blockSize = Int(block); s.ioSize = 1 << 20
        s.totalBytes = total; s.freeBytes = total - (1 << 30); s.availableBytes = s.freeBytes; s.usedBytes = 1 << 30
        s.totalBlocks = total / block; s.freeBlocks = s.freeBytes / block; s.availableBlocks = s.freeBlocks; s.usedBlocks = s.usedBytes / block
        s.totalFiles = 1 << 32; s.freeFiles = 1 << 31
        return s
    }

    var maximumLinkCount: Int { 1 }
    var maximumNameLength: Int { 255 }
    var restrictsOwnershipChanges: Bool { true }
    var truncatesLongNames: Bool { false }
    var maximumFileSize: UInt64 { 5 * 1024 * 1024 * 1024 * 1024 }

    // MARK: Lifecycle

    func mount(options: FSTaskOptions) async throws {
        Task { await client.warmUp() }
        Task { await uploads.setOnUploaded { [weak self] key, staged in self?.uploadFinished(key: key, staged: staged) } ; await uploads.resume() }
    }
    func unmount() async {}
    func synchronize(flags: FSSyncFlags) async throws { /* data is durable in staging; uploads continue in background */ }

    func activate(options: FSTaskOptions) async throws -> FSItem {
        // Serve our icon as /.VolumeIcon.icns; the root's FinderInfo (below) flags it as a custom icon, so Finder shows
        // the ghost for the volume in the sidebar and on the desktop.
        if let icon = Bundle.main.url(forResource: "VolumeIcon", withExtension: "icns") {
            let size = ((try? FileManager.default.attributesOfItem(atPath: icon.path)[.size]) as? NSNumber)?.int64Value ?? 0
            tree.withLock {
                let n = CNode(id: tree.newIDUnlocked(), name: ".VolumeIcon.icns", parent: tree.root, isDirectory: false,
                              size: size, mtime: Date(), fileID: nil)
                n.staged = icon; n.virtual = true
                tree.registerUnlocked(n)
                tree.root.children = [n.name: n]
                tree.root.listedAt = .distantPast
            }
        }
        return tree.root
    }
    func deactivate(options: FSDeactivateOptions) async throws {}
    func reclaimItem(_ item: FSItem) async throws {
        if let n = item as? CNode, n.staged == nil { tree.forget(n) }
    }

    // MARK: Listing / tree sync

    private func ensureListed(_ dir: CNode, force: Bool = false) async throws {
        let fresh = tree.withLock { dir.children != nil && Date().timeIntervalSince(dir.listedAt) < listTTL }
        if fresh && !force { return }
        let objects: [RemoteObject]
        do {
            objects = try await client.list(prefix: dir.key)
            listingCache.put(prefix: dir.key, objects: objects)
        } catch {
            // Offline (or B2 hiccup): serve the last known listing so the drive still browses and pinned files still open.
            guard let cached = listingCache.get(prefix: dir.key) else { throw error }
            objects = cached
            tree.withLock { dir.listedAt = Date().addingTimeInterval(-listTTL + 5) }     // retry soon
        }
        tree.withLock {
            var existing = dir.children ?? [:]
            var seen = Set<String>()
            for o in objects {
                let name = String(o.name.dropFirst(dir.key.count)).trimmingSlash()
                guard !name.isEmpty, !Self.isLocalOnly(name) else { continue }   // never surface sidecar junk
                seen.insert(name)
                let isDir = o.kind == .folder
                if let n = existing[name], n.isDirectory == isDir {
                    if n.staged == nil {                       // don't clobber local, not-yet-uploaded state
                        n.size = o.size; n.mtime = o.modified.timeIntervalSince1970 > 0 ? o.modified : n.mtime; n.fileID = o.fileID
                    }
                } else {
                    let n = CNode(id: tree.newIDUnlocked(), name: name, parent: dir, isDirectory: isDir, size: o.size,
                                  mtime: o.modified.timeIntervalSince1970 > 0 ? o.modified : dir.mtime, fileID: o.fileID)
                    tree.registerUnlocked(n)
                    existing[name] = n
                }
            }
            for (name, n) in existing where !seen.contains(name) && n.staged == nil && !(n.isDirectory && n.children != nil && n.dirty) {
                existing[name] = nil; tree.forgetUnlocked(n)
            }
            dir.children = existing
            dir.listedAt = Date()
        }
    }

    private func node(_ item: FSItem) throws -> CNode {
        guard let n = item as? CNode else { throw posix(.EINVAL) }
        return n
    }
    private func posix(_ code: POSIXErrorCode) -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(code.rawValue)) }

    func lookupItem(named name: FSFileName, inDirectory directory: FSItem) async throws -> (FSItem, FSFileName) {
        let dir = try node(directory)
        guard let s = name.string else { throw posix(.EINVAL) }
        try await ensureListed(dir)
        guard let n = tree.withLock({ dir.children?[s] }) else { throw posix(.ENOENT) }
        return (n, name)
    }

    func attributes(_ desired: FSItem.GetAttributesRequest, of item: FSItem) async throws -> FSItem.Attributes {
        attrs(try node(item))
    }

    private func attrs(_ n: CNode) -> FSItem.Attributes {
        let a = FSItem.Attributes()
        a.type = n.isDirectory ? .directory : .file
        a.mode = n.virtual ? 0o444 : (n.isDirectory ? 0o755 : 0o644)
        a.linkCount = n.isDirectory ? 2 : 1
        a.uid = uid; a.gid = gid
        a.supportsLimitedXAttrs = true
        a.size = n.isDirectory ? 0 : UInt64(max(n.size, 0))
        a.allocSize = n.isDirectory ? 0 : UInt64(((max(n.size, 0) + 4095) / 4096) * 4096)
        a.fileID = n.id
        a.parentID = n.parent?.id ?? .parentOfRoot
        let t = timespec(tv_sec: Int(n.mtime.timeIntervalSince1970), tv_nsec: 0)
        a.modifyTime = t; a.changeTime = t; a.birthTime = t; a.accessTime = t; a.addedTime = t
        return a
    }

    func enumerateDirectory(_ directory: FSItem, startingAt cookie: FSDirectoryCookie, verifier: FSDirectoryVerifier,
                            attributes: FSItem.GetAttributesRequest?, packer: FSDirectoryEntryPacker) async throws -> FSDirectoryVerifier {
        let dir = try node(directory)
        try await ensureListed(dir, force: cookie == .initial)
        let (entries, version) = tree.withLock { () -> ([CNode], UInt64) in
            (dir.children.map { Array($0.values).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } } ?? [],
             UInt64(dir.listedAt.timeIntervalSince1970 * 1000) | 1)
        }
        // FSKit synthesises "." and ".."; we only pack real entries. Cookie n+1 resumes after entries[n].
        var i = Int(cookie.rawValue)
        while i < entries.count {
            let n = entries[i]
            let ok = packer.packEntry(name: FSFileName(string: n.name), itemType: n.isDirectory ? .directory : .file, itemID: n.id,
                                      nextCookie: FSDirectoryCookie(rawValue: UInt64(i + 1)), attributes: attributes == nil ? nil : attrs(n))
            if !ok { break }
            i += 1
        }
        return FSDirectoryVerifier(rawValue: version)
    }

    func readSymbolicLink(_ item: FSItem) async throws -> FSFileName { throw posix(.EINVAL) }

    // MARK: Create / remove / rename

    func createItem(named name: FSFileName, type: FSItem.ItemType, inDirectory directory: FSItem,
                    attributes newAttributes: FSItem.SetAttributesRequest) async throws -> (FSItem, FSFileName) {
        let dir = try node(directory)
        guard let s = name.string else { throw posix(.EINVAL) }
        try await ensureListed(dir)
        if tree.withLock({ dir.children?[s] }) != nil { throw posix(.EEXIST) }
        switch type {
        case .directory:
            let n = CNode(id: tree.newID(), name: s, parent: dir, isDirectory: true, size: 0, mtime: Date(), fileID: nil)
            n.children = [:]; n.listedAt = Date(); n.dirty = true
            tree.register(n)
            tree.withLock { dir.children?[s] = n; dir.mtime = Date() }
            try await client.putEmpty(key: n.key + B2Client.keepName)       // so empty folders persist
            tree.withLock { n.dirty = false }
            return (n, name)
        case .file:
            let n = CNode(id: tree.newID(), name: s, parent: dir, isDirectory: false, size: 0, mtime: Date(), fileID: nil)
            let url = stagingDir.appendingPathComponent(UUID().uuidString)
            FileManager.default.createFile(atPath: url.path, contents: nil)
            tree.withLock { n.staged = url; n.dirty = true; dir.children?[s] = n; dir.mtime = Date() }
            tree.register(n)
            return (n, name)
        default:
            throw posix(.ENOTSUP)
        }
    }

    func createSymbolicLink(named name: FSFileName, inDirectory directory: FSItem, attributes newAttributes: FSItem.SetAttributesRequest,
                            linkContents contents: FSFileName) async throws -> (FSItem, FSFileName) { throw posix(.ENOTSUP) }
    func createLink(to item: FSItem, named name: FSFileName, inDirectory directory: FSItem) async throws -> FSFileName { throw posix(.ENOTSUP) }

    func removeItem(_ item: FSItem, named name: FSFileName, fromDirectory directory: FSItem) async throws {
        let n = try node(item), dir = try node(directory)
        if n.virtual { throw posix(.EPERM) }
        if n.isDirectory {
            try await ensureListed(n, force: true)
            if tree.withLock({ !(n.children ?? [:]).isEmpty }) { throw posix(.ENOTEMPTY) }
            if let marker = try await client.stat(key: n.key + B2Client.keepName) { try await client.hide(key: marker.name) }
        } else if Self.isLocalOnly(n.name) {
            if let s = tree.withLock({ n.staged }) { try? FileManager.default.removeItem(at: s) }
        } else {
            let key = n.key
            await uploads.waitUntilUploaded(key: key)             // let any in-flight upload settle so we hide the final version
            if try await client.stat(key: key) != nil { try await client.hide(key: key) }   // hidden => 30-day trash
            if let s = tree.withLock({ n.staged }) { try? FileManager.default.removeItem(at: s) }
            await reader.invalidate(identity: n.cacheIdentity)
        }
        tree.withLock { dir.children?[n.name] = nil; dir.mtime = Date(); n.staged = nil; n.dirty = false }
    }

    func renameItem(_ item: FSItem, inDirectory sourceDirectory: FSItem, named sourceName: FSFileName, to destinationName: FSFileName,
                    inDirectory destinationDirectory: FSItem, overItem: FSItem?) async throws -> FSFileName {
        let n = try node(item), from = try node(sourceDirectory), to = try node(destinationDirectory)
        if n.virtual { throw posix(.EPERM) }
        guard let newName = destinationName.string else { throw posix(.EINVAL) }
        let oldKey = n.key
        let newKey = to.key + newName + (n.isDirectory ? "/" : "")
        if n.isDirectory {
            for o in try await client.listAll(prefix: oldKey) {
                try await client.copy(from: o, to: newKey + o.name.dropFirst(oldKey.count))
                try await client.hide(key: o.name)
            }
        } else if Self.isLocalOnly(n.name) || Self.isLocalOnly(newName) {
            // local-only sidecar: nothing in the cloud to move
        } else {
            flushIfDirty(n)                                   // make sure pending data is queued under the OLD key…
            await uploads.waitUntilUploaded(key: oldKey)      // …and has landed, then move it server-side
            if let obj = try await client.stat(key: oldKey) {
                try await client.copy(from: obj, to: newKey)
                try await client.hide(key: oldKey)
            }
        }
        if let over = overItem as? CNode, !over.isDirectory { tree.withLock { over.staged = nil } }
        tree.withLock {
            from.children?[n.name] = nil
            n.name = newName; n.parent = to
            to.children?[newName] = n
            if n.isDirectory { n.children = nil; n.listedAt = .distantPast }
            from.mtime = Date(); to.mtime = Date()
        }
        return destinationName
    }

    // MARK: Attributes (truncate / times)

    func setAttributes(_ newAttributes: FSItem.SetAttributesRequest, on item: FSItem) async throws -> FSItem.Attributes {
        let n = try node(item)
        if n.virtual { throw posix(.EPERM) }
        if newAttributes.isValid(.size), !n.isDirectory {
            let newSize = Int64(newAttributes.size)
            let url = try await ensureStaged(n, truncating: newSize == 0)
            let fd = open(url.path, O_WRONLY)
            guard fd >= 0 else { throw posix(.EIO) }
            defer { close(fd) }
            ftruncate(fd, off_t(newSize))
            tree.withLock { n.size = newSize; n.dirty = true; n.mtime = Date() }
            newAttributes.consumedAttributes.insert(.size)
        }
        if newAttributes.isValid(.modifyTime) {
            let t = newAttributes.modifyTime
            tree.withLock { n.mtime = Date(timeIntervalSince1970: TimeInterval(t.tv_sec)) }
            newAttributes.consumedAttributes.insert(.modifyTime)
        }
        for a: FSItem.Attribute in [.mode, .uid, .gid, .flags, .accessTime, .birthTime, .addedTime, .backupTime, .changeTime] where newAttributes.isValid(a) {
            newAttributes.consumedAttributes.insert(a)       // accepted and ignored
        }
        return attrs(n)
    }

    // MARK: Open / close (flush trigger)

    func openItem(_ item: FSItem, modes: FSVolume.OpenModes) async throws {}

    func closeItem(_ item: FSItem, modes: FSVolume.OpenModes) async throws {
        guard let n = item as? CNode, !n.isDirectory else { return }
        if !modes.contains(.write) { flushIfDirty(n) }
    }

    /// macOS metadata droppings that must never reach the cloud (AppleDouble sidecars, Finder/Spotlight state).
    static func isLocalOnly(_ name: String) -> Bool {
        name.hasPrefix("._") || [".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".localized"].contains(name)
    }

    private func flushIfDirty(_ n: CNode) {
        let job: (String, URL, String?)? = tree.withLock {
            guard n.dirty, let s = n.staged else { return nil }
            if Self.isLocalOnly(n.name) { n.dirty = false; return nil }
            n.dirty = false
            return (n.key, s, n.baseFileID)
        }
        if let (key, url, base) = job { Task { await uploads.enqueue(key: key, staged: url, baseFileID: base) } }
    }

    /// Called by the upload queue when a file is safely in the cloud.
    private func uploadFinished(key: String, staged: URL) {
        // Keep the staged file if the node was modified again meanwhile; otherwise drop it (reads go to the chunk cache).
        // (Node lookup by key is cheap enough here; uploads are infrequent relative to reads.)
        Task {
            if let obj = try? await client.stat(key: key) {
                tree.withLock {
                    if let n = findNode(key: key), !n.dirty, n.staged == staged {
                        n.fileID = obj.fileID; n.baseFileID = obj.fileID; n.size = obj.size; n.mtime = obj.modified; n.staged = nil
                    }
                }
                if let n = tree.withLock({ findNode(key: key) }), tree.withLock({ n.staged }) == nil { try? FileManager.default.removeItem(at: staged) }
            }
        }
    }

    private func findNode(key: String) -> CNode? {
        var cur = tree.root
        for part in key.split(separator: "/") {
            guard let next = cur.children?[String(part)] else { return nil }
            cur = next
        }
        return cur
    }

    // MARK: Read / write

    func read(from item: FSItem, at offset: off_t, length: Int, into buffer: FSMutableFileDataBuffer) async throws -> Int {
        let n = try node(item)
        guard !n.isDirectory else { throw posix(.EISDIR) }
        let (size, staged, key, ident, fid) = tree.withLock { (n.size, n.staged, n.key, n.cacheIdentity, n.fileID) }
        let want = min(length, buffer.length)
        if let staged {
            let fd = open(staged.path, O_RDONLY)
            guard fd >= 0 else { throw posix(.EIO) }
            defer { close(fd) }
            return buffer.withUnsafeMutableBytes { raw in max(pread(fd, raw.baseAddress, want, offset), 0) }
        }
        guard Int64(offset) < size else { return 0 }
        do {
            let data = try await reader.read(key: key, identity: ident, size: size, offset: Int64(offset), length: want, fileID: fid)
            return buffer.withUnsafeMutableBytes { raw in data.copyBytes(to: raw, count: min(data.count, raw.count)); return min(data.count, raw.count) }
        } catch B2Error.notFound { throw posix(.ENOENT) }
        catch {
            log.error("read failed \(key): \(String(describing: error))")
            if StorageVerifier.isCapError(error) {
                paths.writeNotice(DriveNotice(
                    message: providerIsB2 ? "Backblaze has paused downloads: your daily download cap was reached."
                                          : "Your storage provider has paused downloads: a usage cap was reached.",
                    actionTitle: providerIsB2 ? "Raise the cap" : nil, actionURL: providerIsB2 ? "https://secure.backblaze.com/caps.htm" : nil))
            }
            throw posix(.EIO)
        }
    }

    func write(contents: Data, to item: FSItem, at offset: off_t) async throws -> Int {
        let n = try node(item)
        guard !n.isDirectory else { throw posix(.EISDIR) }
        if n.virtual { throw posix(.EPERM) }
        let url = try await ensureStaged(n, truncating: false)
        let fd = open(url.path, O_WRONLY)
        guard fd >= 0 else { throw posix(.EIO) }
        defer { close(fd) }
        let written = contents.withUnsafeBytes { pwrite(fd, $0.baseAddress, contents.count, offset) }
        guard written >= 0 else { throw posix(.EIO) }
        tree.withLock { n.size = max(n.size, Int64(offset) + Int64(written)); n.dirty = true; n.mtime = Date() }
        return written
    }

    /// Makes sure `n` has a local, writable copy. Existing remote files are downloaded once on first write.
    @discardableResult
    private func ensureStaged(_ n: CNode, truncating: Bool) async throws -> URL {
        if let s = tree.withLock({ n.staged }) { return s }
        let url = stagingDir.appendingPathComponent(UUID().uuidString)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let (size, key, ident, fid) = tree.withLock { (n.size, n.key, n.cacheIdentity, n.fileID) }
        tree.withLock { if n.staged == nil { n.baseFileID = n.fileID } }               // the version this edit starts from
        if !truncating, size > 0 {
            let fh = try FileHandle(forWritingTo: url)
            defer { try? fh.close() }
            var off: Int64 = 0
            while off < size {
                let d = try await reader.read(key: key, identity: ident, size: size, offset: off, length: ChunkReader.chunkSize, fileID: fid)
                if d.isEmpty { break }
                try fh.write(contentsOf: d)
                off += Int64(d.count)
            }
        }
        return tree.withLock {
            if let existing = n.staged { try? FileManager.default.removeItem(at: url); return existing }
            n.staged = url; return url
        }
    }
}

// MARK: Extended attributes

extension DriveVolume {
    static let finderInfoName = "com.apple.FinderInfo"

    /// 32-byte FinderInfo for the root with the "has custom icon" flag (0x0400 at bytes 8-9) set.
    private var rootFinderInfo: Data {
        var d = Data(count: 32); d[8] = 0x04; d[9] = 0x00; return d
    }

    @objc(supportedXattrNamesForItem:)
    func supportedXattrNames(for item: FSItem) -> [FSFileName] { [FSFileName(string: Self.finderInfoName)] }

    func xattr(named name: FSFileName, of item: FSItem) async throws -> Data {
        let n = try node(item)
        guard let key = name.string else { throw posix(.EINVAL) }
        if n === tree.root, key == Self.finderInfoName { return rootFinderInfo }
        if let v = tree.withLock({ n.xattrs[key] }) { return v }
        throw posix(.ENOATTR)
    }

    func setXattr(named name: FSFileName, to value: Data?, on item: FSItem, policy: FSVolume.SetXattrPolicy) async throws {
        let n = try node(item)
        guard let key = name.string else { throw posix(.EINVAL) }
        if n === tree.root { return }                                   // root metadata is fixed
        tree.withLock { if let v = value, policy != .delete { n.xattrs[key] = v } else { n.xattrs[key] = nil } }
    }

    func xattrs(of item: FSItem) async throws -> [FSFileName] {
        let n = try node(item)
        var names = tree.withLock { Array(n.xattrs.keys) }
        if n === tree.root, !names.contains(Self.finderInfoName) { names.append(Self.finderInfoName) }
        return names.map { FSFileName(string: $0) }
    }
}

private extension String {
    func trimmingSlash() -> String { hasSuffix("/") ? String(dropLast()) : self }
}
