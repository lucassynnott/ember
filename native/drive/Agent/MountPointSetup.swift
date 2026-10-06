import Foundation

/// Finder's sidebar only lists volumes mounted under /Volumes, and macOS deletes empty folders there at boot while
/// normal users can't create them. A tiny LaunchDaemon (installed once, with an admin prompt) recreates
/// /Volumes/Ember Drive owned by the user whenever /Volumes changes, so Ember Drive can mount there without any privileges.
enum MountPointSetup {
    static let volumesURL = URL(fileURLWithPath: "/Volumes/Ember Drive", isDirectory: true)
    static let homeURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Ember Drive", isDirectory: true)
    static let label = "com.local.meetingnotes.drive.volumes"

    static var isReady: Bool {
        var st = stat()
        guard stat(volumesURL.path, &st) == 0 else { return false }
        return st.st_uid == getuid()
    }

    /// Returns nil on success, or an error message.
    static func install() -> String? {
        let uid = getuid()
        let check = "mkdir -p '/Volumes/Ember Drive'; chown \(uid):20 '/Volumes/Ember Drive'; chmod 755 '/Volumes/Ember Drive'"
        let body = "if ! /sbin/mount | /usr/bin/grep -q ' on /Volumes/Ember Drive '; then \(check); fi"
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
          <key>Label</key><string>\(label)</string>
          <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>\(body)</string></array>
          <key>RunAtLoad</key><true/>
          <key>WatchPaths</key><array><string>/Volumes</string></array>
          <key>ThrottleInterval</key><integer>3</integer>
        </dict></plist>
        """
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ember-drive-setup-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let plistFile = tmp.appendingPathComponent("\(label).plist"), script = tmp.appendingPathComponent("setup.sh")
        let sh = """
        #!/bin/sh
        set -e
        install -m 644 -o root -g wheel '\(plistFile.path)' /Library/LaunchDaemons/\(label).plist
        /bin/launchctl bootout system/\(label) 2>/dev/null || true
        /bin/launchctl bootstrap system /Library/LaunchDaemons/\(label).plist
        \(body)
        """
        do {
            try plist.write(to: plistFile, atomically: true, encoding: .utf8)
            try sh.write(to: script, atomically: true, encoding: .utf8)
        } catch { return "\(error)" }
        let apple = "do shell script \"/bin/sh '\(script.path)'\" with administrator privileges with prompt \"Ember needs to add Ember Drive to the Finder sidebar (one time).\""
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript"); p.arguments = ["-e", apple]
        let pipe = Pipe(); p.standardError = pipe; p.standardOutput = pipe
        do { try p.run() } catch { return "\(error)" }
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            return out.contains("-128") ? "Cancelled" : out.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }
}
