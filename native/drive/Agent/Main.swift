import AppKit
import Foundation
import DriveCore
import notify

/// Ember Drive's helper. Ember starts it with `--ember` and talks to it over stdin/stdout, one JSON object per line:
/// requests are {"id", "cmd", ...}, replies {"id", "ok", "result"} or {"id", "ok": false, "error"}, and unasked
/// updates {"event", ...}. macOS also starts it on its own for the Finder right-click actions.
@main
enum Main {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AgentDelegate()
        app.delegate = delegate
        app.run()
    }
}

final class AgentDelegate: NSObject, NSApplicationDelegate {
    private let services = ServiceHandler()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.servicesProvider = services
        NSUpdateDynamicServices()
        Task { @MainActor in
            Drive.shared.onChange = { Channel.shared.event("status", Drive.shared.status()) }
            Pins.shared.onChange = { Channel.shared.event("status", Drive.shared.status()) }
            Pins.shared.start()
            TrashPurge.start()
            // Mounts on launch, like a normal drive; a moment lets the extension settle after login, and a mount
            // that fails then (FSKit still starting, an old extension still stopping) is tried again.
            try? await Task.sleep(for: .seconds(1.5))
            for attempt in 0..<4 where Env.shared.config != nil && !Drive.shared.mounted {
                if attempt > 0 { DiagnosticsLog.append("mount attempt \(attempt) didn't take: \(Drive.shared.message ?? "no message")") }
                Drive.shared.mount()
                try? await Task.sleep(for: .seconds(Double(4 + attempt * 4)))
            }
            Channel.shared.event("status", Drive.shared.status())
        }
        if CommandLine.arguments.contains("--ember") { Channel.shared.startStdio() } else { Channel.shared.listen() }
        // `notifyutil -p com.local.meetingnotes.drive.search` opens search in Ember (scripting, Shortcuts).
        var token: Int32 = 0
        notify_register_dispatch("com.local.meetingnotes.drive.search", &token, .main) { _ in Channel.shared.event("openSearch", [:]) }
        // Polls what the extension changes on its own (uploads, notices, mount state) and tells Ember when it moves.
        var last = ""
        var ticks = 0
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor in
                // Switched off in macOS: once it's switched on in System Settings, the drive mounts by itself.
                ticks += 1
                if ticks % 8 == 0, Drive.shared.needsEnable, !Drive.shared.mounted { Drive.shared.retryMount() }
                let status = Drive.shared.status()
                let text = (try? JSONSerialization.data(withJSONObject: status, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? ""
                if text != last { last = text; Channel.shared.event("status", status) }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

/// The line-based JSON channel to Ember. Ember opens the helper as its own app (so macOS treats it as itself, which
/// its shared settings folder needs) and connects to a local socket; `--ember` uses stdin/stdout instead, for tests.
final class Channel: @unchecked Sendable {
    static let shared = Channel()
    static var socketPath: String { NSHomeDirectory() + "/Library/Application Support/Ember Drive/ember.sock" }
    private let lock = NSLock()
    private var stdio = false
    private var client: Int32 = -1

    var connected: Bool { lock.lock(); defer { lock.unlock() }; return stdio || client >= 0 }

    func startStdio() {
        stdio = true
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) { self.dispatch(line) }
            exit(0)
        }
    }

    /// Listens for Ember on a socket only this user can open. One Ember at a time; a new connection replaces the old.
    func listen() {
        let path = Self.socketPath
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        unlink(path)
        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        guard server >= 0 else { return }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutablePointer(to: &address.sun_path) { $0.withMemoryRebound(to: CChar.self, capacity: 104) { strncpy($0, path, 103) } }
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0 else { DiagnosticsLog.append("couldn't open the socket: \(errno)"); return }
        chmod(path, 0o600)
        Darwin.listen(server, 4)
        Thread.detachNewThread {
            while true {
                let connection = accept(server, nil, nil)
                guard connection >= 0 else { continue }
                var on: Int32 = 1
                setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
                self.attach(connection)
            }
        }
    }

    private func attach(_ connection: Int32) {
        lock.lock()
        if client >= 0 { close(client) }
        client = connection
        lock.unlock()
        Task { @MainActor in self.event("status", Drive.shared.status()) }
        Thread.detachNewThread {
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 65536)
            while true {
                let count = read(connection, &buffer, buffer.count)
                if count <= 0 { break }
                pending.append(buffer, count: count)
                while let newline = pending.firstIndex(of: 0x0a) {
                    let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
                    pending.removeSubrange(pending.startIndex...newline)
                    self.dispatch(line)
                }
            }
            self.lock.lock()
            if self.client == connection { self.client = -1 }
            self.lock.unlock()
            close(connection)
        }
    }

    private func dispatch(_ line: String) {
        guard let data = line.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        Task { @MainActor in await self.handle(message) }
    }

    func event(_ name: String, _ payload: [String: Any]) { write(["event": name, "data": payload]) }

    private func reply(_ id: Any?, _ result: Any?) { write(["id": id ?? NSNull(), "ok": true, "result": result ?? NSNull()]) }
    private func fail(_ id: Any?, _ error: String) { write(["id": id ?? NSNull(), "ok": false, "error": error]) }

