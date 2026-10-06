import Foundation
import DriveCore

/// Appends one-line diagnostics to app-status.txt in the shared container (system logs aren't readable from this process).
enum DiagnosticsLog {
    static func append(_ line: String) {
        guard let dir = SharedPaths.appGroupPaths()?.root else { return }
        let url = dir.appendingPathComponent("app-status.txt")
        let text = "\(Date()) \(line)\n"
        if let h = try? FileHandle(forWritingTo: url) { defer { try? h.close() }; _ = try? h.seekToEnd(); try? h.write(contentsOf: Data(text.utf8)) }
        else { try? text.write(to: url, atomically: true, encoding: .utf8) }
    }
}
