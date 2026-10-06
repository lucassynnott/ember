import Foundation
import CryptoKit

public struct B2Credentials: Sendable, Codable {
    public var keyID: String
    public var applicationKey: String
    public var bucketName: String
    public var bucketID: String?

    public init(keyID: String, applicationKey: String, bucketName: String, bucketID: String? = nil) {
        self.keyID = keyID
        self.applicationKey = applicationKey
        self.bucketName = bucketName
        self.bucketID = bucketID
    }
}

public struct RemoteObject: Sendable, Equatable {
    public enum Kind: Sendable { case file, folder }
    public var name: String            // full key, folders end in "/"
    public var kind: Kind
    public var size: Int64
    public var modified: Date
    public var fileID: String?
}

public enum B2Error: Error, CustomStringConvertible {
    case http(status: Int, code: String, message: String)
    case notFound
    case badResponse(String)

    public var description: String {
        switch self {
        case .http(let s, let c, let m): return "B2 \(s) \(c): \(m)"
        case .notFound: return "not found"
        case .badResponse(let m): return "bad response: \(m)"
        }
    }
}

/// Thin async client over the B2 native API. Re-authorises automatically when the token expires.
public actor B2Client: ObjectStore {
    private let creds: B2Credentials
    private let session: URLSession

    private var token = ""
    private var apiURL = ""
    private var downloadURL = ""
    private var accountID = ""
    private var bucketID = ""
    public nonisolated var maxShareSeconds: Int { 604_800 }
    public private(set) var recommendedPartSize: Int = 100 * 1024 * 1024
    private var authorizedAt = Date.distantPast

    public init(credentials: B2Credentials, session: URLSession? = nil) {
        self.creds = credentials
        if let session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 60
            cfg.timeoutIntervalForResource = 60 * 60
            cfg.httpMaximumConnectionsPerHost = 16
            cfg.waitsForConnectivity = false      // fail fast when offline instead of hanging apps
            self.session = URLSession(configuration: cfg)
        }
    }

    // MARK: Auth

    private func authorize() async throws {
        var req = URLRequest(url: URL(string: "https://api.backblazeb2.com/b2api/v3/b2_authorize_account")!)
        let basic = Data("\(creds.keyID):\(creds.applicationKey)".utf8).base64EncodedString()
        req.setValue("Basic \(basic)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await session.data(for: req)
        let json = try Self.decode(data, resp)
        guard let api = (json["apiInfo"] as? [String: Any])?["storageApi"] as? [String: Any],
              let tok = json["authorizationToken"] as? String,
              let apiUrl = api["apiUrl"] as? String,
              let dl = api["downloadUrl"] as? String,
              let acc = json["accountId"] as? String
        else { throw B2Error.badResponse("authorize") }
        token = tok; apiURL = apiUrl; downloadURL = dl; accountID = acc
        if let p = api["recommendedPartSize"] as? Int { recommendedPartSize = p }
        authorizedAt = Date()
        if let id = creds.bucketID ?? (api["bucketId"] as? String) {
            bucketID = id
        } else {
            bucketID = try await lookupBucketID()
        }
    }

    private func lookupBucketID() async throws -> String {
        let json = try await call("b2_list_buckets", ["accountId": accountID, "bucketName": creds.bucketName])
        guard let b = (json["buckets"] as? [[String: Any]])?.first, let id = b["bucketId"] as? String
        else { throw B2Error.badResponse("bucket \(creds.bucketName) not found") }
        return id
    }

    private func ensureAuth() async throws {
        if token.isEmpty || Date().timeIntervalSince(authorizedAt) > 20 * 3600 { try await authorize() }
    }

    // MARK: Plumbing

    private static func decode(_ data: Data, _ resp: URLResponse) throws -> [String: Any] {
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(status) else {
            throw B2Error.http(status: status, code: obj["code"] as? String ?? "", message: obj["message"] as? String ?? "")
        }
        return obj
    }

    private func call(_ op: String, _ makeBody: @autoclosure () -> [String: Any], retry: Bool = true) async throws -> [String: Any] {
        if op != "b2_list_buckets" || !token.isEmpty { try await ensureAuth() }
        let body = makeBody()
        var req = URLRequest(url: URL(string: "\(apiURL)/b2api/v3/\(op)")!)
        req.httpMethod = "POST"
        req.setValue(token, forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await session.data(for: req)
            return try Self.decode(data, resp)
        } catch B2Error.http(let status, let code, _) where retry && (status == 401 || code == "expired_auth_token") {
            token = ""
            return try await call(op, makeBody(), retry: false)
        }
    }

    private func urlFor(_ key: String) -> URL {
        var comps = URLComponents(string: "\(downloadURL)/file/\(creds.bucketName)/")!
        comps.percentEncodedPath += key.addingPercentEncoding(withAllowedCharacters: Self.pathAllowed) ?? key
        return comps.url!
    }

    private static let pathAllowed: CharacterSet = {
        var s = CharacterSet.urlPathAllowed
        s.remove(charactersIn: "?#&+;=")
        return s
    }()

    /// Authorises and opens `connections` parallel TLS connections to the download host, so the first real read
    /// doesn't pay for DNS + TLS handshakes. Call at mount time.
    public func warmUp(connections: Int = 6) async {
        do { try await ensureAuth() } catch { return }
        let url = URL(string: "\(downloadURL)/file/\(creds.bucketName)/.ghost-warm")!
        let tok = token, session = self.session
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<connections {
                group.addTask {
                    var r = URLRequest(url: url); r.httpMethod = "HEAD"
                    r.setValue(tok, forHTTPHeaderField: "Authorization")
                    _ = try? await session.data(for: r)
                }
            }
        }
    }

    // MARK: Listing

    /// Lists one directory level. `prefix` must be "" or end in "/".
    public func list(prefix: String) async throws -> [RemoteObject] {
        try await ensureAuth()
        var out: [RemoteObject] = []
        var start: String? = nil
        repeat {
            var body: [String: Any] = ["bucketId": bucketID, "prefix": prefix, "delimiter": "/", "maxFileCount": 10000]
            if let start { body["startFileName"] = start }
            let json = try await call("b2_list_file_names", body)
            for f in (json["files"] as? [[String: Any]]) ?? [] {
                guard let name = f["fileName"] as? String else { continue }
                let action = f["action"] as? String ?? "upload"
                if prefix.isEmpty, name == ghostTrashPrefix || name.hasPrefix(".ghost-check-") { continue }      // internal housekeeping
                if action == "folder" {
                    out.append(RemoteObject(name: name, kind: .folder, size: 0, modified: Date(timeIntervalSince1970: 0), fileID: nil))
                } else if name.hasSuffix("/") {
                    // explicit folder marker object
                    if name != prefix {
                        out.append(RemoteObject(name: name, kind: .folder, size: 0, modified: Self.date(f), fileID: f["fileId"] as? String))
                    }
                } else if name.hasSuffix(Self.keepName) {
                    continue
                } else {
                    out.append(RemoteObject(name: name, kind: .file, size: (f["contentLength"] as? NSNumber)?.int64Value ?? 0,
                                        modified: Self.date(f), fileID: f["fileId"] as? String))
                }
            }
            start = json["nextFileName"] as? String
        } while start != nil
        // de-dup folders (a marker object and an implicit prefix can both show up)
        var seen = Set<String>()
        return out.filter { seen.insert($0.name).inserted }
    }

    public static let keepName = ghostKeepName

    /// Lists everything under `prefix` recursively (no delimiter). Includes keep-markers, for directory rename/delete.
    public func listAll(prefix: String) async throws -> [RemoteObject] {
        try await ensureAuth()
        var out: [RemoteObject] = []
        var start: String? = nil
        repeat {
            var body: [String: Any] = ["bucketId": bucketID, "prefix": prefix, "maxFileCount": 10000]
            if let start { body["startFileName"] = start }
            let json = try await call("b2_list_file_names", body)
            for f in (json["files"] as? [[String: Any]]) ?? [] {
                guard let name = f["fileName"] as? String else { continue }
                out.append(RemoteObject(name: name, kind: name.hasSuffix("/") ? .folder : .file,
                                    size: (f["contentLength"] as? NSNumber)?.int64Value ?? 0, modified: Self.date(f), fileID: f["fileId"] as? String))
            }
            start = json["nextFileName"] as? String
        } while start != nil
        return out
    }

    private static func date(_ f: [String: Any]) -> Date {
        if let info = f["fileInfo"] as? [String: Any], let s = info["src_last_modified_millis"] as? String, let ms = Double(s) {
            return Date(timeIntervalSince1970: ms / 1000)
        }
        let ms = (f["uploadTimestamp"] as? NSNumber)?.doubleValue ?? 0
        return Date(timeIntervalSince1970: ms / 1000)
    }

    public func stat(key: String) async throws -> RemoteObject? {
        let json = try await call("b2_list_file_names", ["bucketId": bucketID, "prefix": key, "maxFileCount": 1])
        guard let f = (json["files"] as? [[String: Any]])?.first, f["fileName"] as? String == key else { return nil }
        return RemoteObject(name: key, kind: key.hasSuffix("/") ? .folder : .file,
                        size: (f["contentLength"] as? NSNumber)?.int64Value ?? 0, modified: Self.date(f), fileID: f["fileId"] as? String)
    }

    // MARK: Download

    /// Reads `length` bytes at `offset`. Returns fewer bytes at EOF.
    /// With `fileID`, reads that exact stored version (so edits are based on a consistent snapshot even if another Mac
    /// has since replaced the file); without it, reads the latest version by name.
    public func read(key: String, offset: Int64, length: Int, fileID: String? = nil) async throws -> Data {
        try await ensureAuth()
        for attempt in 0..<2 {
            var req = URLRequest(url: fileID.flatMap { URL(string: "\(downloadURL)/b2api/v3/b2_download_file_by_id?fileId=\($0)") } ?? urlFor(key))
            req.setValue(token, forHTTPHeaderField: "Authorization")
            req.setValue("bytes=\(offset)-\(offset + Int64(length) - 1)", forHTTPHeaderField: "Range")
            let (data, resp) = try await session.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200, 206: return data
            case 416: return Data()
            case 404: throw B2Error.notFound
            case 401 where attempt == 0: token = ""; try await ensureAuth()
            default:
                let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
                throw B2Error.http(status: status, code: obj["code"] as? String ?? "", message: obj["message"] as? String ?? "")
            }
        }
        throw B2Error.badResponse("read retry exhausted")
    }

    // MARK: Upload

    private func uploadHeaders(_ req: inout URLRequest, name: String, sha1: String, mtime: Date, contentType: String = "b2/x-auto") {
        req.setValue(name.addingPercentEncoding(withAllowedCharacters: Self.pathAllowed.subtracting(CharacterSet(charactersIn: "/"))
            .union(CharacterSet(charactersIn: "/"))), forHTTPHeaderField: "X-Bz-File-Name")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.setValue(sha1, forHTTPHeaderField: "X-Bz-Content-Sha1")
        req.setValue(String(Int64(mtime.timeIntervalSince1970 * 1000)), forHTTPHeaderField: "X-Bz-Info-src_last_modified_millis")
    }

    private static func sha1Hex(_ file: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: file)
        defer { try? h.close() }
        var hasher = Insecure.SHA1()
        while let chunk = try h.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Uploads a local file, choosing single-shot or multipart by size.
    public func upload(file: URL, as key: String, mtime: Date? = nil, progress: (@Sendable (Int64) -> Void)? = nil) async throws {
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let when = mtime ?? (attrs[.modificationDate] as? Date) ?? Date()
        if size <= 200 * 1024 * 1024 {
            try await uploadSmall(file: file, key: key, mtime: when)
            progress?(size)
        } else {
            try await uploadLarge(file: file, key: key, size: size, mtime: when, progress: progress)
        }
    }

    public func putEmpty(key: String) async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data().write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try await uploadSmall(file: tmp, key: key, mtime: Date())
    }

    private func uploadSmall(file: URL, key: String, mtime: Date) async throws {
        let sha = try Self.sha1Hex(file)
        var lastError: Error?
        for _ in 0..<5 {
            do {
                let u = try await call("b2_get_upload_url", ["bucketId": bucketID])
                guard let url = u["uploadUrl"] as? String, let tok = u["authorizationToken"] as? String
                else { throw B2Error.badResponse("upload url") }
                var req = URLRequest(url: URL(string: url)!)
                req.httpMethod = "POST"
                req.setValue(tok, forHTTPHeaderField: "Authorization")
                uploadHeaders(&req, name: key, sha1: sha, mtime: mtime)
                let (data, resp) = try await session.upload(for: req, fromFile: file)
                _ = try Self.decode(data, resp)
                return
            } catch { lastError = error; try await Task.sleep(for: .seconds(1)) }
        }
        throw lastError ?? B2Error.badResponse("upload failed")
    }

    private func uploadLarge(file: URL, key: String, size: Int64, mtime: Date, progress: (@Sendable (Int64) -> Void)?) async throws {
        let partSize = Int64(max(recommendedPartSize, 5 * 1024 * 1024))
        let start = try await call("b2_start_large_file", [
            "bucketId": bucketID, "fileName": key, "contentType": "b2/x-auto",
            "fileInfo": ["src_last_modified_millis": String(Int64(mtime.timeIntervalSince1970 * 1000))],
        ])
        guard let fileID = start["fileId"] as? String else { throw B2Error.badResponse("start large") }
        var shas: [String] = []
        var offset: Int64 = 0
        var partNo = 1
        let fh = try FileHandle(forReadingFrom: file)
        defer { try? fh.close() }
        while offset < size {
            let len = min(partSize, size - offset)
            try fh.seek(toOffset: UInt64(offset))
            let data = try fh.read(upToCount: Int(len)) ?? Data()
            let sha = Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
            var done = false
            var lastError: Error?
            for _ in 0..<5 where !done {
                do {
                    let u = try await call("b2_get_upload_part_url", ["fileId": fileID])
                    guard let url = u["uploadUrl"] as? String, let tok = u["authorizationToken"] as? String
                    else { throw B2Error.badResponse("part url") }
                    var req = URLRequest(url: URL(string: url)!)
                    req.httpMethod = "POST"
                    req.setValue(tok, forHTTPHeaderField: "Authorization")
                    req.setValue(String(partNo), forHTTPHeaderField: "X-Bz-Part-Number")
                    req.setValue(sha, forHTTPHeaderField: "X-Bz-Content-Sha1")
                    let (d, r) = try await session.upload(for: req, from: data)
                    _ = try Self.decode(d, r)
                    done = true
                } catch { lastError = error; try await Task.sleep(for: .seconds(1)) }
            }
            if !done { throw lastError ?? B2Error.badResponse("part failed") }
            shas.append(sha)
            offset += len; partNo += 1
            progress?(offset)
        }
        _ = try await call("b2_finish_large_file", ["fileId": fileID, "partSha1Array": shas])
    }

    // MARK: Sharing

    /// A time-limited download link for a single file in the private bucket (B2 caps validity at 7 days).
    public func shareURL(key: String, validFor seconds: Int = 7 * 24 * 3600) async throws -> URL {
        let json = try await call("b2_get_download_authorization", [
            "bucketId": bucketID, "fileNamePrefix": key, "validDurationInSeconds": min(max(seconds, 1), 604_800),
        ])
        guard let tok = json["authorizationToken"] as? String else { throw B2Error.badResponse("download authorization") }
        var comps = URLComponents(url: urlFor(key), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "Authorization", value: tok)]
        guard let url = comps.url else { throw B2Error.badResponse("share url") }
        return url
    }

    // MARK: Mutations

    /// Soft-delete: hides the file. A bucket lifecycle rule permanently removes hidden files after 30 days (the "trash").
    public func hide(key: String) async throws {
        _ = try await call("b2_hide_file", ["bucketId": bucketID, "fileName": key])
    }

    public func deleteVersion(key: String, fileID: String) async throws {
        _ = try await call("b2_delete_file_version", ["fileName": key, "fileId": fileID])
    }

    public func copy(from: RemoteObject, to key: String) async throws {
        guard let id = from.fileID else { throw B2Error.badResponse("copy: no fileId") }
        _ = try await call("b2_copy_file", ["sourceFileId": id, "fileName": key, "metadataDirective": "COPY"])
    }

    /// Trash retention: hidden files are deleted 30 days after hiding.
    public func configureTrashLifecycle(days: Int = 30) async throws {
        _ = try await call("b2_update_bucket", [
            "accountId": accountID, "bucketId": bucketID,
            "lifecycleRules": [["fileNamePrefix": "", "daysFromHidingToDeleting": days, "daysFromUploadingToHiding": NSNull()]],
        ])
    }
}