    private func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let line = data + Data([0x0a])
        lock.lock(); defer { lock.unlock() }
        if stdio { FileHandle.standardOutput.write(line); return }
        guard client >= 0 else { return }
        line.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let sent = Darwin.write(client, bytes.baseAddress! + offset, bytes.count - offset)
                if sent <= 0 { break }
                offset += sent
            }
        }
    }

    private func config(_ raw: Any?) -> SharedConfig? {
        guard let raw = raw as? [String: Any] else { return nil }
        let provider = StorageProvider(rawValue: raw["provider"] as? String ?? "") ?? .b2
        // A blank secret keeps the saved one, so the form never has to hold it.
        var secret = raw["applicationKey"] as? String ?? ""
        if secret.isEmpty, let saved = Env.shared.config, saved.provider == provider { secret = saved.applicationKey }
        var c = SharedConfig(provider: provider, keyID: raw["keyID"] as? String ?? "", applicationKey: secret, bucketName: raw["bucketName"] as? String ?? "")
        c.accountID = raw["accountID"] as? String ?? ""
        c.region = raw["region"] as? String ?? ""
        c.endpoint = raw["endpoint"] as? String ?? ""
        c.cacheLimitGB = raw["cacheLimitGB"] as? Int ?? Env.shared.config?.cacheLimitGB ?? 20
        return c
    }

    @MainActor
    private func handle(_ m: [String: Any]) async {
        let id = m["id"]
        let drive = Drive.shared
        switch m["cmd"] as? String ?? "" {
        case "status": reply(id, drive.status())
        case "identity":
            // Ember checks it's talking to its own copy of the helper (after an update, the old one is replaced).
            let exe = Bundle.main.executablePath ?? ""
            let modified = (try? FileManager.default.attributesOfItem(atPath: exe)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            reply(id, ["path": Bundle.main.bundlePath, "modified": modified])
        case "diagnose":
            // What the helper can reach in its settings folder (for support).
            let root = Env.shared.paths?.root
            var report: [String: Any] = ["root": root?.path as Any]
            for name in ["config.json", "listings.json", "pins.json"] {
                guard let url = root?.appendingPathComponent(name) else { continue }
                do { _ = try Data(contentsOf: url); report[name] = "ok" } catch { report[name] = (error as NSError).underlyingErrors.first.map { "\($0)" } ?? "\(error)" }
            }
            report["listing"] = (try? FileManager.default.contentsOfDirectory(atPath: root?.path ?? "").count) as Any
            reply(id, report)
        case "quit":
            reply(id, true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
        case "settings": reply(id, drive.settings())
        case "test":
            guard let c = config(m["config"]) else { return fail(id, "Missing settings.") }
            let ok = await drive.test(c) { checks in
                self.event("test", ["checks": checks.map { ["id": $0.id, "title": $0.title, "state": "\($0.state)", "detail": $0.detail] }])
            }
            reply(id, ok)
        case "save":
            guard let c = config(m["config"]) else { return fail(id, "Missing settings.") }
            do { try drive.save(c); reply(id, true) } catch { fail(id, error.localizedDescription) }
        case "forget": drive.forget(); reply(id, true)
        case "mount": drive.mount(); reply(id, true)
        case "unmount": drive.unmount(); reply(id, true)
        case "open": drive.openInFinder(); reply(id, true)
        case "sidebar": drive.setUpSidebar { result in self.reply(id, ["error": result as Any]) }
        case "pin": Pins.shared.pin(m["keys"] as? [String] ?? []); reply(id, true)
        case "unpin": Pins.shared.unpin(m["keys"] as? [String] ?? []); reply(id, true)
        case "sync": Pins.shared.sync(); reply(id, true)
        case "search":
            await SearchIndex.shared.refresh()
            reply(id, ["hits": SearchIndex.shared.search(m["query"] as? String ?? ""), "count": SearchIndex.shared.count])
        case "share":
            do { reply(id, try await drive.shareLink(key: m["key"] as? String ?? "")) } catch { fail(id, "\(error)") }
        case "reveal": drive.reveal(key: m["key"] as? String ?? ""); reply(id, true)
        case "cache": reply(id, ["bytes": drive.cacheBytes(), "pinnedBytes": Pins.shared.pinnedBytes, "limitGB": Env.shared.config?.cacheLimitGB ?? 20])
        case "cacheLimit": drive.setCacheLimit(m["gb"] as? Int ?? 20); reply(id, true)
        case "clearCache": drive.clearCache(); reply(id, true)
        case "put":
            do { try drive.put(file: URL(fileURLWithPath: m["file"] as? String ?? ""), as: m["key"] as? String ?? ""); reply(id, true) } catch { fail(id, error.localizedDescription) }
        case "migrate":
            do {
                let moved = try Migration.importFromGhost()
                if moved { drive.reconnect() }
                reply(id, moved)
            } catch { fail(id, error.localizedDescription) }
        case "purge": TrashPurge.run(); reply(id, true)
        case "enable": reply(id, ["error": await drive.enable() as Any])
        default: fail(id, "Unknown command.")
        }
    }
}
