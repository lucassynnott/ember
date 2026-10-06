import Foundation
import CryptoKit

public struct S3Config: Sendable, Codable, Equatable {
    public var endpoint: URL            // e.g. https://s3.us-east-005.backblazeb2.com
    public var region: String           // "auto" for R2
    public var accessKey: String
    public var secretKey: String
    public var bucket: String

    public init(endpoint: URL, region: String, accessKey: String, secretKey: String, bucket: String) {
        self.endpoint = endpoint; self.region = region; self.accessKey = accessKey; self.secretKey = secretKey; self.bucket = bucket
    }
}

/// S3-compatible object storage (Cloudflare R2, Amazon S3, Wasabi, Backblaze's S3 endpoint, MinIO, …) using
/// path-style addressing and AWS Signature V4.
public final class S3Client: ObjectStore, @unchecked Sendable {
    private let cfg: S3Config
    private let session: URLSession
    private static let emptyHash = SHA256.hash(data: Data()).hex
    // Overridable (GHOST_S3_PART_MB) so multipart can be exercised with small files in tests; parts must be >= 5 MB.
    private static let partSize: Int = (ProcessInfo.processInfo.environment["GHOST_S3_PART_MB"].flatMap { Int($0) } ?? 64) * 1024 * 1024
    private static let multipartThreshold: Int64 = ProcessInfo.processInfo.environment["GHOST_S3_PART_MB"] != nil ? Int64(partSize) : 100 * 1024 * 1024

    public var maxShareSeconds: Int { 604_800 }

    public init(config: S3Config, session: URLSession? = nil) {
        self.cfg = config
        if let session { self.session = session } else {
            let c = URLSessionConfiguration.default
            c.timeoutIntervalForRequest = 60; c.timeoutIntervalForResource = 60 * 60
            c.httpMaximumConnectionsPerHost = 16; c.waitsForConnectivity = false      // fail fast when offline instead of hanging apps
            self.session = URLSession(configuration: c)
        }
    }

    // MARK: SigV4

