import Foundation

/// The "File System Extensions" switch in System Settings silently refuses to enable third-party modules on some
/// setups. FSKit's real source of truth is a plist in its settings group container, so Ember Drive adds itself there.
/// FSKit only re-reads it when fskit_agent restarts, and restarting it drops every FSKit drive that's mounted, so
/// that only happens when no other FSKit drive is in use.
enum FSKitEnablement {
    static let moduleID = "com.local.meetingnotes.drive.fs"

    private static var plistURL: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist")
    }

    static func isEnabled() -> Bool {
        (NSArray(contentsOf: plistURL) as? [String])?.contains(moduleID) ?? false
    }

    /// Another app's FSKit drive that's mounted: what it is, where it's from, and where it sits.
    struct Mount { let type: String; let from: String; let on: String }

    static func otherMounts() -> [Mount] {
        var list: UnsafeMutablePointer<statfs>?
        let count = getmntinfo(&list, MNT_NOWAIT)
        guard count > 0, let list else { return [] }
        var mounts: [Mount] = []
        for i in 0..<Int(count) {
            var entry = list[i]
            let type = withUnsafePointer(to: &entry.f_fstypename) { $0.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) } }
            let from = withUnsafePointer(to: &entry.f_mntfromname) { $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) } }
            let on = withUnsafePointer(to: &entry.f_mntonname) { $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) } }
            // FSKit drives mount from a URL; the system's own disks mount from /dev.
            if type != "emberdrive", from.contains("://"), entry.f_owner == getuid() { mounts.append(Mount(type: type, from: from, on: on)) }
        }
        return mounts
    }

    /// Restarts the per-user fskit_agent so it re-reads its extensions. Disks (exFAT and the like) are served by the
    /// system's FSKit and stay mounted; app drives like Ghost run under this agent, so they're put back below.
    /// Restarts fskit_agent so it re-reads its extensions (after Ember Drive is enabled, or updated in place), then
    /// puts back any other FSKit drives the restart dropped, exactly where they were.
    @discardableResult
    static func restartAgent() -> Bool {
        let others = otherMounts()
        let restart = Process()
        restart.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        restart.arguments = ["-9", "-x", "fskit_agent"]
        try? restart.run(); restart.waitUntilExit()
        Thread.sleep(forTimeInterval: 2)
        // FSKit takes a moment to come back, so each drive is tried a few times; one that's still mounted is left alone.
        for m in others {
            var back = false
            for attempt in 0..<6 where !back {
                if attempt > 0 { Thread.sleep(forTimeInterval: 1.5) }
                if otherMounts().contains(where: { $0.on == m.on }) { back = true; break }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/sbin/mount")
                p.arguments = ["-F", "-t", m.type, m.from, m.on]
                p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
                try? p.run(); p.waitUntilExit()
                back = p.terminationStatus == 0
            }
            DiagnosticsLog.append("\(m.type) at \(m.on) after restarting fskit_agent: \(back ? "mounted" : "couldn't remount")")
        }
        return true
    }

    static let restartMessage = "Ember Drive is ready but macOS hasn't picked it up yet. Restart your Mac and it mounts."
    static let turnOnMessage = "Ember Drive is turned off in macOS. Turn it on in System Settings → General → Login Items & Extensions → File System Extensions."

    /// Makes sure FSKit has Ember Drive in its list of enabled drives (macOS drops it there after some updates).
    /// Reading the list can make macOS ask once whether Ember Drive may use data from other apps, so this runs off the
    /// main thread. With `force`, FSKit is restarted even if the list already has it, so it reads the list again.
    /// Returns nil when Ember Drive is (now) enabled, or a message saying what to do.
    static func ensureEnabled(force: Bool = false) -> String? {
        var list: [String] = []
        if FileManager.default.fileExists(atPath: plistURL.path) {
            do {
                let data = try Data(contentsOf: plistURL)
                list = (try PropertyListSerialization.propertyList(from: data, format: nil) as? [String]) ?? []
            } catch {
                DiagnosticsLog.append("can't read FSKit's list of enabled drives: \(error.localizedDescription)")
                elect()
                return force ? turnOnMessage : nil
            }
        }
        if list.contains(moduleID) {
            if force, !restartAgent() { return restartMessage }
            return nil
        }
        list.append(moduleID)
        do {
            let data = try PropertyListSerialization.data(fromPropertyList: list, format: .binary, options: 0)
            try data.write(to: plistURL, options: .atomic)
        } catch {
            DiagnosticsLog.append("can't add Ember Drive to FSKit's list: \(error.localizedDescription)")
            return turnOnMessage
        }
        DiagnosticsLog.append("added Ember Drive to FSKit's list of enabled drives")
        elect()
        return restartAgent() ? nil : restartMessage
    }

    private static func elect() {
        let enable = Process()
        enable.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
        enable.arguments = ["-e", "use", "-i", moduleID]
        try? enable.run(); enable.waitUntilExit()
    }
}
