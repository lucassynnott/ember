import Foundation

/// Settings shared between the menu bar app and the FSKit extension, via the app-group container.
public struct SharedConfig: Codable, Sendable {
    public var provider: StorageProvider = .b2
    /// Backblaze: Key ID. S3-compatible: Access Key ID.
    public var keyID: String
    /// Backblaze: Application Key. S3-compatible: Secret Access Key.
    public var applicationKey: String
    public var bucketName: String
    public var bucketID: String?
    /// Cloudflare R2 account ID.
    public var accountID: String = ""
    /// S3 region (e.g. us-east-1, eu-central-1). Ignored for B2 and R2.
    public var region: String = ""
    /// Full endpoint URL, for "other S3-compatible" providers.
    public var endpoint: String = ""
    public var volumeName: String = "Ember Drive"
    public var cacheLimitGB: Int = 20
    public var uid: UInt32 = getuid()
    public var gid: UInt32 = getgid()

    public var cacheLimitBytes: Int64 { Int64(cacheLimitGB) * 1024 * 1024 * 1024 }
    public var credentials: B2Credentials { B2Credentials(keyID: keyID, applicationKey: applicationKey, bucketName: bucketName, bucketID: bucketID) }

    public init(provider: StorageProvider = .b2, keyID: String, applicationKey: String, bucketName: String, bucketID: String? = nil) {
        self.provider = provider; self.keyID = keyID; self.applicationKey = applicationKey; self.bucketName = bucketName; self.bucketID = bucketID
    }

    // Tolerant decoding so config files written by older builds (Backblaze-only) keep working.
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        provider = try c.decodeIfPresent(StorageProvider.self, forKey: .provider) ?? .b2
        keyID = try c.decode(String.self, forKey: .keyID)
        applicationKey = try c.decode(String.self, forKey: .applicationKey)
        bucketName = try c.decode(String.self, forKey: .bucketName)
        bucketID = try c.decodeIfPresent(String.self, forKey: .bucketID)
        accountID = try c.decodeIfPresent(String.self, forKey: .accountID) ?? ""
        region = try c.decodeIfPresent(String.self, forKey: .region) ?? ""
        endpoint = try c.decodeIfPresent(String.self, forKey: .endpoint) ?? ""
        volumeName = try c.decodeIfPresent(String.self, forKey: .volumeName) ?? "Ember Drive"
        cacheLimitGB = try c.decodeIfPresent(Int.self, forKey: .cacheLimitGB) ?? 20
        uid = try c.decodeIfPresent(UInt32.self, forKey: .uid) ?? getuid()
        gid = try c.decodeIfPresent(UInt32.self, forKey: .gid) ?? getgid()
    }

    /// Why this configuration can't be used yet, or nil if it's complete.
    public var validationProblem: String? {
        let t = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if t(keyID) { return provider == .b2 ? "Enter your Key ID." : "Enter your Access Key ID." }
        if t(applicationKey) { return provider == .b2 ? "Enter your Application Key." : "Enter your Secret Access Key." }
        if t(bucketName) { return "Enter the bucket name." }
        switch provider {
        case .r2: if t(accountID) { return "Enter your Cloudflare Account ID." }
        case .s3, .wasabi: if t(region) { return "Choose a region." }
        case .custom:
            if t(endpoint) { return "Enter the endpoint URL." }
            if URL(string: endpoint)?.host == nil { return "The endpoint should look like https://s3.example.com" }
        case .b2: break
        }
        return nil
    }

    /// The S3 endpoint for this provider, when it uses the S3 protocol.
    public var s3Config: S3Config? {
        let key = keyID.trimmingCharacters(in: .whitespaces), secret = applicationKey.trimmingCharacters(in: .whitespaces)
        let bucket = bucketName.trimmingCharacters(in: .whitespaces), rgn = region.trimmingCharacters(in: .whitespaces)
        let url: URL?, signRegion: String
        switch provider {
        case .b2: return nil
        case .r2: url = URL(string: "https://\(accountID.trimmingCharacters(in: .whitespaces)).r2.cloudflarestorage.com"); signRegion = "auto"
        case .s3: url = URL(string: "https://s3.\(rgn).amazonaws.com"); signRegion = rgn
        case .wasabi: url = URL(string: "https://s3.\(rgn).wasabisys.com"); signRegion = rgn
        case .custom:
            var e = endpoint.trimmingCharacters(in: .whitespaces)
            if !e.contains("://") { e = "https://" + e }
            url = URL(string: e); signRegion = rgn.isEmpty ? "us-east-1" : rgn
        }
        guard let url else { return nil }
        return S3Config(endpoint: url, region: signRegion, accessKey: key, secretKey: secret, bucket: bucket)
    }

    /// Builds the storage client for the configured provider.
    public func makeStore() -> any ObjectStore {
        if let s3 = s3Config { return S3Client(config: s3) }
        return B2Client(credentials: B2Credentials(keyID: keyID.trimmingCharacters(in: .whitespaces), applicationKey: applicationKey.trimmingCharacters(in: .whitespaces),
                                                   bucketName: bucketName.trimmingCharacters(in: .whitespaces), bucketID: bucketID))
    }
}

