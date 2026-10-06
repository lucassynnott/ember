import Foundation
import DriveCore

// Usage: drivectl <ls|put|get|read|rm|trash> ...
// Credentials come from env: B2_KEY_ID, B2_APP_KEY, B2_BUCKET (run via `op run`).

func env(_ k: String) -> String {
    guard let v = ProcessInfo.processInfo.environment[k], !v.isEmpty else {
        FileHandle.standardError.write(Data("missing env \(k)\n".utf8)); exit(2)
    }
    return v
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { print("usage: drivectl ls [prefix] | put <file> <key> | read <key> <offset> <len> | rm <key> | trash"); exit(1) }

// B2_S3=1 exercises the S3-compatible client against Backblaze's S3 endpoint (same key), to test the S3 code path for real.
// GHOST_PROVIDER=r2|s3|wasabi|custom builds the client exactly the way the app does (SharedConfig.makeStore), from env.
func storeFromEnvironment() -> (any ObjectStore)? {
    let e = ProcessInfo.processInfo.environment
    guard let raw = e["GHOST_PROVIDER"], let p = StorageProvider(rawValue: raw) else { return nil }
    var c = SharedConfig(provider: p, keyID: env("B2_KEY_ID"), applicationKey: env("B2_APP_KEY"), bucketName: env("B2_BUCKET"))
    c.accountID = e["GHOST_ACCOUNT"] ?? ""; c.region = e["GHOST_REGION"] ?? ""; c.endpoint = e["GHOST_ENDPOINT"] ?? ""
    return c.makeStore()
}
let client: any ObjectStore = storeFromEnvironment() ?? (ProcessInfo.processInfo.environment["B2_S3"] == "1"
    ? S3Client(config: S3Config(endpoint: URL(string: "https://s3.us-east-005.backblazeb2.com")!, region: "us-east-005",
                                accessKey: env("B2_KEY_ID"), secretKey: env("B2_APP_KEY"), bucket: env("B2_BUCKET")))
    : B2Client(credentials: B2Credentials(keyID: env("B2_KEY_ID"), applicationKey: env("B2_APP_KEY"), bucketName: env("B2_BUCKET"))))

do {
    switch cmd {
    case "ls":
        for o in try await client.list(prefix: args.count > 1 ? args[1] : "") {
            print(o.kind == .folder ? "d" : "-", o.size, o.name)
        }
    case "put":
        let t = Date()
        try await client.upload(file: URL(fileURLWithPath: args[1]), as: args[2], mtime: nil, progress: nil)
        print("uploaded in \(String(format: "%.2f", Date().timeIntervalSince(t)))s")
    case "read":
        let t = Date()
        let d = try await client.read(key: args[1], offset: Int64(args[2])!, length: Int(args[3])!)
        print("read \(d.count) bytes in \(String(format: "%.3f", Date().timeIntervalSince(t)))s")
    case "verify":
        // verify [provider] [key] [secret] [bucket] [endpoint] : runs the same checker the Settings panel uses
        var cfg = SharedConfig(provider: StorageProvider(rawValue: args.count > 1 ? args[1] : "b2") ?? .b2,
                               keyID: args.count > 2 ? args[2] : env("B2_KEY_ID"), applicationKey: args.count > 3 ? args[3] : env("B2_APP_KEY"),
                               bucketName: args.count > 4 ? args[4] : env("B2_BUCKET"))
        if cfg.provider == .r2, args.count > 5 { cfg.accountID = args[5] }
        else if args.count > 5 { cfg.endpoint = args[5]; cfg.region = args.count > 6 ? args[6] : "" }
        final class Box: @unchecked Sendable { var checks = StorageVerifier.initialChecks() }
        let box = Box()
        let ok = await StorageVerifier.run(config: cfg) { box.checks = $0 }
        for c in box.checks { print(c.state, "|", c.title, c.detail.isEmpty ? "" : "→ \(c.detail)") }
        print(ok ? "RESULT: all required checks passed" : "RESULT: FAILED")
    case "mp":
        // multipart upload test: upload a large local file, then verify size and a ranged read at the tail
        let f = URL(fileURLWithPath: args[1]); let size = ((try FileManager.default.attributesOfItem(atPath: f.path)[.size]) as? NSNumber)?.int64Value ?? 0
        let t = Date(); try await client.upload(file: f, as: args[2], mtime: nil, progress: nil)
        print(String(format: "uploaded %lld bytes in %.1fs", size, Date().timeIntervalSince(t)))
        let o = try await client.stat(key: args[2]); print("remote size:", o?.size ?? -1, o?.size == size ? "MATCH" : "MISMATCH")
        do {
            let tail = try await client.read(key: args[2], offset: size - 1000, length: 1000)
            let local = try FileHandle(forReadingFrom: f); try local.seek(toOffset: UInt64(size - 1000)); let want = try local.read(upToCount: 1000) ?? Data()
            print("tail bytes", tail == want ? "MATCH" : "MISMATCH")
        } catch { print("tail read skipped:", error) }
    case "purge":
        let n = try await client.purgeTrash(olderThanDays: args.count > 1 ? Int(args[1]) ?? 30 : 30); print("purged \(n) trashed object(s)")
    case "wipe":
        // Test cleanup: delete every object (including trash) so a throwaway bucket can be removed.
        let trash = try await client.purgeTrash(olderThanDays: -1)
        var n = 0
        for o in try await client.listAll(prefix: "") { try await client.deleteVersion(key: o.name, fileID: o.fileID ?? ""); n += 1 }
        print("wiped \(n) objects + \(trash) trashed")
    case "trashrm":
        try await client.hide(key: args[1]); print("hidden/trashed")
    case "listall":
        for o in try await client.listAll(prefix: args.count > 1 ? args[1] : "") { print(o.kind == .folder ? "d" : "-", o.size, o.name) }
    case "rm":
        if let o = try await client.stat(key: args[1]), let id = o.fileID { try await client.deleteVersion(key: o.name, fileID: id); print("deleted") }
        else { print("not found") }
    case "bench":
        let key = args[1]
        _ = try await client.read(key: key, offset: 0, length: 1) // warm auth + connection
        for (off, len) in [(0, 65536), (5_000_000, 65536), (10_000_000, 1_048_576), (12_000_000, 4_194_304), (0, 8_388_608)] {
            let t = Date()
            let d = try await client.read(key: key, offset: Int64(off), length: len)
            print("read \(len/1024)KB @\(off): \(d.count) bytes in \(String(format: "%.3f", Date().timeIntervalSince(t)))s")
        }
    case "stream":
        // Sequential read through ChunkReader, as a media player would (1MB reads). Cold cache each run.
        let key = args[1]
        guard let o = try await client.stat(key: key) else { print("not found"); exit(1) }
        let cache = FileManager.default.temporaryDirectory.appendingPathComponent("ghost-bench-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: cache) }
        let reader = ChunkReader(client: client, cacheDir: cache)
        let id = ChunkReader.identity(key: key, size: o.size, mtime: o.modified)
        let tw = Date(); await client.warmUp(connections: 6)
        print(String(format: "warm-up: %.2fs", Date().timeIntervalSince(tw)))
        let t0 = Date(); var off: Int64 = 0; var first = true
        while off < o.size {
            let d = try await reader.read(key: key, identity: id, size: o.size, offset: off, length: 1_048_576)
            if first { print(String(format: "first 1MB after %.3fs", Date().timeIntervalSince(t0))); first = false }
            off += Int64(d.count); if d.isEmpty { break }
        }
        let dt = Date().timeIntervalSince(t0)
        print(String(format: "streamed %lld bytes in %.2fs = %.1f MB/s", off, dt, Double(off) / dt / 1e6))
        // warm re-read
        let t1 = Date(); _ = try await reader.read(key: key, identity: id, size: o.size, offset: 0, length: 1_048_576)
        print(String(format: "warm re-read of first 1MB: %.4fs", Date().timeIntervalSince(t1)))
    case "share":
        let url = try await client.shareURL(key: args[1], validFor: 3600)
        print(url.absoluteString)
    case "pintest":
        // Pin a file, then read it back through a client with BROKEN credentials to prove it works with no network.
        let key = args[1]
        guard let o = try await client.stat(key: key) else { print("not found"); exit(1) }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("ghost-pintest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let ident = ChunkReader.identity(key: key, size: o.size, mtime: o.modified)
        let online = ChunkReader(client: client, cacheDir: base.appendingPathComponent("cache"), pinnedDir: base.appendingPathComponent("pinned"))
        let t = Date(); let fetched = try await online.pin(key: key, identity: ident, size: o.size)
        print(String(format: "pinned %lld bytes in %.1fs; isPinned=%@", fetched, Date().timeIntervalSince(t), String(await online.isPinned(identity: ident, size: o.size))))
        let dead = B2Client(credentials: B2Credentials(keyID: "000000000000", applicationKey: "invalid", bucketName: "nope"))
        let offline = ChunkReader(client: dead, cacheDir: base.appendingPathComponent("cache2"), pinnedDir: base.appendingPathComponent("pinned"))
        let d = try await offline.read(key: key, identity: ident, size: o.size, offset: 5_000_000, length: 1_000_000)
        print("offline read via pinned store:", d.count, "bytes")
    case "trash":
        try await client.configureTrashLifecycle(days: 30); print("30-day trash lifecycle set")
    default: print("unknown command"); exit(1)
    }
} catch { print("error:", error); exit(1) }
