import Foundation

/// Name of the zero-byte marker that keeps an otherwise-empty folder alive in flat object storage.
public let ghostKeepName = ".ghost-keep"
/// Prefix where soft-deleted files are parked on providers without native "hide" (everything except Backblaze).
public let ghostTrashPrefix = ".ghost-trash/"

/// What Ember Drive needs from a storage provider. Backblaze B2 (native API) and every S3-compatible service implement it,
/// so the file system, cache and upload queue never care which one is behind the drive.
public protocol ObjectStore: Sendable {
    /// Pre-opens connections so the first real read doesn't pay for DNS + TLS.
    func warmUp(connections: Int) async
    /// One directory level. `prefix` is "" or ends in "/".
    func list(prefix: String) async throws -> [RemoteObject]
    /// Everything under `prefix`, recursively (includes keep markers).
    func listAll(prefix: String) async throws -> [RemoteObject]
    func stat(key: String) async throws -> RemoteObject?
    /// Reads a byte range. With `fileID`, reads that exact stored version so edits start from a consistent snapshot.
    func read(key: String, offset: Int64, length: Int, fileID: String?) async throws -> Data
    func upload(file: URL, as key: String, mtime: Date?, progress: (@Sendable (Int64) -> Void)?) async throws
    func putEmpty(key: String) async throws
    /// Soft delete. The object is recoverable until the trash lifecycle rule purges it.
    func hide(key: String) async throws
    /// Permanently removes one stored version.
    func deleteVersion(key: String, fileID: String) async throws
    /// Server-side copy (used for rename).
    func copy(from: RemoteObject, to key: String) async throws
    /// A time-limited download link for one file.
    func shareURL(key: String, validFor seconds: Int) async throws -> URL
    /// Makes trashed files expire after `days`.
    func configureTrashLifecycle(days: Int) async throws
    /// Longest link validity this provider allows.
    var maxShareSeconds: Int { get }
    /// Permanently removes trashed files older than `days`. Providers with a server-side lifecycle rule (Backblaze) return 0.
    /// This lets trash expire even when the key isn't allowed to change bucket settings.
    func purgeTrash(olderThanDays days: Int) async throws -> Int
}

public extension ObjectStore {
    func purgeTrash(olderThanDays days: Int) async throws -> Int { 0 }
    func warmUp() async { await warmUp(connections: 6) }
    func read(key: String, offset: Int64, length: Int) async throws -> Data { try await read(key: key, offset: offset, length: length, fileID: nil) }
    func upload(file: URL, as key: String) async throws { try await upload(file: file, as: key, mtime: nil, progress: nil) }
    func shareURL(key: String) async throws -> URL { try await shareURL(key: key, validFor: maxShareSeconds) }
}

/// A storage provider the user can pick in Settings.
public enum StorageProvider: String, Codable, CaseIterable, Sendable, Identifiable {
    case b2, r2, s3, wasabi, custom
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .b2: return "Backblaze B2"
        case .r2: return "Cloudflare R2"
        case .s3: return "Amazon S3"
        case .wasabi: return "Wasabi"
        case .custom: return "Other S3-compatible"
        }
    }

    public var tagline: String {
        switch self {
        case .b2: return "Cheapest option. About $7/TB per month, with generous free downloads."
        case .r2: return "Free downloads, any amount. About $15/TB per month."
        case .s3: return "The original. About $23/TB per month, plus charges for downloads."
        case .wasabi: return "Flat pricing, about $8/TB per month. Deleted files bill for 90 days."
        case .custom: return "Hetzner, MinIO, DigitalOcean Spaces, or anything that speaks the S3 API."
        }
    }
}