public struct SharedPaths: Sendable {
    public static let appGroup = "9785XZK34L.com.local.meetingnotes.drive"
    /// Ghost (the standalone app Ember Drive replaces): its settings are brought across once.
    public static let legacyAppGroup = "9785XZK34L.com.lucassynnott.ghost"
    public let root: URL
    public var config: URL { root.appendingPathComponent("config.json") }
    public var chunkCache: URL { root.appendingPathComponent("chunks", isDirectory: true) }
    public var staging: URL { root.appendingPathComponent("staging", isDirectory: true) }
    public var uploadJournal: URL { root.appendingPathComponent("uploads.json") }
    public var statusFile: URL { root.appendingPathComponent("status.json") }
    public var pinned: URL { root.appendingPathComponent("pinned", isDirectory: true) }          // "Keep on this Mac" chunks
    public var pins: URL { root.appendingPathComponent("pins.json") }                           // pinned folder keys
    public var listings: URL { root.appendingPathComponent("listings.json") }                   // offline directory cache

    public init(root: URL) { self.root = root }

    public static func appGroupPaths() -> SharedPaths? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup).map(SharedPaths.init)
    }

    public func loadConfig() -> SharedConfig? {
        (try? Data(contentsOf: config)).flatMap { try? JSONDecoder().decode(SharedConfig.self, from: $0) }
    }

    public func save(_ c: SharedConfig) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(c).write(to: config, options: [.atomic, .completeFileProtection])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
    }
}


/// A heads-up from the file system extension to the menu bar app (e.g. the provider is throttling downloads).
public struct DriveNotice: Codable, Sendable {
    public var message: String
    public var actionTitle: String?
    public var actionURL: String?
    public var date: Date

    public init(message: String, actionTitle: String? = nil, actionURL: String? = nil, date: Date = Date()) {
        self.message = message; self.actionTitle = actionTitle; self.actionURL = actionURL; self.date = date
    }
}

public extension SharedPaths {
    var noticeFile: URL { root.appendingPathComponent("notice.json") }

    func writeNotice(_ n: DriveNotice) {
        // Don't rewrite more than once every 30s (reads can fail in bursts).
        if let old = readNotice(maxAge: 30), old.message == n.message { return }
        try? JSONEncoder().encode(n).write(to: noticeFile, options: .atomic)
    }

    func readNotice(maxAge: TimeInterval = 15 * 60) -> DriveNotice? {
        guard let d = try? Data(contentsOf: noticeFile), let n = try? JSONDecoder().decode(DriveNotice.self, from: d),
              Date().timeIntervalSince(n.date) < maxAge else { return nil }
        return n
    }

    func clearNotice() { try? FileManager.default.removeItem(at: noticeFile) }
}