    /// RFC 3986 percent-encoding as AWS wants it: only unreserved characters stay literal.
    static func encode(_ s: String, keepSlash: Bool = false) -> String {
        var out = ""
        for b in s.utf8 {
            switch b {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: "~"):
                out.append(Character(UnicodeScalar(b)))
            case UInt8(ascii: "/") where keepSlash: out.append("/")
            default: out += String(format: "%%%02X", b)
            }
        }
        return out
    }

    static func hmac(_ key: Data, _ msg: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(msg.utf8), using: SymmetricKey(data: key)))
    }

    static func amzDate(_ d: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"; return f.string(from: d)
    }

    struct Signature { var authorization: String; var signature: String; var signedHeaders: String; var canonicalRequest: String }

    /// Computes the SigV4 signature. `headers` must include every header being signed (lower-cased names), including `host`.
    static func sign(method: String, path: String, query: [(String, String)], headers: [String: String], payloadHash: String,
                     date: Date, region: String, accessKey: String, secretKey: String) -> Signature {
        let stamp = amzDate(date), day = String(stamp.prefix(8))
        var pairs: [(String, String)] = []
        for (k, v) in query { pairs.append((encode(k), encode(v))) }
        pairs.sort { (a: (String, String), b: (String, String)) -> Bool in a.0 == b.0 ? a.1 < b.1 : a.0 < b.0 }
        let canonicalQuery: String = pairs.map { (pair: (String, String)) -> String in pair.0 + "=" + pair.1 }.joined(separator: "&")
        let names = headers.keys.sorted()
        let canonicalHeaders = names.map { "\($0):\(headers[$0]!.trimmingCharacters(in: .whitespaces))\n" }.joined()
        let signedHeaders = names.joined(separator: ";")
        let canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].joined(separator: "\n")
        let scope = "\(day)/\(region)/s3/aws4_request"
        let toSign = ["AWS4-HMAC-SHA256", stamp, scope, SHA256.hash(data: Data(canonical.utf8)).hex].joined(separator: "\n")
        let kDate = hmac(Data("AWS4\(secretKey)".utf8), day), kRegion = hmac(kDate, region), kService = hmac(kRegion, "s3")
        let kSigning = hmac(kService, "aws4_request")
        let sig = hmac(kSigning, toSign).hex
        return Signature(authorization: "AWS4-HMAC-SHA256 Credential=\(accessKey)/\(scope), SignedHeaders=\(signedHeaders), Signature=\(sig)",
                         signature: sig, signedHeaders: signedHeaders, canonicalRequest: canonical)
    }

    private var hostHeader: String {
        let h = cfg.endpoint.host ?? ""
        if let p = cfg.endpoint.port, p != 443 && p != 80 { return "\(h):\(p)" }
        return h
    }

    private var basePath: String { (cfg.endpoint.path.hasSuffix("/") ? String(cfg.endpoint.path.dropLast()) : cfg.endpoint.path) + "/" + Self.encode(cfg.bucket) }

    private func path(for key: String?) -> String {
        guard let key, !key.isEmpty else { return basePath }
        return basePath + "/" + Self.encode(key, keepSlash: true)
    }

    private func makeRequest(method: String, key: String?, query: [(String, String)] = [], extra: [String: String] = [:],
                             payloadHash: String? = nil) -> URLRequest {
        let p = path(for: key)
        let hash = payloadHash ?? Self.emptyHash
        let now = Date()
        var headers = extra.reduce(into: [String: String]()) { $0[$1.key.lowercased()] = $1.value }
        headers["host"] = hostHeader
        headers["x-amz-date"] = Self.amzDate(now)
        headers["x-amz-content-sha256"] = hash
        let sig = Self.sign(method: method, path: p, query: query, headers: headers, payloadHash: hash, date: now,
                            region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey)
        if ProcessInfo.processInfo.environment["GHOST_S3_DEBUG"] == "2" {
            FileHandle.standardError.write(Data("[s3 canonical]\n\(sig.canonicalRequest)\n[/s3 canonical]\n".utf8))
        }
        var comps = URLComponents()
        comps.scheme = cfg.endpoint.scheme; comps.host = cfg.endpoint.host; comps.port = cfg.endpoint.port
        comps.percentEncodedPath = p
        if !query.isEmpty { comps.percentEncodedQuery = query.map { "\(Self.encode($0.0))=\(Self.encode($0.1))" }.joined(separator: "&") }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        for (k, v) in headers where k != "host" { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue(sig.authorization, forHTTPHeaderField: "Authorization")
        return req
    }

    // MARK: Transport

    @discardableResult
    private func send(_ req: URLRequest, body: Data? = nil, file: URL? = nil, allow404: Bool = false) async throws -> (Data, HTTPURLResponse) {
        var lastError: Error?
        for attempt in 0..<4 {
            do {
                let (data, resp): (Data, URLResponse)
                if let file { (data, resp) = try await session.upload(for: req, fromFile: file) }
                else if let body { (data, resp) = try await session.upload(for: req, from: body) }
                else { (data, resp) = try await session.data(for: req) }
                let http = resp as! HTTPURLResponse
                if (200..<300).contains(http.statusCode) || (allow404 && http.statusCode == 404) { return (data, http) }
                let (code, msg) = Self.parseError(data)
                if ProcessInfo.processInfo.environment["GHOST_S3_DEBUG"] != nil {
                    FileHandle.standardError.write(Data("[s3 debug] \(req.httpMethod ?? "?") \(req.url?.absoluteString.prefix(200) ?? "") -> \(http.statusCode) \(code)\n".utf8))
                }
                if http.statusCode == 404 && !allow404 && (code == "NoSuchKey" || code.isEmpty) { throw B2Error.notFound }
                let err = B2Error.http(status: http.statusCode, code: code, message: msg)
                if http.statusCode >= 500 || http.statusCode == 429 { lastError = err; try await Task.sleep(for: .milliseconds(400 * (attempt + 1))); continue }
                throw err
            } catch let e as URLError where e.code != .cancelled {
                lastError = e; try await Task.sleep(for: .milliseconds(400 * (attempt + 1)))
            }
        }
        throw lastError ?? B2Error.badResponse("request failed")
    }

    static func parseError(_ data: Data) -> (String, String) {
        let s = String(decoding: data, as: UTF8.self)
        func tag(_ t: String) -> String { (s.range(of: "<\(t)>").flatMap { a in s.range(of: "</\(t)>").map { String(s[a.upperBound..<$0.lowerBound]) } }) ?? "" }
        return (tag("Code"), tag("Message"))
    }

    // MARK: Listing

    private final class ListParser: NSObject, XMLParserDelegate {
        var objects: [(key: String, size: Int64, modified: Date, etag: String)] = []
        var prefixes: [String] = []
        var truncated = false
        var nextToken: String?
        private var text = "", inContents = false, inCommon = false
        private var key = "", size: Int64 = 0, modified = Date(timeIntervalSince1970: 0), etag = ""
        private static let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
        private static let isoPlain = ISO8601DateFormatter()

        func parser(_ p: XMLParser, didStartElement e: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
            text = ""
            if e == "Contents" { inContents = true; key = ""; size = 0; etag = ""; modified = Date(timeIntervalSince1970: 0) }
            if e == "CommonPrefixes" { inCommon = true }
        }
        func parser(_ p: XMLParser, foundCharacters s: String) { text += s }
        func parser(_ p: XMLParser, didEndElement e: String, namespaceURI: String?, qualifiedName: String?) {
            switch e {
            case "Key" where inContents: key = text
            case "Size" where inContents: size = Int64(text) ?? 0
            case "LastModified" where inContents: modified = Self.iso.date(from: text) ?? Self.isoPlain.date(from: text) ?? modified
            case "ETag" where inContents: etag = text.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            case "Contents": objects.append((key, size, modified, etag)); inContents = false
            case "Prefix" where inCommon: prefixes.append(text)
            case "CommonPrefixes": inCommon = false
            case "IsTruncated": truncated = text == "true"
            case "NextContinuationToken": nextToken = text
            default: break
            }
        }
    }

    private func listPage(prefix: String, delimiter: Bool, token: String?) async throws -> ListParser {
        var q: [(String, String)] = [("list-type", "2"), ("max-keys", "1000")]
        if !prefix.isEmpty { q.append(("prefix", prefix)) }
        if delimiter { q.append(("delimiter", "/")) }
        if let token { q.append(("continuation-token", token)) }
        let (data, _) = try await send(makeRequest(method: "GET", key: nil, query: q))
        let parser = ListParser(); let x = XMLParser(data: data); x.delegate = parser
        guard x.parse() else { throw B2Error.badResponse("list xml") }
        return parser
    }

    public func list(prefix: String) async throws -> [RemoteObject] {
        var out: [RemoteObject] = []
        var token: String? = nil
        repeat {
            let page = try await listPage(prefix: prefix, delimiter: true, token: token)
            for p in page.prefixes where !(prefix.isEmpty && p == ghostTrashPrefix) {
                out.append(RemoteObject(name: p, kind: .folder, size: 0, modified: Date(timeIntervalSince1970: 0), fileID: nil))
            }
            for o in page.objects {
                if o.key == prefix { continue }
                if o.key.hasSuffix("/") { out.append(RemoteObject(name: o.key, kind: .folder, size: 0, modified: o.modified, fileID: o.etag)); continue }
                if o.key.hasSuffix(ghostKeepName) { continue }
                out.append(RemoteObject(name: o.key, kind: .file, size: o.size, modified: o.modified, fileID: o.etag))
            }
            token = page.truncated ? page.nextToken : nil
        } while token != nil
        var seen = Set<String>()
        return out.filter { seen.insert($0.name).inserted }
    }

    public func listAll(prefix: String) async throws -> [RemoteObject] {
        var out: [RemoteObject] = []
        var token: String? = nil
        repeat {
            let page = try await listPage(prefix: prefix, delimiter: false, token: token)
            for o in page.objects where !o.key.hasPrefix(ghostTrashPrefix) {
                out.append(RemoteObject(name: o.key, kind: o.key.hasSuffix("/") ? .folder : .file, size: o.size, modified: o.modified, fileID: o.etag))
            }
            token = page.truncated ? page.nextToken : nil
        } while token != nil
        return out
    }

    public func stat(key: String) async throws -> RemoteObject? {
        let (_, http) = try await send(makeRequest(method: "HEAD", key: key), allow404: true)
        if http.statusCode == 404 { return nil }
        let size = Int64(http.value(forHTTPHeaderField: "Content-Length") ?? "") ?? 0
        let etag = (http.value(forHTTPHeaderField: "ETag") ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        let modified = http.value(forHTTPHeaderField: "Last-Modified").flatMap { Self.httpDate($0) } ?? Date()
        return RemoteObject(name: key, kind: key.hasSuffix("/") ? .folder : .file, size: size, modified: modified, fileID: etag)
    }

    private static func httpDate(_ s: String) -> Date? {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"; return f.date(from: s)
    }

    // MARK: Reads

    public func warmUp(connections: Int) async {
        await withTaskGroup(of: Void.self) { g in
            for _ in 0..<connections { g.addTask { _ = try? await self.send(self.makeRequest(method: "HEAD", key: nil), allow404: true) } }
        }
    }

    public func read(key: String, offset: Int64, length: Int, fileID: String?) async throws -> Data {
        var extra = ["range": "bytes=\(offset)-\(offset + Int64(length) - 1)"]
        if let fileID, !fileID.isEmpty { extra["if-match"] = "\"\(fileID)\"" }          // pin to the version we know about
        do {
            let (data, _) = try await send(makeRequest(method: "GET", key: key, extra: extra))
            return data
        } catch B2Error.http(let status, _, _) where status == 416 { return Data() }
    }

    // MARK: Writes

    public func upload(file: URL, as key: String, mtime: Date?, progress: (@Sendable (Int64) -> Void)?) async throws {
        let size = ((try FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber)?.int64Value ?? 0
        if size <= Self.multipartThreshold {
            try await put(file: file, key: key)
            progress?(size)
        } else {
            try await multipart(file: file, key: key, size: size, progress: progress)
        }
    }

    private func put(file: URL, key: String) async throws {
        var req = makeRequest(method: "PUT", key: key, payloadHash: "UNSIGNED-PAYLOAD")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        try await send(req, file: file)
    }

    public func putEmpty(key: String) async throws {
        var req = makeRequest(method: "PUT", key: key, payloadHash: Self.emptyHash)
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        try await send(req, body: Data())
    }

    private func multipart(file: URL, key: String, size: Int64, progress: (@Sendable (Int64) -> Void)?) async throws {
        let (initData, _) = try await send(makeRequest(method: "POST", key: key, query: [("uploads", "")], payloadHash: Self.emptyHash), body: Data())
        let initXML = String(decoding: initData, as: UTF8.self)
        guard let a = initXML.range(of: "<UploadId>"), let b = initXML.range(of: "</UploadId>") else { throw B2Error.badResponse("upload id") }
        let uploadID = String(initXML[a.upperBound..<b.lowerBound])
        do {
            let fh = try FileHandle(forReadingFrom: file); defer { try? fh.close() }
            var etags: [String] = []
            var offset: Int64 = 0, partNo = 1
            while offset < size {
                try fh.seek(toOffset: UInt64(offset))
                let data = try fh.read(upToCount: Self.partSize) ?? Data()
                let req = makeRequest(method: "PUT", key: key, query: [("partNumber", String(partNo)), ("uploadId", uploadID)], payloadHash: "UNSIGNED-PAYLOAD")
                let (_, http) = try await send(req, body: data)
                etags.append((http.value(forHTTPHeaderField: "ETag") ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "\"")))
                offset += Int64(data.count); partNo += 1
                progress?(offset)
            }
            let xml = "<CompleteMultipartUpload>" + etags.enumerated().map { "<Part><PartNumber>\($0.offset + 1)</PartNumber><ETag>\"\($0.element)\"</ETag></Part>" }.joined() + "</CompleteMultipartUpload>"
            let body = Data(xml.utf8)
            // URLSession defaults POST bodies to form-urlencoded, which some servers parse as form fields; say it's XML.
            var done = makeRequest(method: "POST", key: key, query: [("uploadId", uploadID)], payloadHash: SHA256.hash(data: body).hex)
            done.setValue("application/xml", forHTTPHeaderField: "Content-Type")
            _ = try await send(done, body: body)
        } catch {
            _ = try? await send(makeRequest(method: "DELETE", key: key, query: [("uploadId", uploadID)]), allow404: true)   // don't leave orphan parts billing
            throw error
        }
    }

    // MARK: Delete / copy / trash

    public func hide(key: String) async throws {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd"; f.locale = Locale(identifier: "en_US_POSIX")
        // No lookup first: a copy of a missing key just 404s, and lookups can be throttled on some providers.
        do { try await copy(from: RemoteObject(name: key, kind: .file, size: 0, modified: Date(), fileID: nil), to: ghostTrashPrefix + f.string(from: Date()) + "/" + key) }
        catch B2Error.notFound { return }
        catch B2Error.http(let status, let code, _) where status == 404 || code == "NoSuchKey" { return }
        try await deleteVersion(key: key, fileID: "")
    }

    /// Trash lives at `.ghost-trash/yyyyMMdd/<original key>`; anything whose date folder is older than `days` is deleted.
    public func purgeTrash(olderThanDays days: Int) async throws -> Int {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd"; f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        guard let cutoff = Calendar(identifier: .gregorian).date(byAdding: .day, value: -days, to: Date()) else { return 0 }
        let cutoffStamp = f.string(from: cutoff)
        var deleted = 0
        var token: String? = nil
        repeat {
            let page = try await listPage(prefix: ghostTrashPrefix, delimiter: false, token: token)
            for o in page.objects {
                let parts = o.key.dropFirst(ghostTrashPrefix.count).split(separator: "/", maxSplits: 1)
                guard let day = parts.first, day.count == 8, day.allSatisfy(\.isNumber), String(day) < cutoffStamp else { continue }
                _ = try? await send(makeRequest(method: "DELETE", key: o.key), allow404: true)
                deleted += 1
            }
            token = page.truncated ? page.nextToken : nil
        } while token != nil
        return deleted
    }

    public func deleteVersion(key: String, fileID: String) async throws {
        _ = try await send(makeRequest(method: "DELETE", key: key), allow404: true)
    }

    public func copy(from: RemoteObject, to key: String) async throws {
        let source = "/" + Self.encode(cfg.bucket) + "/" + Self.encode(from.name, keepSlash: true)
        _ = try await send(makeRequest(method: "PUT", key: key, extra: ["x-amz-copy-source": source]))
    }

    public func configureTrashLifecycle(days: Int) async throws {
        let xml = "<LifecycleConfiguration><Rule><ID>ghost-trash</ID><Filter><Prefix>\(ghostTrashPrefix)</Prefix></Filter><Status>Enabled</Status><Expiration><Days>\(days)</Days></Expiration></Rule></LifecycleConfiguration>"
        let body = Data(xml.utf8)
        let md5 = Data(Insecure.MD5.hash(data: body)).base64EncodedString()
        var req = makeRequest(method: "PUT", key: nil, query: [("lifecycle", "")], extra: ["content-md5": md5], payloadHash: SHA256.hash(data: body).hex)
        req.setValue("application/xml", forHTTPHeaderField: "Content-Type")
        try await send(req, body: body)
    }

    // MARK: Share links (presigned GET)

    public func shareURL(key: String, validFor seconds: Int) async throws -> URL {
        let now = Date(), stamp = Self.amzDate(now), day = String(stamp.prefix(8))
        let scope = "\(day)/\(cfg.region)/s3/aws4_request"
        let q: [(String, String)] = [
            ("X-Amz-Algorithm", "AWS4-HMAC-SHA256"), ("X-Amz-Credential", "\(cfg.accessKey)/\(scope)"), ("X-Amz-Date", stamp),
            ("X-Amz-Expires", String(min(max(seconds, 1), maxShareSeconds))), ("X-Amz-SignedHeaders", "host"),
        ]
        let p = path(for: key)
        let sig = Self.sign(method: "GET", path: p, query: q, headers: ["host": hostHeader], payloadHash: "UNSIGNED-PAYLOAD",
                            date: now, region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey)
        var comps = URLComponents()
        comps.scheme = cfg.endpoint.scheme; comps.host = cfg.endpoint.host; comps.port = cfg.endpoint.port
        comps.percentEncodedPath = p
        comps.percentEncodedQuery = (q.map { "\(Self.encode($0.0))=\(Self.encode($0.1))" } + ["X-Amz-Signature=\(sig.signature)"]).joined(separator: "&")
        guard let url = comps.url else { throw B2Error.badResponse("presign") }
        return url
    }
}

extension Sequence where Element == UInt8 {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
extension Digest { var hex: String { map { String(format: "%02x", $0) }.joined() } }
